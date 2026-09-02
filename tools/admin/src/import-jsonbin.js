// ---------------------------------------------------------------------------
// One-time import from the old JSONBin backend.
//
// Reads a JSONBin account's registry bin and every board it lists, then writes
// them into a Firestore workspace. Node 18+ has global fetch, so this needs no
// HTTP dependency.
//
// SECURITY: the Master Key is an account-wide bearer credential that cannot be
// scoped or limited to read-only. It is taken as an argument and never written
// anywhere. ROTATE IT once the import is done — and note that anything typed on
// a command line lands in your shell history, so prefer --key-env.
// ---------------------------------------------------------------------------
import { db, FieldValue } from "./db.js";
import { normalize, diffReport } from "./normalize.js";
import { validateWorkspaceId, serializeBoard } from "./validate.js";

const JB = "https://api.jsonbin.io/v3";
const PAGE_CAP = 200;   // same cap the old app's discoverRegistryId() used

function headers(key) { return { "X-Master-Key": key, "Content-Type": "application/json" }; }

async function jb(key, path) {
  const res = await fetch(JB + path, { headers: headers(key) });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("JSONBin rejected the key (a MASTER key is required, not an Access Key)");
    }
    throw new Error(`JSONBin ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); } catch (_) { throw new Error("JSONBin returned non-JSON for " + path); }
}

// The old adapter identified its registry by CONTENT SHAPE, because JSONBin has
// no concept of a user or of named collections: it paged the account's bins and
// took the first whose record had a `boards` array. Ported as-is.
async function discoverRegistryId(key) {
  let last = "";
  let seen = 0;
  while (seen < PAGE_CAP) {
    const page = await jb(key, "/c/uncategorized/bins" + (last ? "/" + last : ""));
    if (!Array.isArray(page) || !page.length) return null;
    for (const b of page) {
      const id = b.record;
      if (!id) continue;
      seen++;
      try {
        const { record } = await jb(key, `/b/${id}/latest`);
        if (record && Array.isArray(record.boards)) return id;
      } catch (_) { /* unreadable bin — keep looking */ }
      last = id;
    }
    if (page.length < 10) return null;   // last page
  }
  return null;
}

// JSONBin stored boards as { updatedAt, data } but tolerated a legacy raw board.
// Same tolerance here, so nothing is silently skipped.
function unwrap(record) {
  if (record && typeof record === "object" && "data" in record) {
    return { data: record.data, updatedAt: Number(record.updatedAt) || 0 };
  }
  if (record && typeof record === "object" && Array.isArray(record.tasks)) {
    return { data: record, updatedAt: 0 };   // pre-wrapper board
  }
  return null;
}

export async function importJsonbin({ key, wsId, registryId, dryRun, replaceEmptyStarter }) {
  const target = validateWorkspaceId(wsId);
  const wsRef = db().collection("workspaces").doc(target);
  const wsSnap = await wsRef.get();
  if (!wsSnap.exists) throw new Error(`Workspace "${target}" does not exist. Create it first.`);

  const log = [];
  const say = (s) => { log.push(s); console.log(s); };

  let regId = registryId || null;
  if (!regId) {
    say("Finding the registry bin (by content shape, as the old app did)…");
    regId = await discoverRegistryId(key);
    if (!regId) throw new Error("Couldn't find a registry bin. Pass --registry <binId> explicitly.");
  }
  const { record: registry } = await jb(key, `/b/${regId}/latest`);
  if (!registry || !Array.isArray(registry.boards)) {
    throw new Error(`Bin ${regId} is not a registry (no boards array).`);
  }
  say(`Registry ${regId}: “${registry.name || "(unnamed)"}” with ${registry.boards.length} board(s).`);

  // Fetch and normalize everything BEFORE writing anything, so a bad bin can't
  // leave a half-imported workspace behind.
  const staged = [];
  for (const entry of registry.boards) {
    if (!entry || !entry.id) continue;
    let raw;
    try { raw = (await jb(key, `/b/${entry.id}/latest`)).record; }
    catch (err) { say(`  ! SKIPPED "${entry.name}" (${entry.id}): ${err.message}`); continue; }

    const u = unwrap(raw);
    if (!u) { say(`  ! SKIPPED "${entry.name}" (${entry.id}): unrecognised shape`); continue; }

    const before = JSON.parse(JSON.stringify(u.data || {}));
    const board = normalize(u.data);
    const json = serializeBoard(board);   // also enforces the 900 KB cap
    const notes = diffReport(before, board);

    staged.push({
      // Reuse the JSONBin bin id as the Firestore document id. They're 24-hex
      // ObjectIds, which are valid document ids, and reusing them keeps any
      // bookmarked board id resolving AND makes a re-run overwrite the same
      // documents instead of duplicating them.
      id: entry.id,
      name: String(entry.name || "Board").slice(0, 200),
      json,
      updatedAt: u.updatedAt || Date.now(),
      tasks: board.tasks.length,
      groups: board.groups.length,
      bytes: Buffer.byteLength(json, "utf8"),
      notes
    });
  }

  if (!staged.length) throw new Error("Nothing to import — no readable boards.");

  say("");
  say("Boards to import:");
  for (const b of staged) {
    say(`  ${b.id}  ${b.name.padEnd(24)} ${String(b.tasks).padStart(3)} tasks  ${String(b.groups).padStart(2)} groups  ${b.bytes} bytes`);
    for (const n of b.notes) say(`      repaired: ${n}`);
  }

  // The starter board a fresh workspace ships with is noise once real boards
  // arrive — and clients cannot delete boards, so leaving it would strand an
  // empty "My Board" permanently. Only remove it if it is genuinely untouched.
  const existing = Array.isArray(wsSnap.data().boards) ? wsSnap.data().boards : [];
  const toDrop = [];
  if (replaceEmptyStarter) {
    for (const e of existing) {
      const snap = await wsRef.collection("boards").doc(e.id).get();
      if (!snap.exists) continue;
      let empty = false;
      try {
        const d = JSON.parse(snap.data().data || "{}");
        empty = !(d.tasks || []).length && !(d.groups || []).length;
      } catch (_) { empty = false; }
      if (empty) toDrop.push({ id: e.id, name: e.name });
    }
    for (const d of toDrop) say(`  (will remove the empty starter board “${d.name}”)`);
  }

  const dropIds = new Set(toDrop.map((d) => d.id));
  const keep = existing.filter((e) => !dropIds.has(e.id) && !staged.some((s) => s.id === e.id));
  const index = [...keep, ...staged.map((b) => ({ id: b.id, name: b.name }))];

  say("");
  say(`Workspace "${target}" board index will become: ${index.map((b) => b.name).join(", ")}`);
  if (registry.name && registry.name !== wsSnap.data().name) {
    say(`Note: JSONBin called this workspace “${registry.name}”; keeping the Firestore name “${wsSnap.data().name}”.`);
  }

  if (dryRun) { say("\n--dry-run: nothing was written."); return { dryRun: true, staged, index }; }

  // One batch: either the whole import lands or none of it does. Well inside
  // Firestore's 500-operation limit at this scale.
  const batch = db().batch();
  for (const b of staged) {
    batch.set(wsRef.collection("boards").doc(b.id), {
      name: b.name,
      data: b.json,
      updatedAt: b.updatedAt,               // preserved from JSONBin
      updatedAtServer: FieldValue.serverTimestamp(),
      updatedBy: "cli:import",
      rev: 0,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: "cli:import",
      archived: false
    });
  }
  for (const d of toDrop) batch.delete(wsRef.collection("boards").doc(d.id));
  batch.update(wsRef, { boards: index });
  await batch.commit();

  say("");
  say(`Imported ${staged.length} board(s), ${staged.reduce((n, b) => n + b.tasks, 0)} tasks total.`);
  say("Now ROTATE that JSONBin Master Key — it is account-wide and cannot be scoped.");
  return { staged, index, dropped: toDrop };
}
