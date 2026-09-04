// ---------------------------------------------------------------------------
// Cloud sync orchestration (backend-agnostic).
//
// Sits ON TOP OF the storage backend. The backend only loads/saves/watches
// documents; this module adds the behavior shared by every backend:
//   - autosave debouncing (idle + max-interval)
//   - the 3-way merge policy, handed to the backend as a `reconcile` callback
//     so the merge runs INSIDE the write's transaction
//   - live remote updates, queued so they never land mid-drag
//   - manual refresh, refresh-on-activate, retry-on-reconnect
//   - the ☁ status dot
//
// WHAT REPLACED WHAT, since two mechanisms here look like the ones they retired:
//
//   poll-before-write → a transaction. saveToCloud() used to read the board,
//   merge, then write. That is a TOCTOU: two clients could both read version N,
//   both merge and both write, and the second silently discarded the first's
//   merge with no error shown to anyone. The read and the merge now happen
//   inside runTransaction, which re-runs them on contention. merge3 is pure,
//   so re-running it is free.
//
//   5s setInterval polling → onSnapshot. Polling billed one read per tick per
//   tab whether or not anything had changed, which is why it shipped disabled
//   (POLL_ENABLED = false) and nobody ever saw a teammate's edit without
//   pressing 🔄. A listener bills one read per change actually delivered.
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
  // dot color: grey idle, amber pending/syncing, green ok, red error,
  // slate "offline" — a state the dot could not express before. It is NOT an
  // error (nothing is lost and no action is needed) and it is NOT pending
  // (nothing will happen until the connection returns), so reusing either one
  // was misleading in a way that mattered: amber says "wait", red says "act",
  // and the honest answer is "your work is here, we'll send it when we can".
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
  // This function owns the listener's whole lifecycle. Detaching up front — not
  // just re-attaching on success — means a load that FAILS leaves nothing
  // attached, rather than a listener still pointed at the previous board that
  // goes on billing reads for a board the user has navigated away from.
  stopWatching();
  setSync("syncing"); setCloudStatus("Loading " + boardName() + "…", "");
  try {
    const u = await backend.loadBoard(S.ws.boardId);
    if (!u) { // empty board — nothing to load yet
      S.baseState = clone(S.state); S.loadedAt = 0; S.cloudReady = true;
      // Still watch it: "empty" means nobody has saved yet, and a teammate
      // populating it is exactly the change we want to see arrive.
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
    // Attach the live listener HERE rather than at each call site. This is the
    // one function that establishes S.loadedAt and S.baseState, so openWorkspace,
    // switchBoard and newBoard all get a listener pointed at the right board
    // without having to remember to ask. startWatching() detaches first, so
    // switching boards cannot leave the old board's listener running.
    startWatching();
    setSync("ok"); setCloudStatus("Loaded " + boardName(), "ok");
    toast("Loaded from cloud ✓");
  } catch (err) {
    setSync("err"); setCloudStatus("Load failed: " + friendlyError(err), "err");
    toast("Couldn't load the board: " + friendlyError(err));
    render(); // show whatever we have so the board isn't stuck behind the loading veil
  }
}

// The conflict policy, handed to the backend so it can run INSIDE the write's
// transaction. Pure apart from reading S.baseState: given whatever the server
// holds right now, return the document we should write.
//
// It must stay re-runnable. runTransaction re-invokes its callback — and
// therefore this — whenever the document changed under it, so anything that
// mutated S.state or touched the DOM here would run an unpredictable number of
// times. Adopting the merge result into S.state is the CALLER's job, once, after
// the transaction has actually committed.
function reconcile(remoteData, remoteUpdatedAt) {
  // Nothing has landed on the server since we loaded, so our state already
  // descends from exactly this version and there is nothing to merge.
  //
  // Returning S.state BY IDENTITY is the point, not an optimisation of the
  // merge: saveToCloud only re-renders when what came back differs from what it
  // sent, and merge3 always allocates. Without this, every autosave produced a
  // structurally-identical-but-new object and cost a full chart rebuild — on the
  // 5s idle timer, for as long as someone kept typing. This is the same
  // `remote.updatedAt !== S.loadedAt` gate the old poll-before-write had, moved
  // to where the merge now happens.
  if (remoteUpdatedAt && remoteUpdatedAt === S.loadedAt) return S.state;
  const rdata = normalize(remoteData);   // normalize once; see adoptRemote() for why at all
  return normalize(merge3(S.baseState || rdata, S.state, rdata));
}

