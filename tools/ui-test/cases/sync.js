// ---------------------------------------------------------------------------
// Live sync cases: the merge ancestor, the self-echo filter, and the queue that
// keeps a remote change from landing mid-drag.
//
// Import from ../harness.js, NEVER from ../suite.js — see the note at the top
// of harness.js. And note the ../../../ on app imports: this file is one level
// deeper than suite.js, so the repo root is three up, not two.
//
// Scope: the parts of src/sync.js with a decision in them. What CANNOT be
// covered here is anything the stub replaces — that a Firestore transaction
// really is atomic, that the `rev` rule really rejects a stale write, and that
// an offline transaction really fails instead of queueing. Those need a real
// server and live in tools/live-test/.
// ---------------------------------------------------------------------------
import { ck, note, sleep, S, setup, watch, calls } from "../harness.js";
import { backend } from "../../../src/backend/backend.js";
import { markDirty, clearDirty } from "../../../src/state.js";

const sync = await import("../../../src/sync.js");

// A board with two tasks in two different states, so a merge has something to
// disagree about. `rev`/updatedAt are the only version machinery sync.js reads.
function board(tasks, settings) {
  return {
    version: 1,
    settings: settings || { viewMode: "week" },
    groups: [{ id: "g1", name: "Group", color: "#5c9ded" }],
    tasks: tasks
  };
}
const task = (id, name, start) => ({
  id, name, groupId: "g1", start, end: start,
  deps: [], isMilestone: false, description: "", owner: "",
  parentId: null, checkpoints: []
});

// Drive one snapshot through the listener and wait for applyPendingRemote's
// requestAnimationFrame to run it. Two frames of slack: the first is the one
// applyPendingRemote schedules, the second gives the render inside it room.
async function emit(data, updatedAt, meta) {
  watch.emit({ data, updatedAt }, meta);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await sleep(0);
}

const nameOf = (id) => (S.state.tasks.find((t) => t.id === id) || {}).name;
const startOf = (id) => (S.state.tasks.find((t) => t.id === id) || {}).start;

// ===========================================================================
// The listener is attached at all
// ===========================================================================
await setup("admin");
ck("sync: loadFromCloud attached a listener", watch.active, true);
ck("sync: listener points at the open board", watch.boardId, S.ws.boardId);

// ===========================================================================
// Clean adoption
// ===========================================================================
S.loadedAt = 10;
S.baseState = board([task("t1", "One", "2026-03-01")]);
S.state = board([task("t1", "One", "2026-03-01")]);
clearDirty();

await emit(board([task("t1", "One renamed", "2026-03-01")]), 11);
ck("clean: a newer remote version is adopted", nameOf("t1"), "One renamed");
ck("clean: loadedAt advances to the adopted version", S.loadedAt, 11);
ck("clean: still clean afterwards", S.dirty, false);

// An OLDER version must not be adopted — out-of-order delivery would otherwise
// roll the board backwards.
await emit(board([task("t1", "Stale", "2026-03-01")]), 5);
ck("clean: an older remote version is ignored", nameOf("t1"), "One renamed");

// ===========================================================================
// Self-echo: our own write must not come back as news
// ===========================================================================
await emit(board([task("t1", "Echo", "2026-03-01")]), 11);
ck("echo: a snapshot at loadedAt is ignored", nameOf("t1"), "One renamed");

// hasPendingWrites is our own unacknowledged write. Even with a NEWER stamp it
// must be skipped, because S.state already contains it by definition.
await emit(board([task("t1", "Unacked", "2026-03-01")]), 12, { fromCache: false, hasPendingWrites: true });
ck("echo: a snapshot with hasPendingWrites is ignored", nameOf("t1"), "One renamed");
ck("echo: loadedAt not advanced by our own pending write", S.loadedAt, 11);

// ===========================================================================
// THE REGRESSION THIS WHOLE CHANGE EXISTS FOR
//
// Two remote changes arriving between autosaves used to revert a local edit.
// The old code set S.baseState to the MERGE RESULT, which put our own unsaved
// edit into the common ancestor; the next merge then saw the ancestor and the
// local copy agreeing, concluded only the remote had changed, and took theirs.
//
// This asserts the ancestor is the remote we reconciled against instead. It
// FAILS on the pre-fix sync.js, which is the point of having it.
// ===========================================================================
S.loadedAt = 20;
S.state = board([task("t1", "One", "2026-03-01"), task("t2", "Two", "2026-03-02")]);
S.baseState = board([task("t1", "One", "2026-03-01"), task("t2", "Two", "2026-03-02")]);
clearDirty();

