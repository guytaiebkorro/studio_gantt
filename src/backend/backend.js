// ---------------------------------------------------------------------------
// Storage backend selection — the single swap point.
//
// To use a different backend, implement the StorageBackend interface below in
// a new file and change the one line marked "← swap this".
//
// A backend is PURE TRANSPORT. It loads, saves and watches board documents and
// the workspace record. Autosave debouncing, queueing remote changes around the
// UI, and what the merge rule IS all live in src/sync.js.
//
// One qualification, since saveBoard's signature makes it look violated: the
// merge runs inside the write, because a read-merge-write done outside a
// transaction loses one of two concurrent editors' work. sync.js passes its
// merge in as `reconcile`, so the POLICY still lives above — only its execution
// moved down. A backend without transactions can ignore the callback and merge
// before writing, at the cost of that race.
//
// A workspace is a server-side object identified by `wsId`. It is NOT a
// credential: identity lives in Firebase Auth and permission lives in
// firestore.rules, so nothing secret is ever held here. That is the substantive
// change from the JSONBin adapter, where one unscopable account-wide Master Key
// was simultaneously the identity, the permission and the workspace id.
//
// @typedef {Object} StorageBackend
// @property {string|null} wsId                                the active workspace's id
// @property {(boardId) => Promise<{data, updatedAt} | null>}  loadBoard    null when missing/empty
// @property {(boardId, data, reconcile) => Promise<{updatedAt, state}>} saveBoard
//           reconcile(remoteData, remoteUpdatedAt) runs inside the write, may be
//           called MORE THAN ONCE, must be pure. `state` is what actually landed.
// @property {(boardId, onChange, onError) => () => void}      watchBoard
//           returns unsubscribe; onChange(board, {fromCache, hasPendingWrites})
// @property {(name, data) => Promise<{id}>}                   createBoardData
// @property {(boardId, name) => Promise<void>}                renameBoard  keeps the doc's own name in step
// @property {(boardId) => Promise<void>}                      deleteBoardData  always rejects; see firestore.js
// @property {() => Promise<{name, boards: Array<{id, name}>}>} getRegistry
// @property {(boards) => Promise<void>}                       putBoards         editor-level
// @property {(name) => Promise<void>}                         putWorkspaceName  admin-level
//
// putBoards and putWorkspaceName are deliberately separate rather than one
// putRegistry(name, boards): firestore.rules lets an EDITOR change the board
// index but only an ADMIN change the workspace name, so a combined call would
// have every editor's board-create rejected.
//
// Gone from the JSONBin adapter: `apiKey`, `discoverRegistryId()` and
// `createRegistry()`. Discovery-by-content-shape existed only because JSONBin
// had no concept of a user; workspaces are now provisioned by tools/admin and
// found via the signed-in user's member document.
// ---------------------------------------------------------------------------
import { FirestoreBackend } from "./firestore.js";

export const backend = new FirestoreBackend();   // ← swap this for another adapter
