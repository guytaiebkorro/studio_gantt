// ---------------------------------------------------------------------------
// The active workspace and its boards: opening a workspace, the toolbar board
// switcher, board CRUD, and the Workspace panel UI.
//
// Two levels of grouping:
//   workspace — a server-side object. You belong to it via a member document;
//               tools/admin creates it and firestore.rules denies clients from
//               doing so. session.js decides WHICH one to open.
//   board     — one document inside the active workspace.
//
// All networking goes through the `backend` adapter — this file contains no
// Firestore calls, so it works unchanged against any backend.
//
// GONE from the JSONBin era: the registry-resolution ladder (cached id → verify
// → discover by content shape → create), key entry, and every "forget this
// workspace locally" action. Discovery existed only because JSONBin had no
// concept of a user; and access can no longer be forgotten client-side, because
// it was never granted client-side. Losing access means an admin removes you.
// ---------------------------------------------------------------------------
import { DEFAULT_WORKSPACE_NAME } from "./config.js";
import { $, esc, toast, chartPane, wireBackdropClose } from "./dom.js";
import { S, clearDirty } from "./state.js";
import { canWrite, isAdmin, canAssignRole, requireEdit, requireWrite, applyRole } from "./permissions.js";
import { dateToX, today } from "./dates.js";
import { backend } from "./backend/backend.js";
import { render } from "./render/index.js";
import { applyLockUI } from "./ui/toolbar.js";
import { renderMembers, clearMembers } from "./ui/members.js";
import {
  wirePanel, renderPanel, openPanel, closePanel, beginNewBoard, beginRenameBoard,
  openInvite, closeInvite, clearPeople
} from "./ui/panel.js";
import {
  rememberBoard, lastBoardFor, leaveWorkspace as leaveMembership,
  listMembers, setMemberRole, removeMember, inviteMember
} from "./memberships.js";
import {
  loadFromCloud, saveToCloud, refreshNow, setSync, setCloudStatus,
  cloudConnected, boardOpen, startPolling
} from "./sync.js";

let _lastError = "";
export function lastOpenError() { return _lastError; }

// Point the app at a workspace and load a board.
//
// `role` came from this user's member document — it is a MIRROR of the server's
// answer, not a decision made here. firestore.rules is the enforcement.
//
// Returns true on success; the caller (session.js) decides what to show on
// failure, because only it knows whether there are other workspaces to fall
// back to.
export async function openWorkspace(wsId, opts) {
  opts = opts || {};
  _lastError = "";
  applyRole(opts.role);
  applyLockUI();

  S.ws = { id: wsId, boardId: opts.boardId || lastBoardFor(wsId) || "" };
  backend.wsId = wsId;
  // A cached name paints the toolbar now; the workspace document's copy wins
  // as soon as loadRegistry() answers.
  S.workspaceName = opts.name || DEFAULT_WORKSPACE_NAME;
  updateWorkspaceButton();

  setSync("syncing");
  setCloudStatus("Opening…", "");
  $("loading").classList.add("show");
  try {
    // 1. The workspace document: its real name and its board index.
    await loadRegistry();

    // 2. Resolve the board.
    if (S.registry.length && !S.registry.some((b) => b.id === S.ws.boardId)) {
      S.ws.boardId = S.registry[0].id;
      renderBoardSelect();
    }

    // 3. A freshly provisioned workspace can have an empty index. Bootstrap one
    //    board if we're allowed to write; a viewer gets an empty board instead,
    //    since they cannot create one and shouldn't see a failed write.
    if (!S.registry.length && canWrite()) {
      setCloudStatus("Creating your first board…", "");
      const empty = { version: 1, settings: { viewMode: S.state.settings.viewMode || "week" }, groups: [], tasks: [] };
      const { id } = await backend.createBoardData("My Board", empty);
      S.registry = [{ id, name: "My Board" }];
      await backend.putBoards(S.registry);
      S.ws.boardId = id;
      renderBoardSelect();
    }
    if (S.ws.boardId) rememberBoard(wsId, S.ws.boardId);

    // 4. Load it.
    S.cloudReady = false;
    if (S.ws.boardId) await loadFromCloud(); else render();

    // Mark the workspace OPEN before the final UI refresh, and own that flag
    // here rather than in session.js. updateWorkspaceButton() and
    // renderMembers() both key off S.gate, so refreshing while it still said
    // "picker" left the toolbar reading "Gantt" and the People section hidden
    // until something happened to re-trigger them — clicking the title being
    // one, which is why the workspace name appeared to update only on click.
    S.gate = "open";
    updateCloudUI();
    closeCloud();
    startPolling();
    requestAnimationFrame(() => {
      chartPane.scrollLeft = Math.max(0, dateToX(today()) - chartPane.clientWidth / 2);
    });
    return true;
  } catch (err) {
    _lastError = friendlyError(err);
    setSync("err");
    setCloudStatus(_lastError, "err");
    return false;
  } finally {
    $("loading").classList.remove("show");
  }
}

