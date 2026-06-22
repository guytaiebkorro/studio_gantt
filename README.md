# Gantt — single-file, self-saving Gantt chart

A complete Gantt chart in **one HTML file**. No server, no build step, no internet
connection, no dependencies. Open `gantt.html` in a browser and use it. Your data is
stored **inside the file itself**, so you can drop the single file in Dropbox and share
it with your team.

## How to use

Double-click `gantt.html` (or drag it into a browser tab).

- **+ Task** — add a task. Set name, group, start/end, progress, and dependencies.
- **+ Milestone** — add a zero-duration diamond marker for a key date.
- **+ Group** — create a swimlane with its own color. Tasks inherit their group's color.
- **Day / Week / Month** — switch zoom level. Bars, grid, and arrows stay aligned.
- **Today** — scroll the timeline to today (orange line).
- **Drag a bar** to move it; **drag its left/right edge** to stretch/shrink it.
- **Drag a milestone** to move it.
- **Click** a bar or a row in the left list to edit it; **double-click** a bar also opens the editor.
- **Dependencies** draw arrows from a predecessor's end to a dependent task's start.

## Cloud sync with JSONBin (autosave, no logins)

The app reads and writes your board as JSON in a **JSONBin.io** bin. Everyone opens the same
`index.html`, pastes one **access key**, and **every change auto-saves to the cloud** — no Save
button, no per-user login, no user limits. Click **☁ Cloud** in the toolbar to set it up.

### One-time setup
1. Create a free account at **https://jsonbin.io**.
2. Go to **API Keys** and create an **Access Key** with **Read**, **Update**, and **Create**
   permissions (Create lets the "Create new bin" button work). Copy the key.
3. In the app: click **☁ Cloud**, paste the key into **JSONBin access key**.
4. The **Bin ID** field is pre-filled with the shared board
   (`6a38fcb4da38895dfeea6372`). Click **Load now** to pull it, or **Create new bin** to start a
   fresh board (its id fills in automatically).

That's it. The **☁ Cloud** dot turns green, the board auto-loads on open, and every edit saves
to the bin within ~1 second. The dot shows status: grey = idle, amber = saving, green = saved,
red = error.

### Switching boards
The **Bin ID** is the board's "address." Change it and click **Load now** to open a different
board; from then on edits autosave to that bin. **Create new bin** spins up a new one.

### Notes
- **Autosave:** there's no Save button in cloud mode — changes are debounced and pushed
  automatically. (⌘S still forces an immediate push.)
- **Concurrency:** saves are last-write-wins. If two people edit the *same* bin at the same time,
  the later save wins. Use separate bins for separate boards to avoid stepping on each other.
- **Where the key lives:** your access key is stored in *your* browser's local storage, not in the
  file. Each person pastes it once. (If you want teammates to have zero setup, an access key can be
  embedded in the file as a default — convenient, but then anyone with the file can edit the board.
  Ask if you want that.)
- **CORS:** JSONBin allows browser requests. If a request is blocked when you open the file via
  `file://`, open it through `serve.command` (localhost) instead.

---

## Saving to the file (fallback when cloud isn't set up)

If no access key is set, the app falls back to writing your tasks back into the `index.html`
file. **In-place file saving needs two things: Chrome/Edge, *and* the page opened over
`http://localhost` — not `file://`.**

### Why double-clicking the file can't save in place
When you double-click `gantt.html`, the browser loads it as a `file://` page. Chrome/Edge
**disable the in-place save API on `file://` pages** (a browser security rule, not a bug here).
So a double-clicked file falls back to *download-on-save*, even in Chrome.

### Enable true in-place saving (recommended)
1. **Double-click `serve.command`** in this folder. It starts a tiny local web server and opens
   the app at `http://localhost:8753/gantt.html` in Chrome/Edge. Keep that Terminal window open
   while you work.
2. Edit, then press **Ctrl/Cmd+S** (or click **Save**). The first save asks you to pick/overwrite
   `gantt.html`; after that it overwrites the same file silently. The write goes to the real file on
   disk, so **Dropbox still syncs it**.
3. Close the Terminal window when done to stop the server.

(On Windows, run a static server in this folder instead, e.g. `py -m http.server 8753`, then open
`http://localhost:8753/gantt.html` in Chrome/Edge.)

### Save behavior summary

| How you open it | Save behavior |
|---|---|
| `serve.command` → **localhost in Chrome/Edge** | ✅ True in-place save (Ctrl/Cmd+S overwrites `gantt.html`). |
| Double-click → **file:// in Chrome/Edge** | ⬇️ Downloads an updated `gantt.html` you drop into the folder. |
| **Safari / Firefox** (any URL) | ⬇️ Download only — these browsers don't support the in-place API. |

The app shows a banner telling you which mode you're in.

- A red dot on the **Save** button means you have unsaved changes.
- Closing the tab with unsaved changes warns you first.
- **Export / Import** let you save/load the data as a separate `gantt-data.json` (handy for backups or moving data between files).

## Sharing with your team (Dropbox / shared folder)

1. Put `gantt.html` in a shared Dropbox folder.
2. Each teammate opens it, edits, and saves — the data lives in the file, so it travels with it.

⚠️ **Not real-time.** Because it's a plain file, if two people edit at the same time, the
last save wins and can overwrite the other's changes. Coordinate so only one person edits
at a time (or use Export/Import to merge). A future version could add a conflict check.

## Data format

All state lives in a `<script type="application/json" id="gantt-data">` block near the
bottom of the file:

```json
{
  "version": 1,
  "settings": { "viewMode": "week" },
  "groups": [ { "id": "g1", "name": "Planning", "color": "#3b82f6" } ],
  "tasks":  [ {
    "id": "t1", "name": "Kickoff", "groupId": "g1",
    "start": "2026-06-15", "end": "2026-06-18",
    "progress": 100, "isMilestone": false, "deps": []
  } ]
}
```

The rest of the file (the app code) self-rebuilds the chart from this data on every load,
so the saved file stays small regardless of how many edits you make.
