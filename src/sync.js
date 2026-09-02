// ---------------------------------------------------------------------------
// Cloud sync orchestration (backend-agnostic).
//
// Sits ON TOP OF the storage backend. The backend only loads/saves documents;
// this module adds the behavior shared by every backend:
//   - autosave debouncing (idle + max-interval)
//   - poll-before-write 3-way merge so teammates' edits aren't lost
//   - manual refresh + optional background polling
//   - the ☁ status dot
// ---------------------------------------------------------------------------
import { SAVE_IDLE_MS, SAVE_MAX_MS, POLL_MS, POLL_ENABLED } from "./config.js";
import { $, chartPane, toast } from "./dom.js";
import { S, normalize, clearDirty } from "./state.js";
import { canEdit } from "./permissions.js";
import { merge3, clone } from "./merge.js";
import { backend } from "./backend/backend.js";
import { render } from "./render/index.js";
import { updateViewButtons } from "./ui/toolbar.js";
import { updateWorkspaceButton } from "./boards.js";
import { friendlyError, isPermissionDenied } from "./errors.js";

// Signed in AND pointed at a workspace. No credential is involved any more —
// identity lives in Firebase Auth, not in S.
export function cloudConnected() { return !!(S.user && S.ws && S.ws.id); }

// ...and a board is actually loadable/saveable. Replaces every
// `cloudConnected() && S.ws.boardId` pair.
export function boardOpen() { return cloudConnected() && !!S.ws.boardId; }

// The active board's display name, for status text. Falls back to the id only
// if the index somehow lacks it.
function boardName() {
  const b = S.registry && S.registry.find((x) => x.id === S.ws.boardId);
  return (b && b.name) || S.ws.boardId || "board";
}

// --- status indicators ---
const cloudDot = document.querySelector("#cloud-btn .cloud-dot");
export function setCloudStatus(msg, kind) {
  const el = $("c-status"); el.textContent = msg; el.className = "c-status" + (kind ? (" " + kind) : "");
}
export function setSync(s) {
  // dot color: grey idle, amber pending/syncing, green ok, red error
  const c = { idle: "#cbd2dd", pending: "#f59e0b", syncing: "#f59e0b", ok: "#10b981", err: "#ef4444" }[s] || "#cbd2dd";
  if (cloudDot) cloudDot.style.background = c;
  // The button shows the workspace name, so boards.js owns its label and title.
  S.syncState = s;
  updateWorkspaceButton();
}

// Re-render after a programmatic state swap without losing the scroll position.
function preserveAndRender() {
  const sl = chartPane.scrollLeft, st = chartPane.scrollTop;
  updateViewButtons(); render();
  chartPane.scrollLeft = sl; chartPane.scrollTop = st;
}

export async function loadFromCloud() {
  if (!cloudConnected()) { toast("No workspace is open"); return; }
  if (!S.ws.boardId) { toast("No board selected"); return; }
  setSync("syncing"); setCloudStatus("Loading " + boardName() + "…", "");
  try {
    const u = await backend.loadBoard(S.ws.boardId);
    if (!u) { // empty board — nothing to load yet
      S.baseState = clone(S.state); S.loadedAt = 0; S.cloudReady = true;
      setSync("ok"); setCloudStatus("Empty board — edits will populate it.", ""); return;
    }
    S.suppressAutosave = true;
    S.state = normalize(u.data);
    S.loadedAt = u.updatedAt;
    S.baseState = clone(S.state);
    clearDirty(); updateViewButtons(); render();
    S.suppressAutosave = false;
    S.cloudReady = true;
    setSync("ok"); setCloudStatus("Loaded " + boardName(), "ok");
    toast("Loaded from cloud ✓");
  } catch (err) {
    setSync("err"); setCloudStatus("Load failed: " + friendlyError(err), "err");
    toast("Couldn't load the board: " + friendlyError(err));
    render(); // show whatever we have so the board isn't stuck behind the loading veil
  }
}

// Save the whole board. Loads the latest first and 3-way-merges so teammates'
// edits to other items aren't lost. Used by autosave (debounced) and "Save now".
export async function saveToCloud() {
  if (!boardOpen()) return;
  if (S.savePromise) { S.saveAgain = true; return S.savePromise; } // coalesce overlapping saves
  setSync("syncing");
  S.savePromise = (async () => {
    try {
      // poll-before-write: fold in any remote changes since we loaded
      let remote = null;
      try { remote = await backend.loadBoard(S.ws.boardId); } catch (_) {}
      if (remote && remote.updatedAt && remote.updatedAt !== S.loadedAt) {
        const merged = merge3(S.baseState || remote.data, S.state, remote.data);
        S.suppressAutosave = true;
        S.state = normalize(merged);
        preserveAndRender();
        S.suppressAutosave = false;
      }
      const { updatedAt } = await backend.saveBoard(S.ws.boardId, S.state);
      S.loadedAt = updatedAt;
      S.baseState = clone(S.state);
      clearDirty();
      setSync("ok"); setCloudStatus("Saved " + boardName(), "ok");
    } catch (err) {
      handleWriteError(err);
    }
  })();
  try {
    await S.savePromise;
  } finally {
    // MUST be cleared in a finally. Firestore writes do not reject when offline
    // — they sit queued indefinitely — and the coalescing guard above returns
    // early whenever S.savePromise is set. Clearing it only on the happy path
    // meant one offline blip wedged autosave permanently, leaving a
    // beforeunload warning the user could never clear. (fetch always settled,
    // so this was safe against JSONBin and is not against Firestore.)
    S.savePromise = null;
  }
  if (S.saveAgain) { S.saveAgain = false; return saveToCloud(); } // flush edits made mid-save
}

