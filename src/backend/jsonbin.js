// ---------------------------------------------------------------------------
// JSONBin storage adapter.
//
// This is the ONLY file that knows about JSONBin — its URL, its keys, its
// request/response shape, and the `fetch` calls. Everything JSONBin-specific
// lives here. The rest of the app talks to it only through the StorageBackend
// methods documented in ./backend.js, so replacing this with another backend
// (Supabase, a REST API, localStorage, …) is a one-file job.
//
// Responsibilities are pure transport: load/save a board document and the
// board registry. Conflict resolution (3-way merge), autosave timing, and
// polling all live above this layer in sync.js — a new backend inherits them
// for free.
// ---------------------------------------------------------------------------

const JB = "https://api.jsonbin.io/v3";

// Embedded so the team needs zero setup. Swap the master key for a scoped
// JSONBin access key (Read + Update + Create) to limit blast radius.
export const DEFAULT_KEY = "$2a$10$.3MEUB1tMaYhFfPipJG4ROpKN3N1UFZU8uvkcQhSvTf.D5V0165om";
export const DEFAULT_BOARD_ID = "6a38fcb4da38895dfeea6372";   // shared board's bin id (the "address")
const DEFAULT_REGISTRY_ID = "6a390a19f5f4af5e291c2536";       // bin holding the list of boards [{id,name}]

export class JsonBinBackend {
  constructor() {
    this.base = JB;
    this.registryId = DEFAULT_REGISTRY_ID;
    this.apiKey = DEFAULT_KEY;   // set from S.cloud.apiKey at startup (see boards.js)
  }

  // --- internal helpers ---
  headers() { return { "X-Master-Key": this.apiKey, "Content-Type": "application/json" }; }
  async errText(res) { try { const t = await res.text(); return t || ("HTTP " + res.status); } catch (_) { return "HTTP " + res.status; } }
  // Accept the wrapped { updatedAt, data } shape, tolerate a legacy raw board.
  unwrap(record) {
    if (record && record.data && record.data.tasks) return { data: record.data, updatedAt: record.updatedAt || 0 };
    if (record && record.tasks) return { data: record, updatedAt: 0 }; // legacy: raw state
    return null;
  }

  // --- StorageBackend interface ---

  // GET the current board; returns { data, updatedAt } or null if empty/missing.
  async loadBoard(boardId) {
    const res = await fetch(`${this.base}/b/${boardId}/latest`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await this.errText(res));
    const body = await res.json();
    return this.unwrap(body.record);
  }

  // PUT the board; returns { updatedAt } of the version just written.
  async saveBoard(boardId, data) {
    const payload = { updatedAt: Date.now(), data };
    const res = await fetch(`${this.base}/b/${boardId}`, { method: "PUT", headers: this.headers(), body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(await this.errText(res));
    return { updatedAt: payload.updatedAt };
  }

  // GET the registry of boards; returns [{ id, name }] (empty array if missing).
  async getRegistry() {
    const res = await fetch(`${this.base}/b/${this.registryId}/latest`, { headers: this.headers() });
    if (!res.ok) throw new Error(await this.errText(res));
    const body = await res.json();
    return (body.record && Array.isArray(body.record.boards)) ? body.record.boards : [];
  }

  // PUT the registry of boards.
  async putRegistry(boards) {
    const res = await fetch(`${this.base}/b/${this.registryId}`, { method: "PUT", headers: this.headers(), body: JSON.stringify({ boards }) });
    if (!res.ok) throw new Error(await this.errText(res));
  }

  // Create a fresh board bin holding `data`; returns { id }.
  async createBoardData(name, data) {
    const res = await fetch(`${this.base}/b`, {
      method: "POST",
      headers: Object.assign(this.headers(), { "X-Bin-Name": ("gantt-" + name).slice(0, 120), "X-Bin-Private": "true" }),
      body: JSON.stringify({ updatedAt: Date.now(), data })
    });
    if (!res.ok) throw new Error(await this.errText(res));
    const body = await res.json();
    const id = body.metadata && body.metadata.id;
    if (!id) throw new Error("no bin id returned");
    return { id };
  }

  // Delete a board bin (best-effort; registry removal is handled by the caller).
  async deleteBoardData(boardId) {
    await fetch(`${this.base}/b/${boardId}`, { method: "DELETE", headers: this.headers() });
  }
}
