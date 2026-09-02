// ---------------------------------------------------------------------------
// UI test suite. Runs inside the real index.html, in place of src/main.js.
//
// The Firestore adapter is stubbed, so no auth, no network and no live project
// are involved — which is what makes the panel's behaviour testable at all.
// `backend` is a plain object export, so its methods can be replaced.
//
// Reports each assertion to run.mjs over HTTP. The final "__DONE__" matters:
// without it, a suite that throws half way through would look like a pass to
// anything that only counts failures.
// ---------------------------------------------------------------------------
const rep = (s) => { try { fetch("/report?m=" + encodeURIComponent(s)); } catch (_) {} };

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

function stubBackend() {
  backend.getRegistry = async () => ({
    name: (WORKSPACES.find((w) => w.wsId === backend.wsId) || {}).name || "",
    boards: BOARDS[backend.wsId] || []
  });
  backend.loadBoard = async () => ({
    data: { version: 1, settings: { viewMode: "week" }, groups: [], tasks: [] },
    updatedAt: 1
  });
  backend.saveBoard = async () => ({ updatedAt: 2 });
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

// ===========================================================================
// Suite
// ===========================================================================
await setup("admin");
ck("harness: workspace opened", S.ws.id, "game-dev");
ck("harness: board loaded", S.ws.boardId, "b1");
ck("harness: registry from the stub", S.registry.map((b) => b.name).join(","), "Main,1.58.0 Tasks");
ck("harness: role applied", S.role, "admin");
ck("harness: gate is open", S.gate, "open");

// --- T2: panel shell ------------------------------------------------------
const panel = await import("../../src/ui/panel.js");
panel.wirePanel({});

ck("panel starts closed", panel.isPanelOpen(), false);
panel.openPanel();
ck("panel opens", panel.isPanelOpen(), true);
ck("body gets .panel-open", document.body.classList.contains("panel-open"), true);
ck("panel is aria-hidden=false when open", $("ws-panel").getAttribute("aria-hidden"), "false");
// If the panel were an .overlay, uiBusy() in sync.js would treat it as an
// in-progress edit and suppress polling / refresh-on-activate the whole time
// it is open. A nav panel must not do that.
ck("panel is NOT an .overlay", $("ws-panel").classList.contains("overlay"), false);
ck("scrim is visible when open", $("ws-scrim").hidden, false);

panel.closePanel();
ck("panel closes", panel.isPanelOpen(), false);
ck("body loses .panel-open", document.body.classList.contains("panel-open"), false);

panel.openPanel();
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(40);
ck("Escape closes the panel", panel.isPanelOpen(), false);

panel.openPanel();
$("ws-scrim").dispatchEvent(new MouseEvent("click", { bubbles: true }));
await sleep(40);
ck("clicking the scrim closes the panel", panel.isPanelOpen(), false);

let signedOut = false;
panel.wirePanel({ onSignOut: () => { signedOut = true; } });
$("wp-signout").dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("sign out reports through the callback", signedOut, true);

rep("__DONE__");
