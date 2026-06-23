# Gantt — a hosted, cloud-synced Gantt board for teams

A complete Gantt chart built with **plain HTML, CSS, and native ES modules** — no framework, no
build step, no external libraries, no tooling to install. It's hosted on **GitHub Pages**, so the
whole team just opens a URL — the board lives in the cloud (JSONBin) and **every change
auto-saves**. Open it, edit, done.

The code is split into small files with clear responsibilities (see **Project structure** below);
deploying is still just `git push` because the browser loads the modules directly.

> **Live app:** `https://<user>.github.io/<repo>/`
> (replace with your Pages URL)

Because it's served over HTTPS from GitHub Pages, there's nothing to install and none of the old
`file://` limitations apply — it behaves like a normal web app.

---

## Features

- **Tasks** with name, group, start/end dates, **progress %**, and **dependencies**.
- **Milestones** — zero-duration diamond markers for key dates.
- **Groups** — swimlanes with their own color; tasks inherit the group color (or set a per-task color).
- **Drag to move**, **drag bar edges to stretch/shrink**, **drag milestones**.
- **Dependencies** drawn as smooth arrows from a predecessor's end into the dependent task.
- **Reorder** tasks by dragging rows in the left list; **drag a task onto a group header** to move it.
- **Duplicate** a task from its editor.
- **Day / Week / Month** views — switching keeps the date you're looking at centered.
- **Endless timeline** — scroll freely; the date range extends as you go.
- **Israel work week** — weekend shading on **Friday–Saturday**, weeks start Sunday.
- **Fast edits** — instant delete with an **Undo** toast (no confirm dialogs).
- A **loading veil** covers startup so you never see placeholder data flash before the cloud loads.

---

## Collaboration model (how the cloud sync works)

Your board is a JSON document stored in a **JSONBin.io** bin. The app talks to JSONBin directly
from the browser using an embedded key, so **there are no per-user logins**.

- **Auto-load on open** — the app pulls the current board when the page loads.
- **Autosave (batched)** — edits are saved automatically. To conserve API requests, saves are
  *batched*: it waits **2.5s after your last edit** (and at most **15s** during continuous editing),
  then writes once. It also **flushes when you switch tabs / minimize**, and warns if you try to
  close with unsaved changes. (⌘/Ctrl+S forces an immediate save.) The **☁ Cloud** dot shows status:
  grey = idle, amber = saving, green = saved, red = error.
- **Conflict-safe writes** — before each save the app fetches the latest and does a **3-way merge**
  by task/group id. So two people editing **different** tasks (or even different *fields* of the same
  task, e.g. one moves dates while another sets progress) **both keep their changes**. Only edits to
  the **same field** fall back to last-write-wins (the saver wins).
- **Manual Refresh (🔄)** — pulls teammates' latest changes on demand (one request). If you have
  unsaved edits, it merges them in rather than overwriting.
- **Last board remembered** — the board you were on is stored in your browser and reopened next time;
  if it was deleted, it falls back to the first available board.

### Boards
Multiple boards are supported, indexed in a small **registry bin**. Use the toolbar:
- **Board dropdown** — switch between boards.
- **＋ Board** — create a new (empty) board; it's named and added to the registry.
- **☁ Cloud panel** — **Rename** or **Delete** the current board, **Load now** (manual reload), or
  point at any **Bin ID** directly.

---

## Known restrictions ⚠️

This is a lightweight, no-backend tool. The trade-offs that come with that:

1. **The JSONBin key is public.** Because the app is hosted on a public GitHub Pages site, the
   embedded key ships in `index.html` and is readable by **anyone who visits the page or views
   source**. Whoever has it can read/write (and, with a master key, delete) the data.
   - **Recommended:** use a **scoped JSONBin Access Key** (limited to Read + Update + Create on these
     bins) instead of the account **Master Key**, so a leak can't nuke your whole JSONBin account.
   - Treat the board as **not private** — anyone with the URL can find and edit it.
   - If you need real privacy/auth, you'd need a proper backend (out of scope here).
2. **No live updates by default.** Background polling is **off** (`POLL_ENABLED = false`) to stay
   within JSONBin's free tier. You see teammates' changes when you hit **🔄 Refresh**, reload, or on
   your next save (which merges). Flip `POLL_ENABLED` on for 5s live sync — but see the next point.
