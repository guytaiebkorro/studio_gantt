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
import { $, toast, chartPane } from "./dom.js";
import { S, clearDirty } from "./state.js";
import { canWrite, isAdmin, canAssignRole, requireEdit, requireWrite, applyRole } from "./permissions.js";
import { dateToX, today } from "./dates.js";
import { backend } from "./backend/backend.js";
import { render } from "./render/index.js";
import { applyLockUI } from "./ui/toolbar.js";
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
    }
    if (S.ws.boardId) rememberBoard(wsId, S.ws.boardId);

    // 4. Load it.
    S.cloudReady = false;
    if (S.ws.boardId) await loadFromCloud(); else render();

    // Mark the workspace OPEN before the final UI refresh, and own that flag
    // here rather than in session.js. updateWorkspaceButton() and
    // the panel's People section both key off S.gate, so refreshing while it said
    // "picker" left the toolbar reading "Gantt" and the People section hidden
    // until something happened to re-trigger them — clicking the title being
    // one, which is why the workspace name appeared to update only on click.
    S.gate = "open";
    updateCloudUI();
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
    toast("Renamed ✓");
  } catch (err) {
    if (entry) entry.name = prev;
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


// Rename the workspace. Admin-only: the name lives on the workspace document,
// and firestore.rules grants `name` changes to admins while granting `boards`
// changes to editors. Attempting it as an editor would be rejected server-side.
export async function renameWorkspace(raw) {
  if (!cloudConnected() || S.gate !== "open") return;
  if (!isAdmin()) return;
  const name = (raw || "").trim() || DEFAULT_WORKSPACE_NAME;
  const prev = S.workspaceName;
  if (name === prev) return;
  S.workspaceName = name;
  updateWorkspaceButton();
  try {
    await backend.putWorkspaceName(name);
    toast("Workspace renamed ✓");
  } catch (err) {
    S.workspaceName = prev;
    updateWorkspaceButton();
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
// The flush is gated on canWrite(), the role-level test: a save already queued
// must still land as we leave.
async function leaveActiveWorkspace() {
  stopSync();
  if (S.dirty && boardOpen() && canWrite()) await saveToCloud();
  clearLoadedBoard();
}

// Drop the loaded workspace's data so nothing leaks into the next one or shows
// behind the gate.
function clearLoadedBoard() {
  S.suppressAutosave = true;
  S.registry = [];  S.cloudReady = false; S.baseState = null; S.loadedAt = 0;
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
  clearPeople();
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
  setSync(conn ? "ok" : "idle");
  updateWorkspaceButton();
  renderPanel();
}


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
    closeInvite();   // sign-out overrides an in-progress invite; closePanel() refuses while it is up
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

// The toolbar title is the panel's only trigger. The board dropdown and Board
// button are gone from the toolbar entirely — boards live in the panel now, so
// keeping a second entry point would just be two places to look again.
$("cloud-btn").addEventListener("click", () => { openPanel(); });

async function copyBoardLink(boardId) {
  const { copyLinkTo } = await import("./share.js");
  copyLinkTo(boardId);
}
