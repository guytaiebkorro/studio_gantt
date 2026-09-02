// ---------------------------------------------------------------------------
// Command implementations.
//
// Reminder throughout: the Admin SDK bypasses Security Rules. Nothing here is
// checked by firestore.rules, so every document this writes must match the shape
// the rules expect (see validate.js) or clients won't be able to read it.
// ---------------------------------------------------------------------------
import { db, FieldValue, resolveProjectId } from "./db.js";
import {
  ROLES, MEMBER_KEYS, normalizeEmail, validateRole, validateWorkspaceId,
  validateWorkspaceName, slugify, emptyBoard, serializeBoard
} from "./validate.js";

const CLI_ACTOR = "cli";

function wsRef(id) { return db().collection("workspaces").doc(id); }

async function requireWorkspace(id) {
  const snap = await wsRef(id).get();
  if (!snap.exists) throw new Error(`Workspace "${id}" does not exist. Try: gantt-admin workspace:list`);
  return snap;
}

// Build a member document with the EXACT key set the rules require. Nulls are
// explicit rather than omitted, because the rules use hasAll() — an absent field
// and a null field are the same thing to them, and being explicit here means a
// client's later self-update (uid/displayName/claimedAt) only ever CHANGES keys
// rather than adding them.
function memberDoc({ email, role, invitedBy, protectedFlag }) {
  const doc = {
    email,
    role,
    uid: null,
    displayName: null,
    invitedBy: invitedBy || CLI_ACTOR,
    invitedAt: FieldValue.serverTimestamp(),
    claimedAt: null,
    protected: !!protectedFlag
  };
  const keys = Object.keys(doc).sort().join(",");
  const want = [...MEMBER_KEYS].sort().join(",");
  if (keys !== want) throw new Error(`internal: member doc keys drifted from the rules contract\n${keys}\n${want}`);
  return doc;
}

function boardDoc({ name, board, actor }) {
  return {
    name,
    data: serializeBoard(board),
    updatedAt: Date.now(),                        // client-style ms; sync.js compares this
    updatedAtServer: FieldValue.serverTimestamp(),
    updatedBy: actor || CLI_ACTOR,
    rev: 0,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: actor || CLI_ACTOR,
    archived: false
  };
}

// --- workspace:create -------------------------------------------------------
export async function workspaceCreate({ name, admin, id }) {
  const wsName = validateWorkspaceName(name);
  const adminEmail = normalizeEmail(admin);
  const wsId = validateWorkspaceId(id || slugify(wsName) || "workspace");

  const existing = await wsRef(wsId).get();
  if (existing.exists) {
    throw new Error(`Workspace "${wsId}" already exists. Pass a different --id.`);
  }

  const boardRef = wsRef(wsId).collection("boards").doc();
  const batch = db().batch();

  batch.set(wsRef(wsId), {
    name: wsName,
    // The board index lives here, denormalized, so the toolbar dropdown costs
    // ONE read instead of downloading every board's task list. Byte-identical to
    // the shape the app's getRegistry()/putRegistry() already use.
    boards: [{ id: boardRef.id, name: "My Board" }],
    ownerEmail: adminEmail,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: CLI_ACTOR,
    schemaVersion: 1,
    archived: false
  });

  // The founding admin is `protected`: clients can never update or delete this
  // member document. That is what guarantees a workspace can never end up with
  // zero admins — rules cannot count, so two admins CAN concurrently demote each
  // other, and this is the backstop. Only this CLI can touch it.
  batch.set(
    wsRef(wsId).collection("members").doc(adminEmail),
    memberDoc({ email: adminEmail, role: "admin", invitedBy: CLI_ACTOR, protectedFlag: true })
  );

  batch.set(boardRef, boardDoc({ name: "My Board", board: emptyBoard() }));

  await batch.commit();

  return { wsId, wsName, adminEmail, boardId: boardRef.id };
}

