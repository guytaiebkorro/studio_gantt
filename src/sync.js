// ---------------------------------------------------------------------------
// Cloud sync orchestration (backend-agnostic). Autosave debouncing, the merge
// policy, the live listener, and the ☁ status dot.
// ---------------------------------------------------------------------------
import { SAVE_IDLE_MS, SAVE_MAX_MS, SAVE_RETRY_MAX } from "./config.js";
import { $, chartPane, toast } from "./dom.js";
import { S, normalize, clearDirty } from "./state.js";
import { canEdit } from "./permissions.js";
import { merge3, clone } from "./merge.js";
import { backend } from "./backend/backend.js";
import { render } from "./render/index.js";
import { updateViewButtons } from "./ui/toolbar.js";
import { updateWorkspaceButton } from "./boards.js";
import { friendlyError, isPermissionDenied, isOffline } from "./errors.js";

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
// Transient status. Only ERRORS are surfaced now: the old modal's status line
// also narrated "Loaded", "Saved", "3 boards", which the sync dot and the panel
// itself already say. An error, though, would otherwise vanish entirely.
export function setCloudStatus(msg, kind) {
  const el = $("wp-status");
  if (!el) return;
  const show = !!msg && kind === "err";
  el.textContent = show ? msg : "";
  el.hidden = !show;
}
export function setSync(s) {
  const c = {
    idle: "#cbd2dd", pending: "#f59e0b", syncing: "#f59e0b",
    ok: "#10b981", err: "#ef4444", offline: "#64748b"
  }[s] || "#cbd2dd";
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
  // Detach up front, so a load that FAILS leaves no listener on the old board.
  stopWatching();
  setSync("syncing"); setCloudStatus("Loading " + boardName() + "…", "");
  try {
    const u = await backend.loadBoard(S.ws.boardId);
    if (!u) { // empty board — nothing to load yet
      S.baseState = clone(S.state); S.loadedAt = 0; S.cloudReady = true;
      startWatching();
      setSync("ok"); setCloudStatus("Empty board — edits will populate it.", ""); return;
    }
    S.suppressAutosave = true;
    S.state = normalize(u.data);
    S.loadedAt = u.updatedAt;
    S.baseState = clone(S.state);
    clearDirty(); updateViewButtons(); render();
    S.suppressAutosave = false;
    S.cloudReady = true;
    // The single attach point: this is the one function that establishes
    // S.loadedAt and S.baseState, so every caller gets a listener for free.
    startWatching();
    setSync("ok"); setCloudStatus("Loaded " + boardName(), "ok");
    toast("Loaded from cloud ✓");
  } catch (err) {
    setSync("err"); setCloudStatus("Load failed: " + friendlyError(err), "err");
    toast("Couldn't load the board: " + friendlyError(err));
    render(); // show whatever we have so the board isn't stuck behind the loading veil
  }
}

// Runs INSIDE saveBoard's transaction, so it must stay pure and re-runnable —
// the transaction re-invokes it on contention. Adopting the result into S.state
// is saveToCloud's job, once, after the commit.
//
// Returns S.state BY IDENTITY when the server hasn't moved. That is load-bearing,
// not a micro-optimisation: saveToCloud re-renders whenever the result differs
// from what it sent, and merge3 always allocates, so without this every autosave
// cost a full chart rebuild.
function reconcile(remoteData, remoteUpdatedAt) {
  if (remoteUpdatedAt && remoteUpdatedAt === S.loadedAt) return S.state;
  const rdata = normalize(remoteData);
  return normalize(merge3(S.baseState || rdata, S.state, rdata));
}

