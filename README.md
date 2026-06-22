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

## Cloud sync with Dropbox (recommended for teams)

Instead of passing the file around, the app can read and write your board as a JSON file
directly in **Dropbox**. Everyone opens the same `gantt.html`, connects it to Dropbox once,
and works against one shared file. Click **☁ Cloud** in the toolbar to set this up.

### One-time Dropbox app setup (done by one person)
1. Go to **https://www.dropbox.com/developers/apps** → **Create app**.
2. Choose **Scoped access**, then:
   - **App folder** — simplest; the app only sees its own folder. Good if one Dropbox account
     holds the board.
   - **Full Dropbox** — needed if the board lives in a **shared folder** that teammates access
     from their own Dropbox accounts.
3. Name the app and create it.
4. Open the **Permissions** tab and enable: `files.content.read` and `files.content.write`
   (optionally `files.metadata.read`). Click **Submit**.
5. Open the **Settings** tab and copy the **App key**. (No redirect URI needed — the app uses a
   copy/paste authorization code.)

### Connect the app
1. Click **☁ Cloud** → paste the **App key**.
2. Set a **file path**, e.g. `/board.json` (for an *App folder* app the path is relative to the
   app folder; for *Full Dropbox* use the real path, e.g. `/Team/Projects/board.json`).
3. Click **Connect Dropbox…**, authorize in the new tab, copy the code Dropbox shows, paste it
   back, and click **Finish**.
4. From then on it auto-loads on open and **Save / ⌘S writes to Dropbox**. A green dot on the
   ☁ Cloud button means you're connected. The app refreshes access automatically (no re-login).

### Switching boards
Change the **file path** field and click **Load** to open a different board; **Save** writes to
whatever path is currently set. That's the easy way to keep several boards in one app.

### Notes
- **Concurrency:** the app tracks the Dropbox file revision. If a teammate saved since you
  loaded, you'll be asked to *reload the remote version* or *keep yours and overwrite* — no
  silent clobbering.
- **Team sharing:** for everyone to edit one board, either share one Dropbox account, or use a
  **Full Dropbox** app pointed at a file inside a **shared folder** (each teammate connects their
  own account). App-folder apps can't reach shared folders outside the app folder.
- **Access:** your connection (refresh token) is stored in *your* browser's local storage, not in
  the file. Each person connects once on their machine.
- **Opening:** Dropbox sync works whether you double-click the file (`file://`) or serve it on
  localhost. If a browser blocks the Dropbox request from `file://` (a CORS error on Connect),
  open it via `serve.command` (localhost) instead.

---

## Saving to the file (fallback when not using cloud)

If you're **not** connected to Dropbox, the app falls back to writing your tasks back into the
`.html` file. **In-place file saving needs two things: Chrome/Edge, *and* the page opened over
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
