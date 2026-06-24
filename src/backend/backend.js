// ---------------------------------------------------------------------------
// Storage backend selection — the single swap point.
//
// To use a different backend, implement the StorageBackend interface below in
// a new file and change the one line marked "← swap this".
//
// A backend is PURE TRANSPORT. It loads and saves board documents and the
// board registry. It knows nothing about merging, autosave debouncing, or
// polling — those live in src/sync.js and apply to every backend equally.
//
// @typedef {Object} StorageBackend
// @property {string} apiKey                                  credential the app injects at startup
// @property {(boardId) => Promise<{data, updatedAt} | null>} loadBoard         null when the board is empty/missing
// @property {(boardId, data) => Promise<{updatedAt}>}        saveBoard
// @property {() => Promise<Array<{id, name}>>}               getRegistry
// @property {(boards) => Promise<void>}                      putRegistry
// @property {(name, data) => Promise<{id}>}                  createBoardData
// @property {(boardId) => Promise<void>}                     deleteBoardData
// ---------------------------------------------------------------------------
import { JsonBinBackend } from "./jsonbin.js";

export const backend = new JsonBinBackend();   // ← swap this for another adapter