export async function saveToCloud() {
  if (!boardOpen()) return;
  if (S.savePromise) { S.saveAgain = true; return S.savePromise; } // coalesce overlapping saves
  setSync("syncing");
  S.savePromise = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        // `state` is what landed; the transaction may have re-run and merged.
        const { updatedAt, state } = await backend.saveBoard(S.ws.boardId, S.state, reconcile);
        if (state !== S.state) {
          S.suppressAutosave = true;
          S.state = state;
          preserveAndRender();
          S.suppressAutosave = false;
        }
        S.loadedAt = updatedAt;      // doubles as the self-echo filter — see isNewer()
        S.baseState = clone(S.state);
        S.offline = false;
        clearDirty();
        setSync("ok"); setCloudStatus("Saved " + boardName(), "ok");
        return;
      } catch (err) {
        // A lost rev race and a revoked role are the same error code and can't
        // be told apart without re-reading, so retry before believing it: the
        // race succeeds against the fresh rev, a real denial fails every time.
        if (isPermissionDenied(err) && attempt < SAVE_RETRY_MAX) continue;
        handleWriteError(err);
        return;
      }
    }
  })();
  try {
    await S.savePromise;
  } finally {
    // MUST be a finally: the coalescing guard returns early whenever this is
    // set, so leaving it set on a failure path wedges autosave permanently.
    S.savePromise = null;
  }
  if (S.saveAgain) { S.saveAgain = false; return saveToCloud(); } // flush edits made mid-save
  applyPendingRemote(); // a snapshot may have queued up behind S.savePromise
}

