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
  db, doc, collection, getDoc, setDoc, updateDoc, serverTimestamp
} from "../firebase/app.js";
import { auth } from "../firebase/app.js";

// Mirrors the cap in firestore.rules. Refuse locally with a message that says
// what to do, rather than letting the server reject the write and leaving
// sync.js to toast an opaque error forever while edits pile up unsaved.
const MAX_BOARD_BYTES = 900000;

// A write that never settles is worse than one that fails: Firestore does not
// reject when offline, it queues indefinitely, and sync.js coalesces on an
// in-flight save promise. Without a deadline one offline blip wedges autosave
// permanently.
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
    const snap = await getDoc(this._board(boardId));
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
    return { data, updatedAt: raw.updatedAt || 0 };
  }

  async saveBoard(boardId, data) {
    const json = JSON.stringify(data);
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > MAX_BOARD_BYTES) {
      throw new Error(
        `This board is too large to save (${Math.round(bytes / 1024)} KB of a ${Math.round(MAX_BOARD_BYTES / 1024)} KB limit). ` +
        "Split it into two boards."
      );
    }
    // Client-side ms, deliberately: sync.js compares `remote.updatedAt !== S.loadedAt`,
    // so keeping the scheme means the merge logic is unchanged by this migration.
    // firestore.rules bounds it to request.time + 5min so a bad clock can't pin
    // every other client into "remote is always newer".
    const updatedAt = Date.now();
    await withTimeout(
      updateDoc(this._board(boardId), {
        data: json,
        updatedAt,
        updatedAtServer: serverTimestamp(), // rules pin this to request.time
        updatedBy: uid()
      }),
      "Save"
    );
    return { updatedAt };
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
  async renameBoard(boardId, name) {
    await withTimeout(
      updateDoc(this._board(boardId), {
        name: String(name || "Board").slice(0, 200),
        updatedAtServer: serverTimestamp(),
        updatedBy: uid()
      }),
      "Rename board"
    );
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