// Our local edit to t1, not yet saved.
S.state.tasks.find((t) => t.id === "t1").name = "One MINE";
markDirty();
ck("regression: local edit is dirty", S.dirty, true);

// Remote change #1 — a teammate touches t2 only, and knows nothing of our t1.
await emit(board([task("t1", "One", "2026-03-01"), task("t2", "Two THEIRS", "2026-03-02")]), 21);
ck("regression: after pull 1, our edit survives", nameOf("t1"), "One MINE");
ck("regression: after pull 1, their edit is in", nameOf("t2"), "Two THEIRS");

// Remote change #2 — they touch t2 again. Still nothing about our t1, which is
// exactly the shape that used to destroy it.
await emit(board([task("t1", "One", "2026-03-01"), task("t2", "Two THEIRS AGAIN", "2026-03-02")]), 22);
ck("regression: after pull 2, OUR EDIT STILL SURVIVES", nameOf("t1"), "One MINE");
ck("regression: after pull 2, their newer edit is in", nameOf("t2"), "Two THEIRS AGAIN");
ck("regression: still dirty, so autosave will push the merge", S.dirty, true);

// The ancestor must be the remote, not the merge result. Checked directly
// because it is the actual invariant — the assertions above are its symptom.
ck("regression: baseState holds THEIR t1, not ours",
   (S.baseState.tasks.find((t) => t.id === "t1") || {}).name, "One");
ck("regression: baseState holds their latest t2",
   (S.baseState.tasks.find((t) => t.id === "t2") || {}).name, "Two THEIRS AGAIN");

// ===========================================================================
// Deferral: snapshots queue rather than drop
// ===========================================================================
S.loadedAt = 30;
S.state = board([task("t1", "Before", "2026-03-01")]);
S.baseState = board([task("t1", "Before", "2026-03-01")]);
clearDirty();

S.dragging = true;
await emit(board([task("t1", "During drag", "2026-03-01")]), 31);
ck("defer: nothing applied while dragging", nameOf("t1"), "Before");
ck("defer: the snapshot is QUEUED, not dropped", !!S.pendingRemote, true);
ck("defer: loadedAt unchanged while queued", S.loadedAt, 30);

// A second snapshot while still busy supersedes the first — the newest wins,
// and the intermediate one must not be applied on top of it afterwards.
await emit(board([task("t1", "Also during drag", "2026-03-01")]), 32);
ck("defer: still nothing applied", nameOf("t1"), "Before");

// Release. The window-level pointerup listener in sync.js is what resumes this
// in the real app; dispatching the event is the honest way to test that wiring
// rather than calling applyPendingRemote directly.
S.dragging = false;
window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
await new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 10));

ck("defer: pointerup applies the queued snapshot", nameOf("t1"), "Also during drag");
ck("defer: only the NEWEST queued version landed", S.loadedAt, 32);
ck("defer: queue is empty afterwards", S.pendingRemote, null);

// ===========================================================================
// Deferral also respects an open modal
// ===========================================================================
const { openEditor, closeEditor } = await import("../../../src/ui/editor.js");
S.loadedAt = 40;
S.state = board([task("t1", "Editing", "2026-03-01")]);
S.baseState = board([task("t1", "Editing", "2026-03-01")]);
clearDirty();

openEditor("t1");
await emit(board([task("t1", "Changed under the editor", "2026-03-01")]), 41);
ck("defer: nothing applied with the editor open", nameOf("t1"), "Editing");
ck("defer: queued behind the editor", !!S.pendingRemote, true);

closeEditor();
window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
await new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 10));
ck("defer: closing the editor releases the queue", nameOf("t1"), "Changed under the editor");

// ===========================================================================
// Save: the merge runs inside the write, via reconcile()
// ===========================================================================
S.loadedAt = 50;
S.state = board([task("t1", "Mine", "2026-03-01"), task("t2", "Theirs base", "2026-03-02")]);
S.baseState = board([task("t1", "Mine base", "2026-03-01"), task("t2", "Theirs base", "2026-03-02")]);
markDirty();

