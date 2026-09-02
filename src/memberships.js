// ---------------------------------------------------------------------------
// Who belongs where.
//
// Replaces src/workspaces.js, which kept a device-local list of workspaces
// keyed by a JSONBin Master Key held in plaintext in localStorage. Access now
// comes from the server: a member document under the workspace grants it, and
// localStorage holds nothing but a "which one was I last looking at" hint.
//
// THERE IS NO INVITE-CLAIM STEP. The member document IS the invite, keyed by
// lowercased email rather than uid, so someone can be added before they have
// ever signed in and they simply have access the first time they do. The only
// thing a client writes about itself is diagnostic (uid / displayName /
// claimedAt), which grants nothing — firestore.rules excludes `role` from that
// update, so it cannot be an escalation path.
//
// No DOM here and no writes to S; session.js owns both.
// ---------------------------------------------------------------------------
import {
  db, doc, collection, collectionGroup, query, where,
  getDoc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp
} from "./firebase/app.js";
import { currentUser } from "./auth.js";
import { LAST_KEY, LEGACY_KEYS } from "./config.js";

const ROLE_ORDER = { admin: 0, editor: 1, viewer: 2 };

function me() {
  const u = currentUser();
  if (!u || !u.email) throw Object.assign(new Error("Not signed in"), { code: "unauthenticated" });
  return u;
}

// --- discovery --------------------------------------------------------------

// Every workspace this user belongs to. ONE collection-group query, which is why
// `email` is duplicated as a field on the member document: a collection-group
// query cannot filter on a document id.
//
// Requires the COLLECTION_GROUP index on members.email. Without it Firestore
// throws failed-precondition, which would otherwise surface to a real user as
// the "you're not in any workspace" dead end — i.e. looking exactly like they
// were never invited. Callers must not swallow that.
export async function listMyWorkspaces() {
  const u = me();
  const snap = await getDocs(query(collectionGroup(db, "members"), where("email", "==", u.email)));
  const rows = snap.docs.map((d) => ({
    wsId: d.ref.parent.parent.id,   // /workspaces/{wsId}/members/{email}
    role: d.get("role") || "viewer",
    name: ""
  }));

  // The member document does not carry the workspace's name, so fetch each
  // workspace document for it. The localStorage cache is only a paint-first
  // optimization and is written when you OPEN a workspace — relying on it alone
  // meant any workspace you had never opened showed as "Workspace".
  //
  // Deliberately NOT denormalizing the name onto member documents: it would go
  // stale on every rename and need a repair path, and there is no trusted writer
  // for it. N is the number of workspaces one person belongs to — a handful of
  // small reads once per sign-in, against a 50k/day quota.
  //
  // allSettled, not all: one unreadable workspace (deleted, or access revoked
  // between the two queries) must not blank the entire list.
  const results = await Promise.allSettled(
    rows.map((r) => getDoc(doc(db, "workspaces", r.wsId)))
  );

  const names = {};
  results.forEach((res, i) => {
    const r = rows[i];
    if (res.status === "fulfilled" && res.value.exists()) {
      r.name = res.value.data().name || "";
      if (r.name) names[r.wsId] = r.name;
    }
    // Fall back to the cached name, then to the id. The id is a slug like
    // "game-dev", so it still identifies the workspace — far better than
    // showing several rows all labelled "Workspace".
    if (!r.name) r.name = cachedName(r.wsId) || r.wsId;
  });
  cacheNames(names);   // so the next sign-in paints instantly

  // Alphabetical on purpose, so rows don't reorder under the user as
  // last-used changes. Same reasoning as the old workspacesForDisplay().
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// My role in one workspace, or null if I'm not a member. Reads my own member
// document directly — a deterministic path, no index needed.
export async function getMyRole(wsId) {
  const u = me();
  const snap = await getDoc(doc(db, "workspaces", wsId, "members", u.email));
  return snap.exists() ? (snap.data().role || "viewer") : null;
}

// Record uid/displayName/claimedAt on my own member document, once per sign-in.
// Purely diagnostic: it is how you notice that someone's Google address changed
// (uid present, email no longer resolving). Best-effort — never block sign-in on
// it, and never surface a failure, because nothing depends on it.
export async function bindMyIdentity(wsId) {
  try {
    const u = me();
    await updateDoc(doc(db, "workspaces", wsId, "members", u.email), {
      uid: u.uid,
      displayName: u.displayName || null,
      claimedAt: serverTimestamp()
    });
  } catch (err) {
    if (err && err.code !== "permission-denied") console.warn("identity bind skipped:", err.code || err.message);
  }
}

// --- administration ---------------------------------------------------------
// All of these can reject with permission-denied. That is the rules doing their
// job, not a bug: the UI hides what you can't do, but the server decides.

export async function listMembers(wsId) {
  const snap = await getDocs(collection(db, "workspaces", wsId, "members"));
  return snap.docs
    .map((d) => {
      const m = d.data();
      return {
        email: d.id,
        role: m.role || "viewer",
        signedIn: !!m.uid,
        isProtected: !!m.protected,
        displayName: m.displayName || "",
        invitedBy: m.invitedBy || ""
      };
    })
    .sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.email.localeCompare(b.email));
}