3. **API request limits.** JSONBin free tier = **10,000 requests/month**; Pro = **$20/mo for
   100,000**. With polling off, usage is tiny (open = 2 requests, each batched save = 2). With 5s
   polling on, a single open tab is ~115k/month — that needs Pro or a longer interval.
4. **Same-field conflicts are last-write-wins.** The 3-way merge protects *different* items/fields,
   but if two people edit the exact same field within the same save window, one value wins. It's
   "mostly in sync," not a real-time CRDT.
5. **Per-browser memory.** Your last board, and any local settings, live in that browser's
   `localStorage` — they don't follow you across machines.

---

## Project structure

```
index.html              markup only — links the CSS and loads src/main.js
styles/                 CSS, split by area (tokens, base, toolbar, list, chart, modals)
src/
  main.js               bootstrap / wiring
  config.js             app constants (geometry, colors, save & poll timing)
  state.js              the shared store + load/normalize
  dates.js              date math + chart geometry
  merge.js              the 3-way merge (pure, backend-agnostic)
  theme.js              dark / light toggle
  sync.js               autosave, polling, refresh, merge-on-save
  boards.js             board registry, switcher, CRUD, cloud panel
  persistence.js        local "save to file" fallback + JSON import/export
  backend/
    backend.js          ← the storage backend swap point
    jsonbin.js          the JSONBin adapter (the only file that knows JSONBin)
  render/               render orchestration + list + chart drawing
  ui/                   interactions, editor, group editor, toolbar
```

## Swapping the backend

The app talks to storage only through a small **`StorageBackend`** interface
(`loadBoard` / `saveBoard` / `getRegistry` / `putRegistry` / `createBoardData` / `deleteBoardData`).
JSONBin is just one implementation, living entirely in `src/backend/jsonbin.js`. To use a different
backend (a REST API, Supabase, localStorage, …): write a new class with those methods, then change
the one line in `src/backend/backend.js` that picks the active backend. Conflict resolution
(the 3-way merge), autosave, and polling live above the backend in `src/sync.js`, so a new backend
inherits them for free.

## Configuration

Behavior constants live in **`src/config.js`**:

| Constant | Default | Meaning |
|---|---|---|
| `POLL_ENABLED` | `false` | Set `true` for 5s live team polling (uses more API requests). |
| `POLL_MS` | `5000` | Polling interval when enabled. |
| `SAVE_IDLE_MS` | `2500` | Save this long after your last edit. |
| `SAVE_MAX_MS` | `15000` | Force a save at least this often during continuous editing. |

JSONBin-specific settings live in **`src/backend/jsonbin.js`**:

| Constant | Default | Meaning |
|---|---|---|
| `DEFAULT_KEY` | *(embedded)* | JSONBin key the app uses. Swap the master key for a scoped access key here. |
| `DEFAULT_BOARD_ID` | `6a38fcb4…` | The default board bin. |
| `DEFAULT_REGISTRY_ID` | `6a390a19…` | The bin holding the list of boards. |

---

## Data format

Each board bin stores `{ "updatedAt": <ms>, "data": <board> }`, where the board is:

```json
{
  "version": 1,
  "settings": { "viewMode": "week" },
  "groups": [ { "id": "g1", "name": "Planning", "color": "#3b82f6" } ],
  "tasks":  [ {
    "id": "t1", "name": "Kickoff", "groupId": "g1",
    "start": "2026-06-15", "end": "2026-06-18",
    "progress": 100, "isMilestone": false, "deps": [], "color": null
  } ]
}
```

The registry bin stores `{ "boards": [ { "id": "<binId>", "name": "Main" } ] }`.

---

## Running locally (optional)

You normally just use the GitHub Pages URL. To hack on it locally, serve the folder over
`http://localhost` — this is **required**, because browsers block ES modules (and the File System
API) on `file://` pages:

```
python3 -m http.server 8753   # then open http://localhost:8753/index.html
```

(`serve.command` does this on macOS with a double-click.)

## Deploying

It's a set of static files. Commit `index.html` plus the `styles/` and `src/` folders to the repo
and enable **GitHub Pages** (Settings → Pages → deploy from branch). Any push updates the live app —
there's no build step; the browser loads the modules as-is.
