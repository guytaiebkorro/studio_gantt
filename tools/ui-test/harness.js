// ---------------------------------------------------------------------------
// UI test harness: reporting, fixtures, and the stubbed backend.
//
// Extracted from suite.js so that suite.js AND the per-workstream files under
// cases/ can share it without importing each other.
//
// That separation is load-bearing, not tidiness. suite.js ends with
// `await import("./cases/…")`, and this module uses top-level await. If a case
// file imported suite.js directly, its static import would wait on suite.js's
// EVALUATION PROMISE — which is itself suspended awaiting that very case file.
// Cycle plus top-level await is a deadlock, not a TDZ error: the page simply
// hangs, and the run times out with no failing assertion to point at. Importing
// this leaf module instead means there is no cycle to deadlock.
//
// The Firestore adapter is stubbed, so no auth, no network and no live project
// are involved — which is what makes the panel's behaviour testable at all.
// `backend` is a plain object export, so its methods can be replaced.
// ---------------------------------------------------------------------------
export const rep = (s) => { try { fetch("/report?m=" + encodeURIComponent(s)); } catch (_) {} };

export const ck = (name, got, want) => rep(
  (got === want ? "PASS " : "FAIL ") + name +
  (got === want ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
);
export const note = (s) => rep("INFO " + s);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const $ = (id) => document.getElementById(id);

window.onerror = (m, s, l) =>
  rep(`FAIL window.onerror: ${m} @${(s || "").split("/").pop()}:${l}`);
window.addEventListener("unhandledrejection", (e) =>
  rep("FAIL rejection: " + (e.reason && (e.reason.stack || e.reason.message || e.reason))));

const { S } = await import("../../src/state.js");
const { backend } = await import("../../src/backend/backend.js");
const { applyRole } = await import("../../src/permissions.js");
export { S };

// --- fixture ---------------------------------------------------------------
export const WORKSPACES = [
  { wsId: "game-dev", name: "Game Dev", role: "admin" },
  { wsId: "product",  name: "Product",  role: "admin" }
];
const BOARDS = {
  "game-dev": [{ id: "b1", name: "Main" }, { id: "b2", name: "1.58.0 Tasks" }],
  "product":  [{ id: "b3", name: "My Board" }]
};
export const MEMBERS = [
  { email: "guy@korro.ai",   role: "admin",  signedIn: true,  isProtected: true,
    displayName: "Guy Taieb", invitedBy: "cli" },
  { email: "matan@korro.ai", role: "editor", signedIn: false, isProtected: false,
    displayName: "",          invitedBy: "guy@korro.ai" }
];

// Every stubbed write is recorded so tests can assert intent rather than
// reaching for internals.
export const calls = [];

// The live listener's control surface, populated by stubBackend's watchBoard.
// `emit` pushes a snapshot into sync.js exactly as Firestore would; `active`
// tracks whether the unsubscribe has been called, which is how the teardown
// tests assert that stopWatching() really detached.
export const watch = { boardId: null, emit: null, fail: null, active: false };

function stubBackend() {
  backend.getRegistry = async () => ({
    name: (WORKSPACES.find((w) => w.wsId === backend.wsId) || {}).name || "",
    // A COPY, like the real adapter, which builds a fresh array from Firestore
    // on every read. Returning the fixture array itself aliased it into
    // S.registry, so newBoard()'s push mutated the fixture and later
    // assertions saw boards a previous test had created.
    boards: (BOARDS[backend.wsId] || []).map((b) => ({ ...b }))
  });
  backend.loadBoard = async () => ({
    data: { version: 1, settings: { viewMode: "week" }, groups: [], tasks: [] },
    updatedAt: 1
  });
  // Mirrors the real adapter's contract: the merge runs INSIDE the write, so the
  // stub calls `reconcile` too and returns what actually landed. Tests that want
  // to exercise a save-time conflict replace this with a version whose
  // reconcile() argument is a non-null remote (see cases/sync.js).
  backend.saveBoard = async (id, data, reconcile) => {
    calls.push(["saveBoard", id]);
    return { updatedAt: 2, state: data };
  };
  // Live listener. The stub hands the callbacks straight back through `watch` so
  // a test can push a snapshot synchronously instead of waiting on a network:
  //   watch.emit({ data, updatedAt }, { fromCache: false, hasPendingWrites: false })
  backend.watchBoard = (boardId, onChange, onError) => {
    watch.boardId = boardId;
    watch.emit = (board, meta) => onChange(board, meta || { fromCache: false, hasPendingWrites: false });
    watch.fail = (err) => onError && onError(err);
    watch.active = true;
    return () => { watch.active = false; watch.emit = null; watch.fail = null; };
  };
  backend.createBoardData = async (name) => { calls.push(["createBoardData", name]); return { id: "bnew" }; };
  backend.renameBoard = async (id, name) => { calls.push(["renameBoard", id, name]); };
  backend.putBoards = async (b) => { calls.push(["putBoards", b.map((x) => x.name).join(",")]); };
  backend.putWorkspaceName = async (n) => { calls.push(["putWorkspaceName", n]); };
}

// Put the app into "signed in, workspace open" without touching the network.
export async function setup(role = "admin") {
  stubBackend();
  calls.length = 0;
  S.user = { uid: "u1", email: "guy@korro.ai", displayName: "Guy Taieb", photoURL: "" };
  S.memberships = WORKSPACES.map((w) => ({ ...w, role }));
  applyRole(role);
  const { openWorkspace } = await import("../../src/boards.js");
  await openWorkspace("game-dev", { name: "Game Dev", role, boardId: "b1" });
}