// Stand in for a server that moved between load and write: saveBoard hands the
// remote to reconcile and returns whatever comes back, exactly as the real
// transaction does on a re-run.
let sawReconcile = false;
backend.saveBoard = async (id, data, reconcile) => {
  sawReconcile = typeof reconcile === "function";
  const remote = board([task("t1", "Mine base", "2026-03-01"), task("t2", "Theirs NEW", "2026-03-02")]);
  return { updatedAt: 51, state: reconcile(remote, 51) };
};

await sync.saveToCloud();
ck("save: the backend was handed a reconcile callback", sawReconcile, true);
ck("save: our unsaved edit is in what landed", nameOf("t1"), "Mine");
ck("save: their concurrent edit is in what landed", nameOf("t2"), "Theirs NEW");
ck("save: loadedAt is the committed version", S.loadedAt, 51);
ck("save: clean after a successful save", S.dirty, false);
ck("save: baseState is what we committed",
   (S.baseState.tasks.find((t) => t.id === "t2") || {}).name, "Theirs NEW");

// A save against an UNMOVED server must not churn. reconcile returns S.state by
// identity in that case, so saveToCloud skips the re-render — otherwise every
// autosave rebuilt the whole chart on the 5s timer while someone was typing.
S.loadedAt = 55;
S.state = board([task("t1", "Unchanged", "2026-03-01")]);
S.baseState = board([task("t1", "Unchanged", "2026-03-01")]);
markDirty();
const before = S.state;
backend.saveBoard = async (id, data, reconcile) => {
  // Same updatedAt the caller already descends from — nothing new landed.
  return { updatedAt: 56, state: reconcile(board([task("t1", "Unchanged", "2026-03-01")]), 55) };
};
await sync.saveToCloud();
ck("save: an unmoved server returns S.state by identity", S.state === before, true);

// A permission-denied save retries before believing the denial: a lost `rev`
// race and a revoked role are the same error code (see SAVE_RETRY_MAX).
let attempts = 0;
backend.saveBoard = async (id, data, reconcile) => {
  attempts++;
  if (attempts < 3) throw Object.assign(new Error("nope"), { code: "permission-denied" });
  return { updatedAt: 60, state: data };
};
S.state = board([task("t1", "Retry me", "2026-03-01")]);
S.baseState = board([task("t1", "Retry me", "2026-03-01")]);
markDirty();
await sync.saveToCloud();
ck("save: a lost rev race is retried, not surfaced", attempts, 3);
ck("save: the retry succeeded and cleared dirty", S.dirty, false);

// An offline save keeps the edits and marks itself offline rather than
// reporting an error — nothing is lost and no action is needed.
backend.saveBoard = async () => {
  throw Object.assign(new Error("offline"), { code: "unavailable" });
};
S.state = board([task("t1", "Unsent", "2026-03-01")]);
S.baseState = board([task("t1", "Unsent", "2026-03-01")]);
markDirty();
await sync.saveToCloud();
ck("offline: edits are KEPT, dirty stays set", S.dirty, true);
ck("offline: the dot says offline, not error", S.syncState, "offline");
ck("offline: S.offline is set for the reconnect retry", S.offline, true);

// The listener seeing a server-confirmed snapshot is the reconnect signal.
let resaved = false;
backend.saveBoard = async (id, data) => { resaved = true; return { updatedAt: 70, state: data }; };
watch.emit({ data: S.state, updatedAt: 1 }, { fromCache: false, hasPendingWrites: false });
await sleep(30);
ck("offline: a server-confirmed snapshot triggers the retry", resaved, true);
ck("offline: S.offline cleared after reconnect", S.offline, false);

// A cache-only snapshot must NOT be read as a reconnect — the first snapshot of
// every listener arrives fromCache even when perfectly online.
S.offline = true;
resaved = false;
backend.saveBoard = async (id, data) => { resaved = true; return { updatedAt: 80, state: data }; };
watch.emit({ data: S.state, updatedAt: 1 }, { fromCache: true, hasPendingWrites: false });
await sleep(30);
ck("offline: a fromCache snapshot is not a reconnect", resaved, false);
ck("offline: still offline after a cache-only snapshot", S.offline, true);
S.offline = false;

// ===========================================================================
// Teardown
// ===========================================================================
sync.stopWatching();
ck("teardown: stopWatching unsubscribes", watch.active, false);
ck("teardown: the queue is dropped too", S.pendingRemote, null);

note("sync: transaction atomicity, the rev rule and real offline behaviour are tools/live-test/");
