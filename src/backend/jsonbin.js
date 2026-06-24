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

// No credentials are embedded. The user pastes a JSONBin **Master Key** in the
// ☁ Cloud panel; it's injected into `apiKey` at runtime (see boards.js) and the
// registry bin id is discovered from that account (see discoverRegistryId).
// A Master Key is required because listing an account's bins — the basis of
// discovery — is restricted to X-Master-Key by JSONBin (Access Keys can't list).

export class JsonBinBackend {
  constructor() {
    this.base = JB;
    this.registryId = null;   // discovered/cached at connect time (see boards.js)
    this.apiKey = null;       // set from S.cloud.apiKey at connect time
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

  // --- registry discovery (Master-Key only; Access Keys can't list bins) ---

  // GET one page of uncategorized bin metadata. Pass the last seen bin id to
  // page forward. Returns the raw array [{ record, private, createdAt, ... }]
  // where `record` is the bin id. Throws on auth failure (surfaces "Master Key
  // required" to the caller).
  async listBins(lastBinId) {
    const url = `${this.base}/c/uncategorized/bins` + (lastBinId ? `/${lastBinId}` : "");
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(await this.errText(res));
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  }

  // GET a bin's latest record WITHOUT unwrapping — the registry's `{ boards }`
  // shape isn't a board document, so loadBoard()/unwrap() would discard it.
  async getBinRaw(id) {
    const res = await fetch(`${this.base}/b/${id}/latest`, { headers: this.headers() });
    if (!res.ok) return null;
    const body = await res.json();
    return body.record || null;
  }

  // Find this account's board registry by content shape: the bin whose record is
  // `{ boards: [...] }`. Returns the bin id, or null if the account has none.
  // Pages through bins with a safety cap so a huge account can't loop forever.
  async discoverRegistryId() {
    const PAGE = 10, CAP = 200;
    let last = null, scanned = 0;
    while (scanned < CAP) {
      const page = await this.listBins(last);
      if (!page.length) break;
      for (const b of page) {
        const id = b.record;
        if (!id) continue;
        scanned++;
        const rec = await this.getBinRaw(id);
        if (rec && Array.isArray(rec.boards)) return id;
        if (scanned >= CAP) break;
      }
      if (page.length < PAGE) break;            // last page
      last = page[page.length - 1].record;
    }
    if (scanned >= CAP) console.warn(`registry discovery stopped at the ${CAP}-bin cap`);
    return null;
  }

  // Create a fresh registry bin holding `boards`; returns { id }.
  async createRegistry(boards) {
    const res = await fetch(`${this.base}/b`, {
      method: "POST",
      headers: Object.assign(this.headers(), { "X-Bin-Name": "gantt-registry", "X-Bin-Private": "true" }),
      body: JSON.stringify({ boards })
    });
    if (!res.ok) throw new Error(await this.errText(res));
    const body = await res.json();
    const id = body.metadata && body.metadata.id;
    if (!id) throw new Error("no bin id returned");
    return { id };
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