// Firestore error codes are precise but not readable. permission-denied in
// particular has one very likely cause here, and guessing wrong wastes the
// user's time.
export function friendlyError(err) {
  const code = (err && err.code) || "";
  switch (code) {
    case "permission-denied":
      return "You don't have permission for that — your access may have changed. Try reopening the workspace.";
    case "not-found":
      return "That workspace no longer exists, or you were removed from it.";
    case "unavailable":
    case "deadline-exceeded":
      return "Couldn't reach the server. Your changes are kept locally until it's back.";
    case "unauthenticated":
      return "You're signed out. Sign in again to continue.";
    case "failed-precondition":
      return (err.message || "The server rejected that request.");
    default:
      return (err && err.message) || "Something went wrong.";
  }
}

// --- the workspace record (its name + its board index) ---------------------
export async function loadRegistry() {
  if (!cloudConnected()) return;
  const reg = await backend.getRegistry();
  S.registry = reg.boards;
  // The workspace document is authoritative; the name we painted from cache may
  // be stale (or absent on a first visit). Repaint here so this function leaves
  // the UI consistent on its own, rather than relying on a later caller.
  if (reg.name) { S.workspaceName = reg.name; updateWorkspaceButton(); }
  renderBoardSelect();
}

export function renderBoardSelect() {
  const sel = $("board-select");
  if (!sel) return;
  sel.innerHTML = S.registry.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
  if (S.ws.boardId && !S.registry.some((b) => b.id === S.ws.boardId)) {
    const o = document.createElement("option");
    o.value = S.ws.boardId; o.textContent = "(current)";
    sel.appendChild(o);
  }
  sel.value = S.ws.boardId || "";
  fitBoardSelect();
}

// Size the select to its SELECTED option, not its widest one — a native select
// keeps the width of the longest board name, stranding the chevron far from a
// short selected name.
function fitBoardSelect() {
  const sel = $("board-select");
  const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
  if (!opt) { if (sel) sel.style.width = ""; return; }
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute; visibility:hidden; white-space:nowrap;";
  probe.style.font = getComputedStyle(sel).font;
  probe.textContent = opt.textContent;
  document.body.appendChild(probe);
  const text = probe.getBoundingClientRect().width;
  probe.remove();
  sel.style.width = Math.ceil(Math.min(200, text + 44)) + "px";
}

export async function switchBoard(id) {
  if (!id || id === S.ws.boardId) return;
  // Flush first, for the same reason leaveActiveWorkspace() does: saveToCloud()
  // reads S.state at write time, so switching mid-save would push this board's
  // content over the other one.
  if (S.dirty && boardOpen() && canWrite()) await saveToCloud();
  S.ws.boardId = id;
  rememberBoard(S.ws.id, id);
  S.cloudReady = false;
  renderBoardSelect();
  $("loading").classList.add("show");
  await loadFromCloud();
  $("loading").classList.remove("show");
}