// Save the whole board, merging in anything a teammate changed. Used by autosave
// (debounced) and by "Save now" / ⌘S.
//
// The read-merge-write is one transaction now (see the header). saveBoard() calls
// reconcile() above from inside it, so there is no longer a window in which two
// clients can both read, both merge, and have the second silently overwrite the
// first. `firestore.rules` additionally requires rev == resource.rev + 1, which
// catches a writer the transaction cannot see — a stale tab on an older build.
export async function saveToCloud() {
  if (!boardOpen()) return;
  if (S.savePromise) { S.saveAgain = true; return S.savePromise; } // coalesce overlapping saves
  setSync("syncing");
  S.savePromise = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        // `state` is what actually landed — the transaction may have re-run and
        // merged, so it is NOT necessarily the S.state we passed in.
        const { updatedAt, state } = await backend.saveBoard(S.ws.boardId, S.state, reconcile);
        if (state !== S.state) {
          S.suppressAutosave = true;
          S.state = state;
          preserveAndRender();
          S.suppressAutosave = false;
        }
        S.loadedAt = updatedAt;      // also the self-echo filter — see isNewer()
        S.baseState = clone(S.state);
        S.offline = false;
        clearDirty();
        setSync("ok"); setCloudStatus("Saved " + boardName(), "ok");
        return;
      } catch (err) {
        // A lost rev race and a genuine role change BOTH surface as
        // permission-denied and cannot be told apart without re-reading. So
        // retry a bounded number of times first: a lost race succeeds on the
        // next attempt against the fresh rev, while a real role change fails
        // every time and falls through to handleWriteError, which re-reads the
        // role. Unbounded retry would spin forever on the role change.
        if (isPermissionDenied(err) && attempt < SAVE_RETRY_MAX) continue;
        handleWriteError(err);
        return;
      }
    }
  })();
  try {
    await S.savePromise;
  } finally {
    // MUST be cleared in a finally: the coalescing guard above returns early
    // whenever S.savePromise is set, so leaving it set on a failure path wedges
    // autosave permanently and leaves a beforeunload warning the user can never
    // clear. That used to be reachable via Firestore's offline behaviour (a
    // plain updateDoc never settles offline); a transaction fails fast instead,
    // but the finally stays because the invariant is what matters, not the
    // particular way it was once violated.
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
    // Role change. Stop autosaving — every further attempt can only be rejected
    // — and re-read the role so the UI stops offering edits it can't make.
    setSync("err");
    clearTimeout(S.autosaveTimer); S.autosaveTimer = null; S.firstDirtyAt = 0;
    toast("Your access to this workspace changed — your edits are still here, but can't be saved");
    reassertRole();
    return;
  }
  if (isOffline(err)) {
    // THE ONLY place S.offline is set. A transaction needs a server round trip,
    // so unlike a plain updateDoc it fails instead of queueing — which is the
    // point: a queued write commits later with a board that was merged against
    // a version now minutes stale, overwriting whatever landed in between.
    //
    // Keep the edits, keep S.dirty, say so plainly, and let noteConnectivity()
    // retry the moment the listener sees the server answer again. The autosave
    // timer is deliberately NOT cancelled here: further edits should keep
    // re-arming it, so a save is already due whenever the connection returns.
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

// Attach the live listener to the currently open board. Called from
// loadFromCloud(), which is the one place that establishes S.loadedAt and
// S.baseState — so openWorkspace, switchBoard and newBoard all get a listener
// without each having to remember to ask for one. Re-entrant: it detaches first.
export function startWatching() {
  stopWatching();
  if (!boardOpen()) return;
  const boardId = S.ws.boardId;
  S.unwatchBoard = backend.watchBoard(
    boardId,
    (remote, meta) => {
      // Guard against a snapshot for a board we have since left. unsubscribe()
      // makes this very unlikely, but it is not documented to be synchronous,
      // and adopting another board's content into this one would be both
      // catastrophic and completely silent.
      if (boardId !== S.ws.boardId) return;
      noteConnectivity(meta);
      // Our own write, not yet acknowledged. isNewer() would drop it a moment
      // later anyway (saveToCloud stamps S.loadedAt with the same client ms it
      // wrote), but skipping it here avoids a pointless rAF and re-render.
      if (meta.hasPendingWrites) return;
      if (!isNewer(remote)) return;
      S.pendingRemote = remote;   // latest wins — supersede any earlier one
      applyPendingRemote();
    },
    (err) => {
      // A listener error is TERMINAL — Firestore does not re-establish it. The
      // overwhelmingly likely cause is permission-denied because this user's
      // role changed while the tab was open, which is the same situation
      // handleWriteError() already knows how to explain.
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

// Remote snapshots QUEUE — they do not drop.
//
// The old pollTick just returned early while the UI was busy, which was safe
// only because another tick was 5s behind it. A listener has no next tick: the
// change has already been delivered, and dropping it means never seeing it. So
// the newest pending snapshot is held and applied at the next safe moment.
//
// "Safe" is meant literally. Swapping S.state under a bar the user is holding
// yanks it out from under the cursor, and a re-render with the task editor open
// rebuilds the DOM under a form somebody is typing into.
export function applyPendingRemote() {
  if (!S.pendingRemote || !boardOpen() || !S.cloudReady) return false;
  if (uiBusy() || S.savePromise) return false;
  if (S.applyFrame) return false;   // already queued for this frame
  // Coalesce a burst of teammate saves into ONE re-render: adoptRemote() calls
  // preserveAndRender(), a full chart rebuild, and three changes landing in the
  // same frame should not cost three of them. This also gets the merge out of
  // the Firestore snapshot callback, where a throw has nowhere to go.
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

// Re-check whenever an interaction could have ENDED a busy period.
//
// Deliberately window-level rather than a call from each UI module, for one
// hard reason and one soft one. Hard: sync.js -> render/index.js ->
// render/chart.js -> ui/interactions.js already exists, so importing sync.js
// back into interactions.js / editor.js / groupEditor.js would close a cycle at
// module-evaluation time — the same hazard reassertRole() above uses a lazy
// import to dodge. Soft: an explicit call site is one someone can forget when
// they add a fourth kind of overlay, and the failure mode is a teammate's edit
// that never appears.
//
// setTimeout(0) rather than handling the event directly: it runs after every
// synchronous handler for that event, so S.dragging is already false and the
// overlay is already closed no matter what order the listeners were bound in.
// pointerup covers drag/resize release, click covers a modal dismissed by its
// button, keyup covers Escape. applyPendingRemote() is a cheap no-op when there
// is nothing queued, which is almost always.
const recheckPending = () => setTimeout(applyPendingRemote, 0);
window.addEventListener("pointerup", recheckPending);
window.addEventListener("click", recheckPending);
window.addEventListener("keyup", recheckPending);

// Track whether the server is actually answering, so a save that failed on a
// network error can be retried the moment it comes back.
//
// NOTE what this does NOT do: flip a user-visible "offline" state off
// meta.fromCache. The FIRST snapshot of a listener is served from the persistent
// cache with fromCache=true even when perfectly online, so treating that edge as
// a disconnection would show a spurious offline blip on every board open.
// S.offline is set in exactly one place — handleWriteError(), when a write
// actually fails with a network code — and cleared here.
function noteConnectivity(meta) {
  if (meta.fromCache || !S.offline) return;
  retryAfterReconnect();
}

function retryAfterReconnect() {
  if (!S.offline) return;
  S.offline = false;
  if (S.dirty && canEdit() && boardOpen()) flushSave();   // the server is back; push what's waiting
  else setSync("ok");
}

// A belt to go with noteConnectivity's braces.
//
// The listener is the primary reconnect signal and the better one — it fires
// when Firestore itself has re-established the stream, which is what actually
// determines whether a transaction can commit. But it only fires while a
// listener is attached, and a listener can have stopped (its error path is
// terminal) or never been attached at all if the board load was what failed. In
// either of those states an offline save would sit unsent until the user
// happened to edit something else.
//
// navigator.onLine is famously optimistic — it says "an interface is up", not
// "the server is reachable" — which is fine here: the worst case is one save
// attempt that fails and puts us straight back into the offline state.
window.addEventListener("online", retryAfterReconnect);

// Returns true if something new was pulled in.
export async function syncFromRemote() {
  const remote = await backend.loadBoard(S.ws.boardId);
  if (!isNewer(remote)) return false; // nothing new
  return adoptRemote(remote);
}

// The one place that decides whether a remote version is worth adopting. Also
// the self-echo filter: saveBoard() stamps the same client ms it wrote into
// S.loadedAt (src/backend/firestore.js, src/sync.js flushSaved), so our OWN
// write comes back with updatedAt === S.loadedAt and is dropped here. Nothing
// else needs to filter it — resist adding a second check.
function isNewer(remote) {
  return !!(remote && remote.updatedAt && remote.updatedAt > S.loadedAt);
}

// Fold a remote version into the local one. Shared by the manual/activate pull
// above and by the live listener, so there is exactly one merge policy.
function adoptRemote(remote) {
  // Normalize the remote ONCE, up front, and merge against that copy rather
  // than the raw payload. base, local and remote are then all normalized —
  // which matters because eq() is JSON.stringify (src/merge.js) and therefore
  // key-ORDER sensitive. A board written by something that didn't normalize
  // first (a tools/admin `board:import` of hand-written JSON) would otherwise
  // read as "every field changed" against a normalized base and lose the merge.
  const rdata = normalize(remote.data);
  if (S.dirty) {
    // we have local edits — merge remote in, then let autosave push the result
    const merged = merge3(S.baseState || rdata, S.state, rdata);
    S.suppressAutosave = true; S.state = normalize(merged); preserveAndRender(); S.suppressAutosave = false;

    // THE ANCESTOR IS THE REMOTE WE JUST RECONCILED AGAINST, never the merge
    // result. This used to be `clone(S.state)`, which put our own UNSAVED edits
    // into the common ancestor — so on the next pull mergeList() saw
    // `lc = !eq(base[id], local[id])` → false for every task we had edited but
    // not yet saved, `rc` → true (the server still holds the old value), took
    // the `if (rc && !lc) return clone(r[id])` branch, and silently replaced
    // our edited task with the server's older copy.
    //
    // It was survivable while pulls were rare and manual. It is not survivable
    // with a live listener, which pulls constantly — two remote changes
    // arriving between autosaves was enough to revert an edit with no error
    // and no way for the user to know. Covered by tools/ui-test/cases/sync.js.
    S.baseState = clone(rdata);
    S.loadedAt = remote.updatedAt;
    scheduleCloudSave();   // owns setSync("pending"), and knows whether a save is really due
  } else {
    // clean — just adopt the remote version
    S.suppressAutosave = true; S.state = rdata; preserveAndRender(); S.suppressAutosave = false;
    S.baseState = clone(S.state); S.loadedAt = remote.updatedAt; S.cloudReady = true;
    setSync("ok");
  }
  return true;
}
// Refresh when the app becomes active again (tab selected / window refocused).
//
// The listener has already delivered anything that changed while we were away,
// so this is no longer the pull it used to be — but it stays for the reason that
// was always independent of sync: it RE-RENDERS for the current wall clock, and
// a day (or more) may have elapsed while the tab sat in the background, which
// moves the "today" marker and every date-derived progress bar. It also flushes
// any snapshot that arrived while a modal was open.
//
// Switching back fires both `visibilitychange` (→ visible) and `focus`, so
// coalesce them into one hit.
let activateTimer = null;
export function refreshOnActivate() {
  if (activateTimer) return; // a refresh is already queued from the paired event
  activateTimer = setTimeout(async () => {
    activateTimer = null;
    if (uiBusy() || S.savePromise) return; // don't disturb active work / an in-flight save
    if (boardOpen() && S.cloudReady && !S.unwatchBoard) {
      // No live listener — it errored out and stopped itself (see startWatching).
      // Fall back to the one-shot read this function used to do unconditionally,
      // so a dead listener degrades to the old refresh-on-activate behaviour
      // instead of to nothing at all.
      try { await syncFromRemote(); } catch (_) { /* transient; 🔄 and the next activate retry */ }
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