// A write can fail because this user's role changed while the tab was open, or
// because the server simply isn't reachable. Neither one may clearDirty(): the
// edits exist only locally, and dropping the flag would discard them silently.
function handleWriteError(err) {
  const msg = friendlyError(err);
  setCloudStatus(msg, "err");
  if (isPermissionDenied(err)) {
    // Role change: stop autosaving, since every further attempt can only fail.
    setSync("err");
    clearTimeout(S.autosaveTimer); S.autosaveTimer = null; S.firstDirtyAt = 0;
    toast("Your access to this workspace changed — your edits are still here, but can't be saved");
    reassertRole();
    return;
  }
  if (isOffline(err)) {
    // The only place S.offline is set; noteConnectivity clears it and retries.
    // Deliberately does NOT cancel the autosave timer — further edits should
    // keep re-arming it so a save is already due when the connection returns.
    S.offline = true;
    setSync("offline");
    toast("You're offline — your changes are saved here and will sync when you reconnect");
    return;
  }
  setSync("err");
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
  // canEdit() gates this: a viewer must never even SCHEDULE a write, so we
  // don't queue saves that the server can only reject.
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

// --- live team sync ---------------------------------------------------------
function uiBusy() { return S.dragging || !!document.querySelector(".overlay.show"); }

// Re-entrant: detaches any existing listener first.
export function startWatching() {
  stopWatching();
  if (!boardOpen()) return;
  const boardId = S.ws.boardId;
  S.unwatchBoard = backend.watchBoard(
    boardId,
    (remote, meta) => {
      // unsubscribe() is not documented to be synchronous, and adopting another
      // board's content into this one would be silent and catastrophic.
      if (boardId !== S.ws.boardId) return;
      noteConnectivity(meta);
      if (meta.hasPendingWrites) return;   // our own unacked write
      if (!isNewer(remote)) return;
      S.pendingRemote = remote;   // latest wins — supersede any earlier one
      applyPendingRemote();
    },
    (err) => {
      // Terminal: Firestore does not re-establish a failed listener.
      setSync("err");
      setCloudStatus("Live sync stopped: " + friendlyError(err), "err");
      stopWatching();
      if (isPermissionDenied(err)) reassertRole();
    }
  );
}

export function stopWatching() {
  if (S.unwatchBoard) { try { S.unwatchBoard(); } catch (_) {} S.unwatchBoard = null; }
  if (S.applyFrame) { cancelAnimationFrame(S.applyFrame); S.applyFrame = 0; }
  S.pendingRemote = null;
}

// Snapshots QUEUE rather than drop: a listener has no next tick, so a change
// skipped because the UI was busy would never be seen again. Applying one under
// a bar the user is holding would yank it off the cursor, hence the wait.
//
// The frame coalesces a burst of teammate saves into one chart rebuild, and gets
// the merge out of the snapshot callback, where a throw has nowhere to go.
export function applyPendingRemote() {
  if (!S.pendingRemote || !boardOpen() || !S.cloudReady) return false;
  if (uiBusy() || S.savePromise) return false;
  if (S.applyFrame) return false;   // already queued for this frame
  S.applyFrame = requestAnimationFrame(() => {
    S.applyFrame = 0;
    const remote = S.pendingRemote;
    S.pendingRemote = null;
    if (!remote || !isNewer(remote)) return;               // superseded, or already adopted
    if (uiBusy() || S.savePromise) { S.pendingRemote = remote; return; } // became busy inside the frame
    try {
      adoptRemote(remote);
    } catch (err) {
      setSync("err");
      setCloudStatus("Couldn't apply a teammate's change: " + friendlyError(err), "err");
    }
  });
  return true;
}

// Release the queue when an interaction ends. Window-level rather than a call
// from each UI module because sync.js -> render/index.js -> render/chart.js ->
// ui/interactions.js already exists, so importing sync.js back into
// interactions.js / editor.js / groupEditor.js would close a module-evaluation
// cycle — the same hazard reassertRole() dodges with a lazy import.
//
// setTimeout(0) so this runs after every synchronous handler for the event,
// whatever order the listeners were bound in: S.dragging is already false and
// the overlay already closed. pointerup covers a drag, click a modal button,
// keyup Escape.
const recheckPending = () => setTimeout(applyPendingRemote, 0);
window.addEventListener("pointerup", recheckPending);
window.addEventListener("click", recheckPending);
window.addEventListener("keyup", recheckPending);

// Only ever clears S.offline; never sets it. A listener's FIRST snapshot comes
// from the persistent cache with fromCache=true even when perfectly online, so
// treating that as a disconnection would blip "offline" on every board open.
function noteConnectivity(meta) {
  if (meta.fromCache || !S.offline) return;
  retryAfterReconnect();
}

function retryAfterReconnect() {
  if (!S.offline) return;
  S.offline = false;
  if (S.dirty && canEdit() && boardOpen()) flushSave();
  else setSync("ok");
}

// A belt for noteConnectivity's braces: that only fires while a listener is
// attached, and one can have stopped or never attached. navigator.onLine is
// optimistic, which is fine — the worst case is one failed save attempt.
window.addEventListener("online", retryAfterReconnect);

// Returns true if something new was pulled in.
export async function syncFromRemote() {
  const remote = await backend.loadBoard(S.ws.boardId);
  if (!isNewer(remote)) return false;
  return adoptRemote(remote);
}

// Also the self-echo filter: saveToCloud stamps S.loadedAt with the same client
// ms it wrote, so our own write comes back equal and is dropped here. Nothing
// else needs to filter it.
function isNewer(remote) {
  return !!(remote && remote.updatedAt && remote.updatedAt > S.loadedAt);
}

// One merge policy, shared by the manual pull and the live listener.
function adoptRemote(remote) {
  // Normalize up front so base, local and remote all are: eq() is
  // JSON.stringify and therefore key-order sensitive, so an unnormalized remote
  // (a hand-written board:import) would read as "every field changed".
  const rdata = normalize(remote.data);
  if (S.dirty) {
    const merged = merge3(S.baseState || rdata, S.state, rdata);
    S.suppressAutosave = true; S.state = normalize(merged); preserveAndRender(); S.suppressAutosave = false;

    // The ancestor is the REMOTE we reconciled against, never the merge result.
    // Using the merge result put our own unsaved edits into the ancestor, so the
    // next pull saw base and local agreeing, concluded only the remote had
    // changed, and silently replaced our edited task with the server's older
    // copy. Covered by tools/ui-test/cases/sync.js.
    S.baseState = clone(rdata);
    S.loadedAt = remote.updatedAt;
    scheduleCloudSave();   // owns setSync("pending"), and knows if a save is due
  } else {
    S.suppressAutosave = true; S.state = rdata; preserveAndRender(); S.suppressAutosave = false;
    S.baseState = clone(S.state); S.loadedAt = remote.updatedAt; S.cloudReady = true;
    setSync("ok");
  }
  return true;
}

// The listener already delivered anything that changed while we were away, so
// this survives for a reason independent of sync: it re-renders for the current
// wall clock, and a day may have passed in the background, which moves the today
// marker and every date-derived progress bar.
//
// Switching back fires both `visibilitychange` and `focus`, so coalesce them.
let activateTimer = null;
export function refreshOnActivate() {
  if (activateTimer) return; // a refresh is already queued from the paired event
  activateTimer = setTimeout(async () => {
    activateTimer = null;
    if (uiBusy() || S.savePromise) return; // don't disturb active work / an in-flight save
    if (boardOpen() && S.cloudReady && !S.unwatchBoard) {
      // The listener died, so fall back to a one-shot read rather than nothing.
      try { await syncFromRemote(); } catch (_) { /* 🔄 and the next activate retry */ }
    } else {
      applyPendingRemote(); // flush anything that landed while a modal was open
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