// A write can fail because this user's role changed while the tab was open.
// Do NOT clearDirty() on that path: the edits exist only locally, and dropping
// the flag would discard them silently. Stop autosaving, tell the user plainly,
// and re-read the role so the UI stops offering edits it can't make.
function handleWriteError(err) {
  const msg = friendlyError(err);
  setSync("err");
  setCloudStatus(msg, "err");
  if (isPermissionDenied(err)) {
    clearTimeout(S.autosaveTimer); S.autosaveTimer = null; S.firstDirtyAt = 0;
    toast("Your access to this workspace changed — your edits are still here, but can't be saved");
    reassertRole();
    return;
  }
  toast("Save failed: " + msg);
}

// Re-read my role from the server and adopt it. Imported lazily to avoid adding
// another edge to the state -> sync -> boards cycle at module-evaluation time.
async function reassertRole() {
  try {
    const [{ getMyRole }, { applyRole }, { applyLockUI }] = await Promise.all([
      import("./memberships.js"), import("./permissions.js"), import("./ui/toolbar.js")
    ]);
    const role = await getMyRole(S.ws.id);
    applyRole(role);          // null -> viewer, which is the safe direction
    applyLockUI();
    render();
  } catch (_) { /* best effort; the next write will surface it again */ }
}

// Batched autosave: wait for a pause in editing (idle), but never hold edits
// longer than the max cap. Collapses a burst of edits into one save.
export function scheduleCloudSave() {
  // canEdit() rather than !S.locked: a viewer must never even SCHEDULE a write,
  // so we don't queue saves that the server can only reject.
  if (!boardOpen() || S.suppressAutosave || !S.cloudReady || !canEdit()) return;
  setSync("pending");
  const now = Date.now();
  if (!S.firstDirtyAt) S.firstDirtyAt = now;
  const wait = Math.min(SAVE_IDLE_MS, Math.max(0, SAVE_MAX_MS - (now - S.firstDirtyAt)));
  clearTimeout(S.autosaveTimer);
  S.autosaveTimer = setTimeout(flushSave, wait);
}
export function flushSave() {
  clearTimeout(S.autosaveTimer); S.autosaveTimer = null; S.firstDirtyAt = 0;
  if (S.dirty) saveToCloud();
}

// --- pull teammates' changes (shared by polling and the manual Refresh button) ---
export function startPolling() { if (POLL_ENABLED && !S.pollTimer) S.pollTimer = setInterval(pollTick, POLL_MS); }
function uiBusy() { return S.dragging || !!document.querySelector(".overlay.show"); }

// Returns true if something new was pulled in.
export async function syncFromRemote() {
  const remote = await backend.loadBoard(S.ws.boardId);
  if (!remote || !remote.updatedAt || remote.updatedAt <= S.loadedAt) return false; // nothing new
  if (S.dirty) {
    // we have local edits — merge remote in, then let autosave push the result
    const merged = merge3(S.baseState || remote.data, S.state, remote.data);
    S.suppressAutosave = true; S.state = normalize(merged); preserveAndRender(); S.suppressAutosave = false;
    S.baseState = clone(S.state); S.loadedAt = remote.updatedAt;
    scheduleCloudSave();
  } else {
    // clean — just adopt the remote version
    S.suppressAutosave = true; S.state = normalize(remote.data); preserveAndRender(); S.suppressAutosave = false;
    S.baseState = clone(S.state); S.loadedAt = remote.updatedAt; S.cloudReady = true;
    setSync("ok");
  }
  return true;
}
async function pollTick() {
  if (!boardOpen() || !S.cloudReady) return;
  if (document.hidden || uiBusy() || S.savePromise) return; // don't disturb active work / save
  try { await syncFromRemote(); } catch (_) { /* transient; try again next tick */ }
}

// Refresh when the app becomes active again (tab selected / window refocused).
// Pulls teammates' edits AND re-renders so the "today" marker and time-based
// progress reflect the current wall-clock — a day (or more) may have elapsed
// while the tab sat in the background. Switching back fires both
// `visibilitychange` (→ visible) and `focus`, so coalesce them into one hit.
let activateTimer = null;
export function refreshOnActivate() {
  if (activateTimer) return; // a refresh is already queued from the paired event
  activateTimer = setTimeout(async () => {
    activateTimer = null;
    if (uiBusy() || S.savePromise) return; // don't disturb active work / an in-flight save
    if (boardOpen() && S.cloudReady) {
      try { await syncFromRemote(); } catch (_) { /* transient; polling/next activate retries */ }
    }
    preserveAndRender(); // always re-render for the fresh clock, even with no remote change
  }, 150);
}

// Manual one-shot refresh (one load). Bound to the 🔄 toolbar button.
export async function refreshNow() {
  if (!boardOpen()) { toast("No board is open"); return; }
  if (uiBusy()) { toast("Finish your current edit first"); return; }
  setSync("syncing");
  try {
    const changed = await syncFromRemote();
    setSync("ok");
    toast(changed ? "Refreshed ✓" : "Already up to date");
  } catch (err) { setSync("err"); toast("Refresh failed: " + friendlyError(err)); }
}