// --- workspace:list ---------------------------------------------------------
export async function workspaceList() {
  const snap = await db().collection("workspaces").get();
  const rows = [];
  for (const d of snap.docs) {
    const w = d.data();
    const members = await d.ref.collection("members").get();
    const counts = { admin: 0, editor: 0, viewer: 0, unclaimed: 0 };
    members.forEach((m) => {
      const r = m.data().role;
      if (counts[r] !== undefined) counts[r]++;
      if (!m.data().uid) counts.unclaimed++;
    });
    rows.push({
      id: d.id,
      name: w.name || "(unnamed)",
      boards: Array.isArray(w.boards) ? w.boards.length : 0,
      ownerEmail: w.ownerEmail || "",
      members: members.size,
      counts
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// --- workspace:rename -------------------------------------------------------
export async function workspaceRename({ wsId, name }) {
  const id = validateWorkspaceId(wsId);
  const wsName = validateWorkspaceName(name);
  await requireWorkspace(id);
  await wsRef(id).update({ name: wsName });
  return { wsId: id, wsName };
}

// --- workspace:delete -------------------------------------------------------
export async function workspaceDelete({ wsId }) {
  const id = validateWorkspaceId(wsId);
  await requireWorkspace(id);
  // recursiveDelete, NOT a plain delete. Firestore has NO cascade delete:
  // removing the workspace document would leave its members and boards alive,
  // and worse, myRole() in the rules still resolves from those orphaned member
  // docs — so former members would keep read/write access to boards in a
  // workspace that appears deleted.
  await db().recursiveDelete(wsRef(id));
  return { wsId: id };
}

// --- member:list ------------------------------------------------------------
export async function memberList({ wsId }) {
  const id = validateWorkspaceId(wsId);
  await requireWorkspace(id);
  const snap = await wsRef(id).collection("members").get();
  return snap.docs.map((d) => {
    const m = d.data();
    return {
      email: d.id,
      role: m.role,
      claimed: !!m.uid,
      protected: !!m.protected,
      invitedBy: m.invitedBy || "",
      displayName: m.displayName || ""
    };
  }).sort((a, b) => (ROLES.indexOf(a.role) - ROLES.indexOf(b.role)) || a.email.localeCompare(b.email));
}

// --- member:add (== invite) -------------------------------------------------
export async function memberAdd({ wsId, email, role, protectedFlag }) {
  const id = validateWorkspaceId(wsId);
  const e = normalizeEmail(email);
  const r = validateRole(role);
  await requireWorkspace(id);

  const ref = wsRef(id).collection("members").doc(e);
  if ((await ref.get()).exists) {
    throw new Error(`${e} is already a member of "${id}". Use member:set-role to change their role.`);
  }
  await ref.set(memberDoc({ email: e, role: r, invitedBy: CLI_ACTOR, protectedFlag }));
  return { wsId: id, email: e, role: r, protected: !!protectedFlag };
}

// --- member:set-role --------------------------------------------------------
export async function memberSetRole({ wsId, email, role }) {
  const id = validateWorkspaceId(wsId);
  const e = normalizeEmail(email);
  const r = validateRole(role);
  await requireWorkspace(id);
  const ref = wsRef(id).collection("members").doc(e);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`${e} is not a member of "${id}". Use member:add.`);
  await ref.update({ role: r });
  return { wsId: id, email: e, role: r, was: snap.data().role };
}

// --- member:remove ----------------------------------------------------------
export async function memberRemove({ wsId, email }) {
  const id = validateWorkspaceId(wsId);
  const e = normalizeEmail(email);
  await requireWorkspace(id);
  const ref = wsRef(id).collection("members").doc(e);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`${e} is not a member of "${id}".`);

  // Refuse to strip the last admin. The rules already stop clients doing this,
  // but this CLI bypasses them, so the check has to exist here too.
  if (snap.data().role === "admin") {
    const admins = await wsRef(id).collection("members").where("role", "==", "admin").get();
    if (admins.size <= 1) {
      throw new Error(
        `${e} is the only admin of "${id}". Add another admin first, or nobody will be able to manage it.`
      );
    }
  }
  await ref.delete();
  return { wsId: id, email: e };
}

// --- board:list -------------------------------------------------------------
export async function boardList({ wsId }) {
  const id = validateWorkspaceId(wsId);
  const ws = await requireWorkspace(id);
  const registry = Array.isArray(ws.data().boards) ? ws.data().boards : [];
  const snap = await wsRef(id).collection("boards").get();

  const actual = new Map();
  snap.forEach((d) => {
    const b = d.data();
    let tasks = null, groups = null;
    try { const parsed = JSON.parse(b.data || "{}"); tasks = (parsed.tasks || []).length; groups = (parsed.groups || []).length; }
    catch (_) { /* leave null — reported as unreadable */ }
    // UTF-8 bytes, not string length. The size cap is in bytes, and any emoji
    // in a task name is 2 UTF-16 units but 4 UTF-8 bytes — so string length
    // under-reports exactly where it matters most.
    actual.set(d.id, {
      name: b.name,
      bytes: Buffer.byteLength(b.data || "", "utf8"),
      tasks, groups, archived: !!b.archived
    });
  });

  // Report drift between the denormalized index and the actual subcollection.
  // That drift is the one real cost of denormalizing, so surface it rather than
  // letting it rot silently.
  const inIndexOnly = registry.filter((r) => !actual.has(r.id)).map((r) => r.id);
  const inStoreOnly = [...actual.keys()].filter((k) => !registry.some((r) => r.id === k));

  return {
    boards: registry.map((r) => ({ id: r.id, indexName: r.name, ...(actual.get(r.id) || {}) })),
    orphans: { inIndexOnly, inStoreOnly }
  };
}

// --- board:export / board:import -------------------------------------------
export async function boardExport({ wsId, boardId }) {
  const id = validateWorkspaceId(wsId);
  await requireWorkspace(id);
  const snap = await wsRef(id).collection("boards").doc(boardId).get();
  if (!snap.exists) throw new Error(`Board "${boardId}" not found in "${id}".`);
  // Return the INNER board document, so the file is drop-in compatible with the
  // app's existing "Import JSON" button.
  return JSON.parse(snap.data().data);
}

export async function boardImport({ wsId, board, name }) {
  const id = validateWorkspaceId(wsId);
  const ws = await requireWorkspace(id);
  if (!board || !Array.isArray(board.tasks)) throw new Error("That file is not a board document (no tasks array).");
  const boardName = String(name || "Imported").trim().slice(0, 200) || "Imported";

  const ref = wsRef(id).collection("boards").doc();
  const registry = Array.isArray(ws.data().boards) ? ws.data().boards : [];
  const batch = db().batch();
  batch.set(ref, boardDoc({ name: boardName, board }));
  batch.update(wsRef(id), { boards: [...registry, { id: ref.id, name: boardName }] });
  await batch.commit();
  return { wsId: id, boardId: ref.id, name: boardName, tasks: board.tasks.length };
}

// --- doctor -----------------------------------------------------------------
export async function doctor() {
  const findings = [];
  const projectId = resolveProjectId();
  findings.push({ ok: true, msg: `project id: ${projectId}` });

  findings.push({
    ok: true,
    msg: "credentials: " + (process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? `service-account key at ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`
      : "Application Default Credentials (gcloud)")
  });

  // A trivial read proves credentials + project + API access all work.
  try {
    await db().collection("workspaces").limit(1).get();
    findings.push({ ok: true, msg: "Firestore reachable and credentials accepted" });
  } catch (err) {
    findings.push({ ok: false, msg: "Firestore read failed: " + err.message });
    return findings;
  }

  // The collection-group query the app runs on every sign-in. If the
  // COLLECTION_GROUP index on members.email is missing, this throws
  // FAILED_PRECONDITION here — much better than a real user hitting it and being
  // told they have no workspaces.
  try {
    await db().collectionGroup("members").where("email", "==", "doctor@example.com").limit(1).get();
    findings.push({ ok: true, msg: "members.email COLLECTION_GROUP index is present (membership query works)" });
  } catch (err) {
    findings.push({
      ok: false,
      msg: "membership collection-group query FAILED: " + err.message +
           "\n      Deploy it: firebase deploy --only firestore:indexes"
    });
  }

  // Per-workspace integrity.
  const all = await db().collection("workspaces").get();
  findings.push({ ok: true, msg: `workspaces: ${all.size}` });
  for (const d of all.docs) {
    const w = d.data();
    const members = await d.ref.collection("members").get();
    const admins = members.docs.filter((m) => m.data().role === "admin");
    const prot = members.docs.filter((m) => m.data().protected);

    if (!admins.length) findings.push({ ok: false, msg: `"${d.id}" has NO admin — nobody can manage it` });
    if (!prot.length) findings.push({ ok: false, msg: `"${d.id}" has no protected member — it could reach zero admins` });

    // Key-set drift would make member docs unreadable/unwritable by clients.
    for (const m of members.docs) {
      const keys = Object.keys(m.data()).sort().join(",");
      const want = [...MEMBER_KEYS].sort().join(",");
      if (keys !== want) findings.push({ ok: false, msg: `"${d.id}" member ${m.id} has wrong key set: ${keys}` });
    }

    const { orphans } = await boardList({ wsId: d.id });
    if (orphans.inIndexOnly.length) {
      findings.push({ ok: false, msg: `"${d.id}" index lists missing boards: ${orphans.inIndexOnly.join(", ")}` });
    }
    if (orphans.inStoreOnly.length) {
      findings.push({ ok: false, msg: `"${d.id}" has boards absent from its index: ${orphans.inStoreOnly.join(", ")}` });
    }
    if (Array.isArray(w.boards) && !w.boards.length) {
      findings.push({ ok: false, msg: `"${d.id}" has an empty board index` });
    }
  }
  return findings;
}