// `name` comes from the panel's inline field. It used to come from prompt(),
// which was unstyleable, blocked the page, and looked nothing like the app.
//
// requireWrite() rather than requireEdit(): creating a board is workspace
// management, not a chart edit, so the chart lock has no say. See permissions.js.
export async function newBoard(name) {
  if (!requireWrite()) return;
  if (!cloudConnected()) { toast("No workspace is open"); return; }
  name = String(name || "").trim();
  if (!name) return;
  setSync("syncing"); setCloudStatus("Creating board…", "");
  $("loading").classList.add("show");
  try {
    const empty = { version: 1, settings: { viewMode: S.state.settings.viewMode || "week" }, groups: [], tasks: [] };
    const { id } = await backend.createBoardData(name, empty);
    S.registry.push({ id, name });
    await backend.putBoards(S.registry);
    S.ws.boardId = id;
    rememberBoard(S.ws.id, id);
    S.cloudReady = false;
    renderBoardSelect();
    await loadFromCloud();
    toast("Board “" + name + "” created ✓");
  } catch (err) {
    setSync("err");
    setCloudStatus(friendlyError(err), "err");
    toast("Create board failed: " + friendlyError(err));
  } finally {
    $("loading").classList.remove("show");
  }
}

export async function renameBoard(boardId, name) {
  if (!requireWrite()) return;
  if (!S.registry.length) { toast("No boards to rename"); return; }
  boardId = boardId || S.ws.boardId;
  const entry = S.registry.find((b) => b.id === boardId);
  name = String(name || "").trim();
  if (!name) return;
  const prev = entry ? entry.name : "";
  if (entry) entry.name = name; else S.registry.push({ id: boardId, name });
  try {
    // Both copies: the denormalized index the dropdown reads, and the board
    // document's own name. Two writes is the cost of denormalizing the index
    // onto the workspace doc, which is what makes the dropdown one read.
    await backend.putBoards(S.registry);
    await backend.renameBoard(boardId, name);
    renderBoardSelect();
    toast("Renamed ✓");
  } catch (err) {
    if (entry) entry.name = prev;
    renderBoardSelect();
    toast("Rename failed: " + friendlyError(err));
  }
}

// There is deliberately no delete-board action. Boards are the unit of shared
// work and deletion is unrecoverable — the backend keeps no version history the
// app can restore from, and a teammate's board would vanish under them with
// nothing to undo. firestore.rules denies it outright too. Retiring a board is
// a rename away; tools/admin can archive one.

// --- workspace name + the toolbar button ------------------------------------

// The workspace button sits in the toolbar's title slot — the workspace you're
// in is more useful there than the app's own name. Its tooltip also carries the
// sync state, which setSync() refreshes through here.
//
// The browser tab is named the same way, so several workspaces open side by side
// are tellable apart from the tab strip alone.
export function updateWorkspaceButton() {
  const conn = cloudConnected() && S.gate === "open";
  const name = S.workspaceName || DEFAULT_WORKSPACE_NAME;
  const label = $("cloud-label");
  if (label) label.textContent = conn ? name : "Gantt";
  document.title = conn ? (S.viewOnly ? `${name} (view only)` : name) : "Gantt";
  const btn = $("cloud-btn");
  if (btn) btn.title = (conn ? `Workspace: ${name}` : "Workspace") + ` — sync: ${S.syncState}`;
}

// Mirror the active workspace name into the panel's field. Skipped while the
// field has focus so a background refresh can't overwrite mid-edit.
function renderWorkspaceName() {
  const inp = $("c-ws-name");
  if (inp && document.activeElement !== inp) inp.value = S.workspaceName || "";
}

// Rename the workspace. Admin-only: the name lives on the workspace document,
// and firestore.rules grants `name` changes to admins while granting `boards`
// changes to editors. Attempting it as an editor would be rejected server-side.
async function renameWorkspace(raw) {
  if (!cloudConnected() || S.gate !== "open") return;
  if (!isAdmin()) { renderWorkspaceName(); return; }
  const name = (raw || "").trim() || DEFAULT_WORKSPACE_NAME;
  const prev = S.workspaceName;
  if (name === prev) { renderWorkspaceName(); return; }
  S.workspaceName = name;
  updateWorkspaceButton(); renderWorkspaceName();
  try {
    await backend.putWorkspaceName(name);
    toast("Workspace renamed ✓");
  } catch (err) {
    S.workspaceName = prev;
    updateWorkspaceButton(); renderWorkspaceName();
    toast("Rename failed: " + friendlyError(err));
  }
}

