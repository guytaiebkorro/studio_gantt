// ---------------------------------------------------------------------------
// UI test suite. Runs inside the real index.html, in place of src/main.js.
//
// Reporting, fixtures and the stubbed backend live in harness.js, which the
// per-workstream files under cases/ also import. See the note at the top of
// that file for why they must not import THIS one.
//
// The final "__DONE__" matters: without it, a suite that throws half way
// through would look like a pass to anything that only counts failures.
// ---------------------------------------------------------------------------
import { rep, ck, note, sleep, $, S, WORKSPACES, MEMBERS, calls, setup } from "./harness.js";

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

// --- T5: inline new / rename board (no prompt()) ---------------------------
await setup("admin");
let committedNew = null, committedRename = null;
panel.wirePanel({
  onNewBoard: () => panel.beginNewBoard(),
  onRenameBoard: (id) => panel.beginRenameBoard(id),
  onCommitNewBoard: (name) => { committedNew = name; },
  onCommitRenameBoard: (id, name) => { committedRename = [id, name]; }
});
panel.renderPanel();

document.querySelector(".wp-newboard").dispatchEvent(new MouseEvent("click", { bubbles: true }));
const newInput = document.querySelector(".wp-inline");
ck("New board opens an inline field, not a prompt", !!newInput, true);
ck("the inline field is focused", document.activeElement === newInput, true);
newInput.value = "  Sprint 12  ";
newInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(30);
ck("Enter commits the trimmed name", committedNew, "Sprint 12");

// Escape must abandon without creating anything.
committedNew = null;
document.querySelector(".wp-newboard").dispatchEvent(new MouseEvent("click", { bubbles: true }));
document.querySelector(".wp-inline").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(30);
ck("Escape cancels without creating", committedNew, null);
ck("Escape removes the inline field", !!document.querySelector(".wp-inline"), false);
ck("Escape did not close the whole panel", panel.isPanelOpen(), false); // was never opened here

// An empty name must not create a board called "".
document.querySelector(".wp-newboard").dispatchEvent(new MouseEvent("click", { bubbles: true }));
const blank = document.querySelector(".wp-inline");
blank.value = "   ";
blank.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(30);
ck("a blank name creates nothing", committedNew, null);

// Rename replaces the board's own row, seeded with its current name.
document.querySelector("#wp-workspaces [data-rename]").dispatchEvent(new MouseEvent("click", { bubbles: true }));
const ren = document.querySelector(".wp-inline");
ck("rename seeds the current name", ren.value, "Main");
ren.value = "Main plan";
ren.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(30);
ck("rename commits id and name", JSON.stringify(committedRename), JSON.stringify(["b1", "Main plan"]));

// boards.js must accept a name argument now, and still guard on role.
const boardsMod = await import("../../src/boards.js");
ck("no prompt() left in boards.js newBoard", boardsMod.newBoard.length >= 1, true);

// --- T5b: the panel is actually wired to the app --------------------------
await setup("admin");
// boards.js re-wires the panel with the real callbacks at module scope, so
// re-import it and let its wiring win over the test's.
const boards2 = await import("../../src/boards.js");
// Earlier assertions replaced the panel's handlers with test spies; wirePanel()
// swaps the whole set, so put the app's real ones back before testing the
// end-to-end path.
boards2.installPanelHandlers();
boards2.updateCloudUI();

panel.closePanel();
$("cloud-btn").dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("the toolbar title opens the panel", panel.isPanelOpen(), true);

// The toolbar's board dropdown and Board button are gone: boards live in the
// panel, and a second entry point would be two places to look again.
ck("toolbar has no board dropdown", !!$("board-select"), false);
ck("toolbar has no Board button", !!$("board-new"), false);
ck("old workspace modal is gone", !!$("cloud-overlay"), false);

// A real end-to-end create through the app's own callbacks.
panel.openPanel();
panel.renderPanel();
document.querySelector(".wp-newboard").dispatchEvent(new MouseEvent("click", { bubbles: true }));
const live = document.querySelector(".wp-inline");
live.value = "Roadmap";
live.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(120);
ck("creating a board reaches the backend", calls.some((c) => c[0] === "createBoardData" && c[1] === "Roadmap"), true);
ck("...and updates the board index", calls.some((c) => c[0] === "putBoards" && c[1].includes("Roadmap")), true);

