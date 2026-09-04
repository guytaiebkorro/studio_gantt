// ---------------------------------------------------------------------------
// Firestore storage backend — PURE TRANSPORT.
//
// Loads and saves board documents and the workspace record. It knows nothing
// about merging, autosave debouncing or polling; those live in src/sync.js and
// apply to every backend equally.
//
// Replaces jsonbin.js. Two things from that adapter are GONE, not ported:
// discoverRegistryId() and createRegistry(). Both existed only because JSONBin
// has no concept of a user, so the app had to find "its" bin by sniffing content
// shape. Here the workspace id comes from the signed-in user's member document,
// and workspaces are provisioned exclusively by tools/admin — firestore.rules
// denies /workspaces create to every client.
//
// THE BOARD PAYLOAD IS A JSON STRING, not a nested map. Three reasons:
//   1. Firestore auto-indexes every field, including every field of every map
//      inside an array. data.tasks would generate ~20 index entries per task
//      and hit the hard 40,000-entries-per-document cap at roughly 2,000 tasks,
//      at which point the write is REJECTED — long before the 1 MiB document
//      limit is near. (firestore.indexes.json exempts this collection group
//      anyway; the string makes it moot.)
//   2. Firestore rejects `undefined` outright. JSON.stringify drops it, so the
//      board round-trips exactly and normalize()/merge3() need no changes.
//   3. We only ever read and write the whole board atomically. There is no
//      query into board contents that we are giving up.
//
// WHY THERE IS NO putRegistry(name, boards): firestore.rules lets an EDITOR
// change the workspace's `boards` index but only an ADMIN change its `name`.
// A single call that always wrote both would have every editor's board-create
// rejected with permission-denied. So the two are separate operations that map
// exactly onto the two permissions.
// ---------------------------------------------------------------------------
import {
  db, doc, collection, getDoc, setDoc, updateDoc, onSnapshot, runTransaction, serverTimestamp
} from "../firebase/app.js";
import { auth } from "../firebase/app.js";

// Mirrors the cap in firestore.rules. See encodeBoard() for why it is checked
// here at all rather than left to the server.
const MAX_BOARD_BYTES = 900000;

// A write that never settles is worse than one that fails: a plain updateDoc
// does not reject when offline, it queues indefinitely, and sync.js coalesces on
// an in-flight save promise — so without a deadline one offline blip wedged
// autosave permanently.
//
// saveBoard no longer needs this: a transaction requires a server round trip and
// so fails on its own when offline. The other writers here — createBoardData,
// renameBoard, putBoards, putWorkspaceName — are still plain setDoc/updateDoc
// calls with the original hazard, and the deadline also caps a transaction that
// keeps losing its retries. So it stays, wrapping all of them.
const WRITE_TIMEOUT_MS = 20000;

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(label + " timed out — you may be offline"), { code: "deadline-exceeded" })),
      WRITE_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function uid() {
  const u = auth.currentUser;
  if (!u) throw Object.assign(new Error("Not signed in"), { code: "unauthenticated" });
  return u.uid;
}

// Serialize a board and refuse it if it exceeds the cap, with a message that
// says what to do — rather than letting the server reject the write and leaving
// sync.js to toast an opaque error forever while edits pile up unsaved.
function encodeBoard(state) {
  const json = JSON.stringify(state);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MAX_BOARD_BYTES) {
    throw new Error(
      `This board is too large to save (${Math.round(bytes / 1024)} KB of a ${Math.round(MAX_BOARD_BYTES / 1024)} KB limit). ` +
      "Split it into two boards."
    );
  }
  return json;
}

// One decoder for all three read paths — loadBoard, watchBoard and the read
// inside saveBoard's transaction. Deliberately shared: a board that a one-shot
// read calls corrupt and a listener calls empty would have the listener adopt
// an empty board and the next autosave overwrite the real one.
//
// Returns { data, updatedAt } or null when the board is missing/empty.
function parseBoardSnap(snap, boardId) {
  if (!snap.exists()) return null;
  const raw = snap.data();
  if (!raw || typeof raw.data !== "string" || !raw.data) return null;
  let data;
  try {
    data = JSON.parse(raw.data);
  } catch (err) {
    // Corrupt payload. Returning null would look like an empty board and the
    // next autosave would happily overwrite it — so fail loudly instead.
    throw new Error("This board's data is corrupt and cannot be read (id " + boardId + ")");
  }
  return { data, updatedAt: raw.updatedAt || 0, rev: typeof raw.rev === "number" ? raw.rev : 0 };
}

export class FirestoreBackend {
  constructor() {
    // Replaces jsonbin's apiKey + registryId. Just an id — never a credential.
    // Identity lives in Firebase Auth, not in this object.
    this.wsId = null;
  }

  _ws() {
    if (!this.wsId) throw Object.assign(new Error("No workspace selected"), { code: "failed-precondition" });
    return doc(db, "workspaces", this.wsId);
    }