// --- teardown ---------------------------------------------------------------

function stopSync() {
  clearTimeout(S.autosaveTimer); S.autosaveTimer = null; S.firstDirtyAt = 0;
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
}

// Stop syncing and hand back the workspace we're standing on.
//
// The pending save MUST complete before the board is cleared: saveToCloud()
// merges from S.state at write time, so letting it run against the blanked
// state would push an empty board over the user's data.
//
// The flush is gated on canWrite() and NOT canEdit(): a save already queued
// while unlocked must still land even if the user re-locked in the meantime.
// Using canEdit() here would silently drop legitimate edits.
async function leaveActiveWorkspace() {
  stopSync();
  if (S.dirty && boardOpen() && canWrite()) await saveToCloud();
  clearLoadedBoard();
}

// Drop the loaded workspace's data so nothing leaks into the next one or shows
// behind the gate.
function clearLoadedBoard() {
  S.suppressAutosave = true;
  S.registry = []; renderBoardSelect();
  S.cloudReady = false; S.baseState = null; S.loadedAt = 0;
  S.state = {
    version: 1,
    settings: { viewMode: (S.state.settings && S.state.settings.viewMode) || "week" },
    groups: [], tasks: []
  };
  clearDirty(); render();
  S.suppressAutosave = false;
}

// Full release: tear down, THEN drop the pointer.
//
// S.ws must not be blanked until leaveActiveWorkspace() has resolved. Both
// saveToCloud() and boardOpen() key off S.ws.boardId, so clearing it first
// would make the flush a silent no-op and lose the user's last edits with no
// error anywhere.
export async function leaveWorkspace() {
  await leaveActiveWorkspace();
  S.ws = { id: "", boardId: "" };
  backend.wsId = null;
  S.role = null;
  S.workspaceName = DEFAULT_WORKSPACE_NAME;
  clearMembers();
  updateWorkspaceButton();
}

// Leave a workspace for good: delete my own member document. Distinct from
// leaveWorkspace() above, which is just "stop looking at it".
async function leaveForGood() {
  if (!S.ws.id) return;
  if (isAdmin()) {
    toast("Admins can't remove themselves — ask another admin, or use tools/admin");
    return;
  }
  const name = S.workspaceName;
  if (!confirm(`Leave “${name}”?\nYou'll lose access until someone invites you again.`)) return;
  const wsId = S.ws.id;
  try {
    await leaveWorkspace();
    await leaveMembership(wsId);
    toast(`Left “${name}”`);
    // Re-run discovery so the gate reflects reality. Imported lazily to keep
    // session.js -> boards.js one-directional at module level.
    const { refreshMemberships } = await import("./session.js");
    S.memberships = S.memberships.filter((m) => m.wsId !== wsId);
    await refreshMemberships();
  } catch (err) {
    toast("Couldn't leave: " + friendlyError(err));
  }
}

// --- panel UI ---------------------------------------------------------------
export function updateCloudUI() {
  const conn = cloudConnected() && S.gate === "open";
  document.body.classList.toggle("cloud-on", conn);
  if (conn) {
    const n = S.registry.length;
    setCloudStatus(`“${S.workspaceName}” — ${n === 1 ? "1 board" : n + " boards"}.`, "ok");
    setSync("ok");
  } else {
    setSync("idle");
  }
  const who = $("c-signed-in-as");
  if (who) who.textContent = S.user ? `Signed in as ${S.user.email} — ${S.role || "?"} in this workspace.` : "";
  updateWorkspaceButton();
  renderWorkspaceName();
  renderMembers();
  renderPanel();
}

export function openCloud() {
  // The panel is only reachable with a workspace open; the gate handles every
  // other state, so this no longer needs a non-dismissable mode.
  if (S.gate !== "open") return;
  updateCloudUI();
  $("cloud-overlay").classList.add("show");
}
export function closeCloud() {
  $("cloud-overlay").classList.remove("show");
}