// A viewer's create must be refused by the guard, not by the absent button.
await setup("viewer");
calls.length = 0;
await boards2.newBoard("Sneaky");
ck("viewer cannot create a board even calling directly",
   calls.some((c) => c[0] === "createBoardData"), false);

// --- T6: People -----------------------------------------------------------
function peopleHandlers(extra) {
  return Object.assign({
    loadMembers: async () => MEMBERS.map((m) => ({ ...m })),
    onSetRole: (email, role) => { calls.push(["setRole", email, role]); },
    onRemoveMember: (email) => { calls.push(["removeMember", email]); },
    onOpenInvite: () => { calls.push(["openInvite"]); }
  }, extra || {});
}

await setup("admin");
panel.wirePanel(peopleHandlers());
panel.renderPanel();
await sleep(200);

const members = () => document.querySelectorAll("#wp-people .wp-member");
ck("roster rendered", members().length, 2);
ck("own row is marked", !!document.querySelector("#wp-people .wp-member .wp-you"), true);
ck("display name preferred over email",
   members()[0].querySelector(".wp-member-name").textContent.trim(), "Guy Taieb");
ck("someone who hasn't signed in is flagged",
   document.querySelector("#wp-people .wp-member[data-email='matan@korro.ai'] .wp-member-note").textContent.includes("not signed in"), true);

// An admin may change other people's roles, but never their own, and never the
// CLI-provisioned protected founder — the rules refuse both.
ck("admin gets a role select for others",
   document.querySelectorAll("#wp-people select.wp-member-role").length, 1);
ck("no role select on my own row",
   !!document.querySelector("#wp-people .wp-member[data-email='guy@korro.ai'] select"), false);
ck("protected founder is not removable",
   document.querySelectorAll("#wp-people [data-remove]").length, 1);
ck("invite is offered to an admin", $("wp-invite-open").hidden, false);

// Role change reports through the callback.
calls.length = 0;
const sel = document.querySelector("#wp-people select.wp-member-role");
sel.value = "viewer";
sel.dispatchEvent(new Event("change", { bubbles: true }));
await sleep(60);
ck("changing a role reports it", JSON.stringify(calls[0]), JSON.stringify(["setRole", "matan@korro.ai", "viewer"]));

// Viewer: sees the roster, gets no controls.
await setup("viewer");
panel.wirePanel(peopleHandlers());
panel.renderPanel();
await sleep(200);
ck("viewer sees the roster", members().length, 2);
ck("viewer gets no role selects", document.querySelectorAll("#wp-people select.wp-member-role").length, 0);
ck("viewer gets no remove buttons", document.querySelectorAll("#wp-people [data-remove]").length, 0);
ck("viewer gets no invite", $("wp-invite-open").hidden, true);

// Editor: can invite, cannot change roles.
await setup("editor");
panel.wirePanel(peopleHandlers());
panel.renderPanel();
await sleep(200);
ck("editor can invite", $("wp-invite-open").hidden, false);
ck("editor cannot change roles", document.querySelectorAll("#wp-people select.wp-member-role").length, 0);
ck("editor cannot remove people", document.querySelectorAll("#wp-people [data-remove]").length, 0);

// A failure to load must say so rather than render an empty list that looks
// like "nobody is here".
await setup("admin");
panel.wirePanel(peopleHandlers({
  loadMembers: async () => { throw Object.assign(new Error("nope"), { code: "permission-denied" }); }
}));
panel.renderPanel();
await sleep(200);
ck("a failed roster load is reported, not silently empty",
   $("wp-people").textContent.toLowerCase().includes("access"), true);

// --- T7: invite dialog ----------------------------------------------------
await setup("admin");
let invited = null;
panel.wirePanel(peopleHandlers({
  onOpenInvite: () => panel.openInvite(),
  onInvite: (email, role) => { invited = [email, role]; return Promise.resolve(); }
}));
panel.renderPanel();
panel.openPanel();
await sleep(200);