  _board(boardId) {
    if (!boardId) throw Object.assign(new Error("No board selected"), { code: "failed-precondition" });
    return doc(db, "workspaces", this.wsId, "boards", boardId);
  }

  // --- board documents ------------------------------------------------------

  // Returns { data, updatedAt } or null when the board is missing/empty, which
  // is the same contract loadFromCloud() already handles.
  async loadBoard(boardId) {
    return parseBoardSnap(await getDoc(this._board(boardId)), boardId);
  }

  // Live board updates. Returns an unsubscribe function.
  //
  // Replaces the 5s setInterval poll in src/sync.js. Firestore bills 1 read per
  // document actually DELIVERED rather than 1 per tick, so this is both live and
  // strictly cheaper than the poll it replaces — which is why the poll shipped
  // disabled and this exists.
  //
  // `includeMetadataChanges: true` is REQUIRED, not a refinement. Without it the
  // listener stays silent when only the metadata moves — and the
  // fromCache true→false edge is exactly how sync.js learns it is back online
  // and can retry a save that failed while offline. Dropping this flag silently
  // breaks reconnect, not the happy path, so nothing you click will catch it.
  //
  // onChange receives (board, meta) where `board` is loadBoard()'s contract and
  // `meta` is { fromCache, hasPendingWrites }. A corrupt payload is reported
  // through onError rather than thrown, because a throw inside a snapshot
  // callback has nowhere to go.
  watchBoard(boardId, onChange, onError) {
    const ref = this._board(boardId);
    return onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        let board;
        try {
          board = parseBoardSnap(snap, boardId);
        } catch (err) {
          if (onError) onError(err);
          return;
        }
        onChange(board, {
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites
        });
      },
      (err) => { if (onError) onError(err); }
    );
  }

  // Save the board ATOMICALLY against whatever the server currently holds.
  //
  // `reconcile(remoteData, remoteUpdatedAt) -> mergedState` is supplied by the
  // caller (src/sync.js), so the conflict policy still lives above the backend
  // — this file has never imported merge.js and still doesn't. What changed is
  // WHERE that policy runs: inside the transaction, not before the write.
  //
  // The read-merge-write used to be three separate steps in sync.js, which is a
  // TOCTOU: two clients could both read version N, both merge, and both write,
  // and the second silently discarded the first's merge with nothing surfaced to
  // either user. runTransaction re-runs its callback when the document changed
  // underneath it, so the loser now merges again against the winner's result.
  //
  // Two consequences worth knowing before touching this:
  //   1. The callback CAN RUN SEVERAL TIMES. `reconcile` must therefore be pure
  //      — sync.js's version reads S.baseState and returns a value, and
  //      deliberately does not mutate S.state or render. The caller adopts the
  //      returned state once, after the commit.
  //   2. Transactions need a server round trip, so this FAILS when offline
  //      rather than queueing. That is the intended behaviour, not a regression:
  //      a queued updateDoc commits minutes later carrying a merge computed
  //      against a version long superseded, wiping out everything that landed in
  //      between — and because our own timeout had already reported "Save
  //      failed", nobody was watching for it. sync.js keeps the edits, marks
  //      itself offline, and retries when the listener sees the server again.
  async saveBoard(boardId, data, reconcile) {
    const ref = this._board(boardId);
    // Pre-flight, BEFORE the transaction opens. The authoritative check is the
    // one after the merge below, but doing it here too means an already-oversized
    // board fails without spending a document read — and it would otherwise spend
    // one every SAVE_IDLE_MS for as long as the user kept editing, since autosave
    // re-arms on every keystroke and each attempt would read then throw.
    encodeBoard(data);
    return withTimeout(runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        throw Object.assign(new Error("That board no longer exists"), { code: "not-found" });
      }
      const remote = parseBoardSnap(snap, boardId);
      // Fold in anything that landed since the caller last loaded. `remote` is
      // null for a board nobody has written yet, in which case there is nothing
      // to merge and `data` stands as-is.
      const state = (remote && reconcile) ? reconcile(remote.data, remote.updatedAt) : data;

      // Read `rev` from the RAW snapshot, not from `remote`. parseBoardSnap
      // returns null for a board whose payload is missing or empty, and that
      // says nothing about whether the document already carries a rev — writing
      // rev 1 over a rev 5 document would be rejected by the rule below and
      // then retried three times before surfacing as a permission error.
      const raw = snap.data() || {};
      const nextRev = (typeof raw.rev === "number" ? raw.rev : 0) + 1;

      // Re-checked AFTER the merge, because the merge can push a board that was
      // under the cap over it. The pre-flight check before the transaction has
      // already covered the common case without spending a read.
      const json = encodeBoard(state);

      // Client-side ms, deliberately: sync.js compares it against S.loadedAt to
      // decide whether a snapshot is news, and to recognise its own write coming
      // back from the listener. firestore.rules bounds it to request.time + 5min
      // so a bad clock can't pin every other client into "remote is always newer".
      const updatedAt = Date.now();
      tx.update(ref, {
        data: json,
        updatedAt,
        updatedAtServer: serverTimestamp(),   // rules pin this to request.time
        updatedBy: uid(),
        // Optimistic concurrency, enforced by firestore.rules
        // (`rev == resource.data.rev + 1`). Redundant against another client
        // running THIS code — the transaction already serialises those — but not
        // against a stale tab on an older build, which is exactly the writer a
        // transaction cannot see. A rejection arrives as permission-denied; see
        // SAVE_RETRY_MAX in src/config.js for why that needs a bounded retry.
        rev: nextRev
      });
      return { updatedAt, state };
    }), "Save");
  }

  // Create a board document. The caller is responsible for adding it to the
  // workspace's `boards` index (see putBoards) — newBoard() does both.
  async createBoardData(name, data) {
    const ref = doc(collection(db, "workspaces", this.wsId, "boards"));
    const who = uid();
    await withTimeout(
      setDoc(ref, {
        name: String(name || "Board").slice(0, 200),
        data: JSON.stringify(data),
        updatedAt: Date.now(),
        updatedAtServer: serverTimestamp(),
        updatedBy: who,
        rev: 0,
        createdAt: serverTimestamp(),
        createdBy: who,
        archived: false
      }),
      "Create board"
    );
    return { id: ref.id };
  }

  // Keep the board document's own name in step with the denormalized index.
  // Two writes for one rename is the cost of denormalizing the index onto the
  // workspace document — which is what makes the board dropdown one read
  // instead of downloading every board's task list.
  //
  // NOTE: this must refresh updatedAtServer/updatedBy even though only the name
  // is changing. firestore.rules requires `updatedAtServer == request.time` on
  // EVERY board update, so a partial write that leaves the old timestamp in
  // place is rejected. That is deliberate — it guarantees the stamp always
  // reflects the last write — but it means every board mutation, however small,
  // has to re-stamp. Caught by the live adapter test.
  //
  // updatedAt (the client ms sync.js compares) is intentionally NOT bumped: the
  // board dropdown reads names from the workspace index, not from here, so a
  // rename is not a content change and shouldn't make peers re-sync the board.
  //
  // A TRANSACTION, AND IT HAS TO BE. `rev` is not decoration on saveBoard — the
  // rules now require `rev == resource.data.rev + 1` on EVERY board update, and
  // a rename is a board update. A plain updateDoc that left rev alone would be
  // rejected outright, so this has to read the current rev to increment it, and
  // reading-then-writing outside a transaction is the very race the rule exists
  // to catch. Exactly the trap described above for updatedAtServer, one field
  // over. Caught by the live adapter test.
  async renameBoard(boardId, name) {
    const ref = this._board(boardId);
    await withTimeout(runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        throw Object.assign(new Error("That board no longer exists"), { code: "not-found" });
      }
      const raw = snap.data() || {};
      tx.update(ref, {
        name: String(name || "Board").slice(0, 200),
        rev: (typeof raw.rev === "number" ? raw.rev : 0) + 1,
        updatedAtServer: serverTimestamp(),
        updatedBy: uid()
      });
    }), "Rename board");
  }

  // Boards are never deleted. The app has no delete-board action by design (see
  // the comment in src/boards.js) and firestore.rules denies it outright, so
  // this exists only to fail with an explanation rather than a raw rules error.
  async deleteBoardData() {
    throw new Error(
      "Boards can't be deleted — there's no version history to restore from and a " +
      "teammate's board would vanish under them. Rename it to retire it, or use " +
      "tools/admin to archive it."
    );
  }

  // --- the workspace record -------------------------------------------------

  // { name, boards: [{id, name}] }. `boards` is the board index, denormalized
  // onto the workspace document; it is byte-identical to the shape the app's
  // registry already used, so loadRegistry()/S.registry/renderBoardSelect() work
  // unchanged.
  async getRegistry() {
    const snap = await getDoc(this._ws());
    if (!snap.exists()) {
      // Either the workspace is gone or we were removed from it. The rules deny
      // reads identically in both cases, so we genuinely cannot tell which.
      throw Object.assign(
        new Error("That workspace doesn't exist, or you no longer have access to it"),
        { code: "not-found" }
      );
    }
    const w = snap.data();
    return {
      name: w.name || "",
      boards: Array.isArray(w.boards) ? w.boards.filter(b => b && b.id) : []
    };
  }

  // Editor-level: update the board index only.
  async putBoards(boards) {
    await withTimeout(updateDoc(this._ws(), { boards }), "Update board list");
  }

  // Admin-level: rename the workspace. Separate from putBoards because the
  // rules grant these to different roles — see the header note.
  async putWorkspaceName(name) {
    await withTimeout(updateDoc(this._ws(), { name: String(name || "").slice(0, 120) }), "Rename workspace");
  }
}