// --- wiring -----------------------------------------------------------------
$("c-close").addEventListener("click", closeCloud);
wireBackdropClose($("cloud-overlay"), closeCloud);
$("c-ws-name").addEventListener("change", (e) => { renameWorkspace(e.target.value); });
$("c-ws-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  if (e.key === "Escape") { e.preventDefault(); renderWorkspaceName(); e.target.blur(); }
});
$("c-ws-switch").addEventListener("click", async () => {
  closeCloud();
  const { showGate } = await import("./ui/gate.js");
  S.gate = "picker";
  showGate("picker", { email: S.user && S.user.email, memberships: S.memberships });
});
$("c-leave-ws").addEventListener("click", () => { leaveForGood(); });
$("c-savenow").addEventListener("click", () => { if (requireEdit()) saveToCloud(); });
$("board-select").addEventListener("change", (e) => { switchBoard(e.target.value); });
$("refresh-btn").addEventListener("click", () => { refreshNow(); });

// --- panel wiring ----------------------------------------------------------
// The panel is a pure view: it reports intent through these callbacks and never
// touches the backend itself. Every mutating one re-enters the guarded function
// in this module, so the permission checks stay in one place.
//
// Exported (and not just run at module scope) so it can be re-installed. Tests
// swap in their own callbacks to assert what the view reports, and need a way
// to put the real ones back; wirePanel() replaces the handler set wholesale.
export function installPanelHandlers() {
wirePanel({
  onOpen: () => renderPanel(),
  onSignOut: async () => {
    closePanel();
    const { doSignOut } = await import("./session.js");
    doSignOut();
  },
  onSelectWorkspace: async (wsId) => {
    if (wsId === S.ws.id) return;
    const { pickWorkspace } = await import("./session.js");
    await pickWorkspace(wsId);
    renderPanel();
  },
  onSelectBoard: async (wsId, boardId) => {
    if (wsId !== S.ws.id) return;      // boards of a collapsed workspace aren't rendered
    await switchBoard(boardId);
    renderPanel();
  },
  onCommitRenameWorkspace: async (name) => { await renameWorkspace(name); renderPanel(); },
  onLeaveWorkspace: () => leaveForGood(),
  onNewBoard: () => beginNewBoard(),
  onCommitNewBoard: async (name) => { await newBoard(name); renderPanel(); },
  onRenameBoard: (boardId) => beginRenameBoard(boardId),
  onCommitRenameBoard: async (boardId, name) => { await renameBoard(boardId, name); renderPanel(); },
  onCopyLink: () => copyBoardLink(S.ws.boardId),
  onCopyBoardLink: (boardId) => copyBoardLink(boardId),

  // People. The panel is a view and never talks to Firestore itself, so the
  // roster arrives through this callback.
  loadMembers: () => listMembers(S.ws.id),
  onOpenInvite: () => openInvite(),
  onInvite: async (email, role) => {
    // Throws on rejection so the dialog can keep itself open and show why,
    // rather than closing over a failure.
    await inviteMember(S.ws.id, email, role);
    toast(`Invited ${email} as ${role} — they're in next time they sign in`);
  },
  onSetRole: async (email, role) => {
    if (!canAssignRole(role)) { toast(`You can't set someone to ${role}`); return; }
    try {
      await setMemberRole(S.ws.id, email, role);
      toast(`${email} is now ${role}`);
    } catch (err) { toast("Couldn't change that role: " + friendlyError(err)); }
    renderPanel();
  },
  onRemoveMember: async (email) => {
    if (!confirm(`Remove ${email} from “${S.workspaceName}”?\nThey lose access immediately.`)) return;
    try {
      await removeMember(S.ws.id, email);
      toast(`Removed ${email}`);
    } catch (err) { toast("Couldn't remove them: " + friendlyError(err)); }
    renderPanel();
  }
});
}
installPanelHandlers();

// The toolbar title is the panel's trigger. Board creation now lives in the
// panel too, so #board-new opens it straight into a new-board field rather than
// duplicating the flow.
$("cloud-btn").addEventListener("click", () => { openPanel(); });
$("board-new").addEventListener("click", () => { openPanel(); beginNewBoard(); });

async function copyBoardLink(boardId) {
  const { copyLinkTo } = await import("./share.js");
  copyLinkTo(boardId);
}
