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

// --- T3: account header ---------------------------------------------------
panel.renderPanel();
ck("account shows the display name", $("wp-name").textContent, "Guy Taieb");
ck("account shows the email underneath", $("wp-mail").textContent, "guy@korro.ai");
ck("avatar falls back to an initial", $("wp-avatar").textContent, "G");

// With no display name, the email becomes the primary line rather than being
// shown twice.
S.user = { uid: "u1", email: "matan@korro.ai", displayName: "", photoURL: "" };
panel.renderPanel();
ck("no display name: email is primary", $("wp-name").textContent, "matan@korro.ai");
ck("no display name: no duplicate line", $("wp-mail").textContent, "");
ck("initial comes from the email", $("wp-avatar").textContent, "M");

S.user = { uid: "u1", email: "guy@korro.ai", displayName: "Guy Taieb", photoURL: "https://example.test/p.png" };
panel.renderPanel();
ck("photo replaces the initial", $("wp-avatar").textContent, "");
ck("photo is applied", $("wp-avatar").style.backgroundImage.includes("p.png"), true);
S.user = { uid: "u1", email: "guy@korro.ai", displayName: "Guy Taieb", photoURL: "" };

// --- T4: workspaces accordion with boards ---------------------------------
await setup("admin");
panel.renderPanel();

const rows = () => document.querySelectorAll("#wp-workspaces .wp-ws");
ck("every workspace is listed", rows().length, 2);
ck("active workspace is expanded", rows()[0].classList.contains("active"), true);
ck("other workspace is collapsed", rows()[1].classList.contains("active"), false);
ck("active workspace shows its boards", document.querySelectorAll("#wp-workspaces .wp-board").length, 2);
ck("collapsed workspace shows none", rows()[1].querySelectorAll(".wp-board").length, 0);
ck("current board is marked",
   document.querySelector("#wp-workspaces .wp-board.current .wp-board-name").textContent, "Main");
ck("role chip on the row", rows()[0].querySelector(".wp-role").textContent.trim(), "admin");
ck("admin is offered New board", !!rows()[0].querySelector(".wp-newboard"), true);
ck("workspace name rendered", rows()[0].querySelector(".wp-ws-name").textContent, "Game Dev");

// Selection reports through callbacks; the view never calls the backend itself.
let selectedBoard = null, selectedWs = null;
panel.wirePanel({
  onSelectBoard: (ws, b) => { selectedBoard = [ws, b]; },
  onSelectWorkspace: (ws) => { selectedWs = ws; }
});
panel.renderPanel();

document.querySelectorAll("#wp-workspaces .wp-board")[1]
  .dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("clicking a board reports it", JSON.stringify(selectedBoard), JSON.stringify(["game-dev", "b2"]));

rows()[1].querySelector(".wp-ws-head").dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("clicking a workspace reports it", selectedWs, "product");

// Keyboard parity with gate.js
selectedWs = null;
rows()[1].querySelector(".wp-ws-head")
  .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
ck("Enter on a workspace reports it", selectedWs, "product");

// Per-board actions must not also trigger board selection.
let renamed = null, linked = null;
panel.wirePanel({
  onSelectBoard: (ws, b) => { selectedBoard = [ws, b]; },
  onRenameBoard: (id) => { renamed = id; },
  onCopyBoardLink: (id) => { linked = id; }
});
panel.renderPanel();
selectedBoard = null;
document.querySelector("#wp-workspaces [data-rename]")
  .dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("rename icon reports the board", renamed, "b1");
ck("rename icon does not also select the board", selectedBoard, null);
document.querySelector("#wp-workspaces [data-link]")
  .dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("link icon reports the board", linked, "b1");

// A viewer cannot create or rename boards.
await setup("viewer");
panel.renderPanel();
ck("viewer gets no New board", !!document.querySelector(".wp-newboard"), false);
ck("viewer gets no rename icons", document.querySelectorAll("#wp-workspaces [data-rename]").length, 0);
ck("viewer still gets copy-link icons", document.querySelectorAll("#wp-workspaces [data-link]").length > 0, true);
ck("viewer still sees every workspace", rows().length, 2);

rep("__DONE__");