// Invite == create the member document. The exact key set below is required by
// firestore.rules (hasOnly + hasAll), with nulls explicit rather than fields
// omitted, so a later self-update only ever CHANGES keys instead of adding them.
// invitedBy/invitedAt are pinned by the rules to the caller and request.time, so
// they cannot be forged.
export async function inviteMember(wsId, email, role) {
  const u = me();
  const addr = String(email || "").trim().toLowerCase();
  if (!addr) throw new Error("Enter an email address");
  await setDoc(doc(db, "workspaces", wsId, "members", addr), {
    email: addr,
    role,
    uid: null,
    displayName: null,
    invitedBy: u.email,
    invitedAt: serverTimestamp(),
    claimedAt: null,
    protected: false
  });
  return addr;
}

export async function setMemberRole(wsId, email, role) {
  await updateDoc(doc(db, "workspaces", wsId, "members", email), { role });
}

export async function removeMember(wsId, email) {
  await deleteDoc(doc(db, "workspaces", wsId, "members", email));
}

// Leave a workspace yourself. The rules allow deleting your own member document
// unless you're an admin — an admin leaving could strand the workspace, so that
// path goes through tools/admin instead.
export async function leaveWorkspace(wsId) {
  const u = me();
  await deleteDoc(doc(db, "workspaces", wsId, "members", u.email));
}

// --- device-local, non-secret ----------------------------------------------
// The ONLY thing kept on the device now: which workspace/board you were last
// looking at, plus a cached workspace name so the switcher can paint before the
// network answers. No credential is ever written here again.

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LAST_KEY) || "{}") || {}; } catch (_) { return {}; }
}
function writeLocal(obj) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(obj)); } catch (_) {}
}

export function lastWorkspace() { return readLocal().wsId || ""; }
export function lastBoardFor(wsId) { return (readLocal().boards || {})[wsId] || ""; }
export function cachedName(wsId) { return (readLocal().names || {})[wsId] || ""; }

export function rememberWorkspace(wsId, name) {
  const o = readLocal();
  o.wsId = wsId;
  if (name) { o.names = o.names || {}; o.names[wsId] = name; }
  writeLocal(o);
}
// Cache several workspace names at once, so the picker can paint from
// localStorage before the network answers on the next sign-in.
export function cacheNames(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return;
  const o = readLocal();
  o.names = o.names || {};
  for (const [wsId, name] of entries) o.names[wsId] = name;
  writeLocal(o);
}

export function rememberBoard(wsId, boardId) {
  const o = readLocal();
  o.boards = o.boards || {};
  o.boards[wsId] = boardId;
  writeLocal(o);
}

// Delete the pre-Firebase localStorage entries. These held JSONBin Master Keys
// in plaintext — account-wide credentials with no way to scope them. Leaving
// them behind in people's browsers is precisely the problem this migration
// exists to end, so scrub rather than migrate.
export function forgetLegacyKeys() {
  for (const k of LEGACY_KEYS) {
    try { localStorage.removeItem(k); } catch (_) {}
  }
}
