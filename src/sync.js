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
import { merge3, clone } from "./merge.js";
import { backend } from "./backend/backend.js";
import { render } from "./render/index.js";
import { updateViewButtons } from "./ui/toolbar.js";
import { openCloud } from "./boards.js";

export function cloudConnected() { return !!(S.cloud && S.cloud.apiKey); }

// --- status indicators ---
const cloudDot = document.querySelector("#cloud-btn .cloud-dot");
export function setCloudStatus(msg, kind) {
  const el = $("c-status"); el.textContent = msg; el.className = "c-status" + (kind ? (" " + kind) : "");
}
export function setSync(s) {
  // dot color: grey idle, amber pending/syncing, green ok, red error
  const c = { idle: "#cbd2dd", pending: "#f59e0b", syncing: "#f59e0b", ok: "#10b981", err: "#ef4444" }[s] || "#cbd2dd";
  if (cloudDot) cloudDot.style.background = c;
  $("cloud-btn").title = "Cloud: " + s;
}

// Re-render after a programmatic state swap without losing the scroll position.
function preserveAndRender() {
  const sl = chartPane.scrollLeft, st = chartPane.scrollTop;
  updateViewButtons(); render();
  chartPane.scrollLeft = sl; chartPane.scrollTop = st;
}

export async function loadFromCloud() {
  if (!cloudConnected()) { toast("Add your JSONBin key first"); openCloud(); return; }
  if (!S.cloud.binId) { toast("Set a bin id first"); openCloud(); return; }
  setSync("syncing"); setCloudStatus("Loading bin " + S.cloud.binId + " …", "");
  try {
    const u = await backend.loadBoard(S.cloud.binId);
    if (!u) { // empty bin — nothing to load yet
      S.baseState = clone(S.state); S.loadedAt = 0; S.cloudReady = true;
      setSync("ok"); setCloudStatus("Empty bin — edits will populate it.", ""); return;
    }
    S.suppressAutosave = true;
    S.state = normalize(u.data);
    S.loadedAt = u.updatedAt;
    S.baseState = clone(S.state);
    clearDirty(); updateViewButtons(); render();
    S.suppressAutosave = false;
    S.cloudReady = true;
    setSync("ok"); setCloudStatus("Loaded bin " + S.cloud.binId, "ok");
    toast("Loaded from cloud ✓");
  } catch (err) {
    setSync("err"); setCloudStatus("Load failed: " + err.message, "err");
    toast("Cloud load failed: " + err.message);
    render(); // show whatever we have so the board isn't stuck behind the loading veil
  }
}

// Save the whole board. Loads the latest first and 3-way-merges so teammates'
// edits to other items aren't lost. Used by autosave (debounced) and "Save now".
export async function saveToCloud() {
  if (!cloudConnected() || !S.cloud.binId) return;
  if (S.savePromise) { S.saveAgain = true; return S.savePromise; } // coalesce overlapping saves
  setSync("syncing");
  S.savePromise = (async () => {
    try {
      // poll-before-write: fold in any remote changes since we loaded
      let remote = null;
      try { remote = await backend.loadBoard(S.cloud.binId); } catch (_) {}
      if (remote && remote.updatedAt && remote.updatedAt !== S.loadedAt) {
        const merged = merge3(S.baseState || remote.data, S.state, remote.data);
        S.suppressAutosave = true;
        S.state = normalize(merged);
        preserveAndRender();
        S.suppressAutosave = false;
      }
      const { updatedAt } = await backend.saveBoard(S.cloud.binId, S.state);
      S.loadedAt = updatedAt;
      S.baseState = clone(S.state);
      clearDirty();
      setSync("ok"); setCloudStatus("Saved to bin " + S.cloud.binId, "ok");
    } catch (err) {
      setSync("err"); setCloudStatus("Save failed: " + err.message, "err");
      toast("Cloud save failed: " + err.message);
    }
  })();
  await S.savePromise;
  S.savePromise = null;
  if (S.saveAgain) { S.saveAgain = false; return saveToCloud(); } // flush edits made mid-save
}

// Batched autosave: wait for a pause in editing (idle), but never hold edits
// longer than the max cap. Collapses a burst of edits into one save.
export function scheduleCloudSave() {
  if (!cloudConnected() || !S.cloud.binId || S.suppressAutosave || !S.cloudReady || S.locked) return;
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
  const remote = await backend.loadBoard(S.cloud.binId);
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
  if (!cloudConnected() || !S.cloud.binId || !S.cloudReady) return;
  if (document.hidden || uiBusy() || S.savePromise) return; // don't disturb active work / save
  try { await syncFromRemote(); } catch (_) { /* transient; try again next tick */ }
}

// Manual one-shot refresh (one load). Bound to the 🔄 toolbar button.
export async function refreshNow() {
  if (!cloudConnected() || !S.cloud.binId) { toast("Cloud not configured"); return; }
  if (uiBusy()) { toast("Finish your current edit first"); return; }
  setSync("syncing");
  try {
    const changed = await syncFromRemote();
    setSync("ok");
    toast(changed ? "Refreshed ✓" : "Already up to date");
  } catch (err) { setSync("err"); toast("Refresh failed: " + err.message); }
}