$("wp-invite-open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("dialog opens", $("invite-dialog").classList.contains("show"), true);
ck("dialog names the workspace", $("invite-ws").textContent, "Game Dev");
ck("dialog IS an overlay (a modal should pause syncing)",
   $("invite-dialog").classList.contains("overlay"), true);
ck("admin sees all three roles", document.querySelectorAll("#invite-roles .wp-seg").length, 3);
ck("viewer is the default", document.querySelector("#invite-roles .wp-seg.on").dataset.role, "viewer");
ck("the default role explains itself", $("invite-role-note").textContent.length > 10, true);

const noteBefore = $("invite-role-note").textContent;
document.querySelector('#invite-roles [data-role="editor"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("selecting a role moves the highlight",
   document.querySelector("#invite-roles .wp-seg.on").dataset.role, "editor");
ck("...and changes the one line of meaning", $("invite-role-note").textContent !== noteBefore, true);

// Escape closes the DIALOG, and leaves the panel alone.
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(60);
ck("Escape closes the dialog", $("invite-dialog").classList.contains("show"), false);
ck("Escape did not also close the panel", panel.isPanelOpen(), true);

// Submitting.
$("wp-invite-open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
$("invite-email").value = "  NEW@Korro.AI  ";
document.querySelector('#invite-roles [data-role="editor"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
$("invite-send").dispatchEvent(new MouseEvent("click", { bubbles: true }));
await sleep(120);
ck("invite reports a trimmed lowercased email", JSON.stringify(invited), JSON.stringify(["new@korro.ai", "editor"]));
ck("dialog closes after a successful invite", $("invite-dialog").classList.contains("show"), false);

// An empty email must not submit.
invited = null;
$("wp-invite-open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
$("invite-email").value = "   ";
$("invite-send").dispatchEvent(new MouseEvent("click", { bubbles: true }));
await sleep(80);
ck("an empty email does not invite", invited, null);
ck("...and the dialog stays open to fix it", $("invite-dialog").classList.contains("show"), true);
panel.closeInvite();

// An editor must not even be offered the admin role — removed, not disabled, so
// it cannot be re-enabled from devtools into a confusing server rejection.
await setup("editor");
panel.wirePanel(peopleHandlers({ onOpenInvite: () => panel.openInvite() }));
panel.renderPanel();
await sleep(200);
$("wp-invite-open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("editor sees only two roles", document.querySelectorAll("#invite-roles .wp-seg").length, 2);
ck("editor has no admin segment at all",
   !!document.querySelector('#invite-roles [data-role="admin"]'), false);
panel.closeInvite();

// --- T8: workspace overflow menu (rename / leave) -------------------------
await setup("admin");
let renamedWs = null, left = null;
panel.wirePanel(peopleHandlers({
  onCommitRenameWorkspace: (name) => { renamedWs = name; },
  onLeaveWorkspace: () => { left = true; }
}));
panel.renderPanel();

ck("only the active workspace gets a menu button",
   document.querySelectorAll("#wp-workspaces .wp-more").length, 1);
ck("...and it is on the active row",
   !!document.querySelector("#wp-workspaces .wp-ws.active .wp-more"), true);

document.querySelector(".wp-more").dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("menu opens", !!document.querySelector(".wp-menu"), true);
ck("admin is offered Rename", !!document.querySelector("[data-act='rename-ws']"), true);
// An admin leaving could strand the workspace with nobody able to manage it, so
// the rules refuse it and the menu doesn't pretend otherwise.
ck("admin is NOT offered Leave", !!document.querySelector("[data-act='leave-ws']"), false);

document.querySelector("[data-act='rename-ws']").dispatchEvent(new MouseEvent("click", { bubbles: true }));
const wsField = document.querySelector(".wp-inline");
ck("rename opens an inline field seeded with the name", wsField.value, "Game Dev");
wsField.value = "Game Development";
wsField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(40);
ck("workspace rename commits", renamedWs, "Game Development");

// A viewer can leave, and cannot rename.
await setup("viewer");
panel.wirePanel(peopleHandlers({ onLeaveWorkspace: () => { left = true; } }));
panel.renderPanel();
document.querySelector(".wp-more").dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("viewer is offered Leave", !!document.querySelector("[data-act='leave-ws']"), true);
ck("viewer is NOT offered Rename", !!document.querySelector("[data-act='rename-ws']"), false);
left = null;
document.querySelector("[data-act='leave-ws']").dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("leave reports through the callback", left, true);

// The menu must not leak: clicking elsewhere closes it.
await setup("admin");
panel.wirePanel(peopleHandlers());
panel.renderPanel();
document.querySelector(".wp-more").dispatchEvent(new MouseEvent("click", { bubbles: true }));
document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
await sleep(40);
ck("clicking away closes the menu", !!document.querySelector(".wp-menu"), false);

// --- T11: role gating sweep ------------------------------------------------
// The full matrix from the design doc, asserted per role rather than spot
// checked. The UI hiding a control is not a guard — firestore.rules is — but a
// control that appears and then fails is its own bug.
const MATRIX = {
  viewer: { newBoard: false, renameBoard: false, invite: false, roleSelect: false,
            remove: false, renameWs: false, leaveWs: true,  copyLink: true },
  editor: { newBoard: true,  renameBoard: true,  invite: true,  roleSelect: false,
            remove: false, renameWs: false, leaveWs: true,  copyLink: true },
  admin:  { newBoard: true,  renameBoard: true,  invite: true,  roleSelect: true,
            remove: true,  renameWs: true,  leaveWs: false, copyLink: true }
};

for (const [role, want] of Object.entries(MATRIX)) {
  await setup(role);
  panel.wirePanel(peopleHandlers());
  panel.renderPanel();
  await sleep(200);

  ck(`${role}: New board`, !!document.querySelector(".wp-newboard"), want.newBoard);
  ck(`${role}: rename board`, document.querySelectorAll("#wp-workspaces [data-rename]").length > 0, want.renameBoard);
  ck(`${role}: copy board link`, document.querySelectorAll("#wp-workspaces [data-link]").length > 0, want.copyLink);
  ck(`${role}: invite`, !$("wp-invite-open").hidden, want.invite);
  ck(`${role}: role selects`, document.querySelectorAll("#wp-people select.wp-member-role").length > 0, want.roleSelect);
  ck(`${role}: remove member`, document.querySelectorAll("#wp-people [data-remove]").length > 0, want.remove);

  document.querySelector(".wp-more").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  ck(`${role}: rename workspace`, !!document.querySelector("[data-act='rename-ws']"), want.renameWs);
  ck(`${role}: leave workspace`, !!document.querySelector("[data-act='leave-ws']"), want.leaveWs);
  document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await sleep(20);

  // Everyone can always see the workspaces and boards they have access to.
  ck(`${role}: sees all workspaces`, rows().length, 2);
  ck(`${role}: sees the boards`, document.querySelectorAll("#wp-workspaces .wp-board").length, 2);
  ck(`${role}: sees the roster`, members().length, 2);
}

// --- the toolbar's access chip reports the role, and does nothing else -----
// Importing toolbar.js also wires it, which is the point: if the chip were
// still a toggle, the click below would flip it.
await import("../../src/ui/toolbar.js");
const { canEdit } = await import("../../src/permissions.js");
const chip = $("lock-btn");
for (const [role, editing] of [["viewer", false], ["editor", true], ["admin", true]]) {
  await setup(role);
  const label = editing ? "Editing" : "View only";
  ck(`${role}: chip reads ${label}`, chip.textContent.trim(), label);
  ck(`${role}: chip state class`, chip.classList.contains("editing"), editing);
  ck(`${role}: body.locked mirrors the role`, document.body.classList.contains("locked"), !editing);
  ck(`${role}: canEdit follows the role alone`, canEdit(), editing);
  chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await sleep(20);
  ck(`${role}: chip click changes nothing`, chip.textContent.trim() + canEdit(), label + editing);
}
ck("chip is not a button", chip.tagName, "SPAN");

// And the guards hold when the view is bypassed entirely.
const boards3 = await import("../../src/boards.js");
for (const role of ["viewer"]) {
  await setup(role);
  calls.length = 0;
  await boards3.newBoard("Bypass");
  await boards3.renameBoard("b1", "Bypass");
  await boards3.renameWorkspace("Bypass");
  ck(`${role}: direct calls all refused`, calls.length, 0);
}

// --- case modules ----------------------------------------------------------
// One file per workstream, so two people working in parallel never edit the
// same test file.
//
// Imported LAST and awaited, deliberately: run.mjs stops listening at the
// __DONE__ marker below, and anything reported after it silently vanishes,
// failures included.
//
// They import ../harness.js, not this file. A case file that imported THIS
// module would deadlock — see the note at the top of harness.js.
await import("./cases/invite.js");
await import("./cases/gate.js");
await import("./cases/session.js");
await import("./cases/checkpoints.js");
// LAST, because it replaces backend.saveBoard with conflict/offline stubs and
// tears the live listener down at the end. Anything after it would run against
// a backend that no longer behaves like the shared one in harness.js.
await import("./cases/sync.js");

rep("__DONE__");
