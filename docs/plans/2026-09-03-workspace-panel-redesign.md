# Workspace Panel Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the centre-modal workspace panel with a 360px sliding left nav that owns workspaces *and* their boards, cuts every hint paragraph, and moves invites into a focused dialog.

**Architecture:** A new `src/ui/panel.js` owns the entire panel and absorbs `src/ui/members.js`. `src/boards.js` keeps all the logic (`openWorkspace`, `switchBoard`, `newBoard`, `renameBoard`) and loses its UI wiring. The panel becomes the app's only workspace list, so `src/ui/gate.js` drops its picker and `src/session.js` auto-opens the last-used workspace instead of showing one. Styling lives in a new `styles/panel.css`.

**Tech Stack:** Vanilla ES modules, no build step, no framework. Firestore via the adapter in `src/backend/firestore.js`. Tests are a stubbed-backend headless-Chrome harness built in Task 1 (this repo has no test framework).

**Design doc:** `docs/plans/2026-09-03-workspace-panel-redesign-design.md` — read it first; it records *why* each cut was made. Do not re-litigate those decisions here.

---

## Notes for the implementer

**Read these first:**
- `docs/plans/2026-09-03-workspace-panel-redesign-design.md` — the approved design
- `src/permissions.js` — `canEdit()`, `requireEdit()`, `isAdmin()`, `canInvite()`, `canAssignRole()`. **Every mutating handler must call one.** CSS `display:none` is presentation, not a boundary; the app had live holes from exactly that assumption.
- `styles/tokens.css` — the design system. Use tokens (`--panel`, `--border`, `--accent`, `--radius-lg`, `--shadow`, `--chip-bg`). Never hardcode a colour; the app has a light and a dark theme and both must work.
- `firestore.rules` — the actual enforcement. A `permission-denied` is the rules working correctly.

**Three traps specific to this codebase:**

1. **Import cycles are load-bearing.** `state.js → sync.js → boards.js → state.js` already exists. `src/ui/panel.js` must be importable from `boards.js` without reaching back into it at module-evaluation time. Follow `src/ui/gate.js`: take callbacks via a `wirePanel(handlers)` function rather than importing `boards.js`. Use `await import()` inside a function body if you genuinely need something from `boards.js`.

2. **`S.gate` gates rendering.** `updateWorkspaceButton()` and the panel's render both key off `S.gate === "open"`. `openWorkspace()` owns that transition and sets it *before* its final UI refresh. Do not add a second owner — that exact bug made the workspace name appear only after a click.

3. **`uiBusy()` in `src/sync.js:129` matches `.overlay.show`.** If the panel uses that class, having it open will suppress polling and refresh-on-activate. Give the panel its own class (`.panel-open` on `<body>`) and decide deliberately whether an open panel should pause syncing. It should **not** — unlike a modal, the panel is not an edit in progress.

**Verification after every task:** `node tools/ui-test/run.mjs` must pass, and `node --check` each changed file under `src/`.

---

## Task 1: Build the UI test harness

Nothing else in this plan is testable without it. It stubs the Firestore adapter, so it needs no auth, no network and no live project.

**Files:**
- Create: `tools/ui-test/run.mjs`
- Create: `tools/ui-test/suite.js`
- Modify: `.gitignore`

**Step 1: Write the runner**

Create `tools/ui-test/run.mjs`:

```js
#!/usr/bin/env node
// Headless-Chrome UI harness. Builds a copy of index.html with the app's
// main.js swapped for tools/ui-test/suite.js, serves it, runs Chrome, and
// collects assertions the page reports over HTTP.
//
// Why not --dump-dom + --virtual-time-budget: virtual time fast-forwards timers
// but does not drive Firebase's real async init, so anything awaiting the auth
// observer never completes inside the budget and looks like a hang.
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CHROME = process.env.CHROME_PATH
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.UI_TEST_PORT || 8899);
const TIMEOUT_MS = Number(process.env.UI_TEST_TIMEOUT || 25000);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

const lines = [];
let done = false;

// Build the test page: real index.html, main.js replaced by the suite.
const html = await readFile(join(ROOT, "index.html"), "utf8");
const page = html.replace(
  '<script type="module" src="src/main.js"></script>',
  '<script type="module" src="tools/ui-test/suite.js"></script>'
);
if (page === html) { console.error("could not find the main.js script tag"); process.exit(1); }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/report") {
    const m = url.searchParams.get("m") || "";
    if (m === "__DONE__") done = true; else { lines.push(m); console.log(m); }
    res.writeHead(204).end(); return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(page); return;
  }
  try {
    const buf = await readFile(join(ROOT, url.pathname.slice(1)));
    res.writeHead(200, { "Content-Type": MIME[extname(url.pathname)] || "application/octet-stream",
                         "Cache-Control": "no-store" }).end(buf);
  } catch { res.writeHead(404).end("not found"); }
});
await new Promise((r) => server.listen(PORT, r));

const profile = await mkdtemp(join(tmpdir(), "ui-test-"));
const chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--no-sandbox",
  `--user-data-dir=${profile}`, `http://localhost:${PORT}/index.html`],
  { stdio: "ignore" });

const started = Date.now();
while (!done && Date.now() - started < TIMEOUT_MS) await new Promise((r) => setTimeout(r, 200));

chrome.kill();
server.close();
await rm(profile, { recursive: true, force: true });

const pass = lines.filter((l) => l.startsWith("PASS")).length;
const fail = lines.filter((l) => l.startsWith("FAIL")).length;
console.log("---");
if (!done) console.log("TIMED OUT before the suite finished — treat as failure");
console.log(`PASSES: ${pass}  FAILURES: ${fail}`);
process.exit(fail === 0 && done ? 0 : 1);
```

**Step 2: Write the suite with stubs and one assertion**

Create `tools/ui-test/suite.js`:

```js
// Runs inside the real index.html. Stubs the Firestore adapter, so no auth,
// no network and no live project are involved.
const rep = (s) => { try { fetch("/report?m=" + encodeURIComponent(s)); } catch (_) {} };
export const ck = (name, got, want) => rep(
  (got === want ? "PASS " : "FAIL ") + name +
  (got === want ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
export const note = (s) => rep("INFO " + s);

window.onerror = (m, s, l) => rep(`FAIL window.onerror: ${m} @${(s || "").split("/").pop()}:${l}`);
window.addEventListener("unhandledrejection", (e) =>
  rep("FAIL rejection: " + (e.reason && (e.reason.stack || e.reason.message || e.reason))));

const { S } = await import("../../src/state.js");
const { backend } = await import("../../src/backend/backend.js");
const { applyRole } = await import("../../src/permissions.js");

// --- fixture -------------------------------------------------------------
export const WORKSPACES = [
  { wsId: "game-dev", name: "Game Dev", role: "admin" },
  { wsId: "product",  name: "Product",  role: "admin" }
];
const BOARDS = {
  "game-dev": [{ id: "b1", name: "Main" }, { id: "b2", name: "1.58.0 Tasks" }],
  "product":  [{ id: "b3", name: "My Board" }]
};
const MEMBERS = [
  { email: "guy@korro.ai",   role: "admin",  signedIn: true,  isProtected: true,  displayName: "Guy Taieb", invitedBy: "cli" },
  { email: "matan@korro.ai", role: "editor", signedIn: false, isProtected: false, displayName: "",          invitedBy: "guy@korro.ai" }
];
export const calls = [];   // records writes so tests can assert intent

function stub() {
  backend.getRegistry = async () => ({ name: (WORKSPACES.find(w => w.wsId === backend.wsId) || {}).name || "",
                                       boards: BOARDS[backend.wsId] || [] });
  backend.loadBoard = async (id) => ({ data: { version: 1, settings: { viewMode: "week" }, groups: [], tasks: [] }, updatedAt: 1 });
  backend.saveBoard = async () => ({ updatedAt: 2 });
  backend.createBoardData = async (name) => { calls.push(["createBoardData", name]); return { id: "new" }; };
  backend.renameBoard = async (id, name) => { calls.push(["renameBoard", id, name]); };
  backend.putBoards = async (b) => { calls.push(["putBoards", b.map(x => x.name).join(",")]); };
  backend.putWorkspaceName = async (n) => { calls.push(["putWorkspaceName", n]); };
}

export async function setup(role = "admin") {
  stub();
  S.user = { uid: "u1", email: "guy@korro.ai", displayName: "Guy Taieb", photoURL: "" };
  S.memberships = WORKSPACES.map(w => ({ ...w, role }));
  applyRole(role);
  const { openWorkspace } = await import("../../src/boards.js");
  await openWorkspace("game-dev", { name: "Game Dev", role, boardId: "b1" });
}
export function stubMembers() { return MEMBERS; }
export const $ = (id) => document.getElementById(id);
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- the suite -----------------------------------------------------------
await setup("admin");
ck("harness: workspace opened", S.ws.id, "game-dev");

rep("__DONE__");
```

**Step 3: Run it to verify the harness works**

Run: `node tools/ui-test/run.mjs`
Expected: `PASS harness: workspace opened` then `PASSES: 1  FAILURES: 0`, exit 0.

If Chrome isn't at the default path, set `CHROME_PATH`.

**Step 4: Ignore the temp profile**

Add to `.gitignore`:

```
# UI test harness scratch
tools/ui-test/.profile/
```

**Step 5: Commit**

```bash
git add tools/ui-test .gitignore
git commit -m "Add a stubbed-backend UI test harness"
```

---

## Task 2: Panel shell — markup, CSS, open/close

**Files:**
- Modify: `index.html` (replace the `#cloud-overlay` block)
- Create: `styles/panel.css`
- Create: `src/ui/panel.js`
- Modify: `tools/ui-test/suite.js`

**Step 1: Write the failing assertions**

Append to the suite (before `rep("__DONE__")`):

```js
const { wirePanel, openPanel, closePanel, isPanelOpen } = await import("../../src/ui/panel.js");
wirePanel({});
ck("panel starts closed", isPanelOpen(), false);
openPanel();
ck("panel opens", isPanelOpen(), true);
ck("body gets panel-open", document.body.classList.contains("panel-open"), true);
ck("panel does NOT use .overlay.show (would pause syncing)",
   $("ws-panel").classList.contains("overlay"), false);
closePanel();
ck("panel closes", isPanelOpen(), false);
openPanel();
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(50);
ck("Escape closes the panel", isPanelOpen(), false);
```

**Step 2: Run to verify it fails**

Run: `node tools/ui-test/run.mjs`
Expected: FAIL — `src/ui/panel.js` does not exist.

**Step 3: Add the markup**

In `index.html`, replace the entire `<!-- Workspace: ... --><div class="overlay" id="cloud-overlay">…</div>` block with:

```html
<!-- Workspace navigation. A slide-over, NOT an .overlay: uiBusy() in sync.js
     matches ".overlay.show", and an open panel must not pause syncing the way
     an in-progress edit does. -->
<div class="panel-scrim" id="ws-scrim" hidden></div>
<aside class="ws-panel" id="ws-panel" aria-label="Workspaces" aria-hidden="true">
  <header class="wp-account">
    <div class="wp-avatar" id="wp-avatar"></div>
    <div class="wp-who">
      <span class="wp-name" id="wp-name"></span>
      <span class="wp-mail" id="wp-mail"></span>
    </div>
  </header>

  <div class="wp-scroll">
    <p class="wp-caption">Workspaces</p>
    <div id="wp-workspaces"></div>
    <p class="wp-caption" id="wp-people-caption">People</p>
    <div id="wp-people"></div>
  </div>

  <footer class="wp-foot">
    <button class="wp-ghost" id="wp-copy-link" title="Copy a link to this board">Copy board link</button>
    <button class="wp-ghost" id="wp-signout">Sign out</button>
  </footer>
</aside>
```

Add `<link rel="stylesheet" href="styles/panel.css">` after the `modals.css` link.

**Step 4: Write the CSS**

Create `styles/panel.css`. Only the shell for now; later tasks append.

```css
/* ============================================================
   WORKSPACE PANEL — a 360px slide-over from the left.
   Structural, not a reskin: tall rows, pill chips, real elevation,
   generous rhythm, one accent used ONLY to mean "current".
   ============================================================ */
.panel-scrim {
  position: fixed; inset: 0; z-index: 150;
  background: var(--overlay); opacity: 0;
  transition: opacity .16s ease;
}
body.panel-open .panel-scrim { opacity: 1; }

.ws-panel {
  position: fixed; top: 0; left: 0; bottom: 0; z-index: 151;
  width: 360px; max-width: 88vw;
  display: flex; flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
  border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
  box-shadow: var(--shadow);
  transform: translateX(-100%);
  transition: transform .22s cubic-bezier(.32,.72,0,1);
  font-family: var(--font-body);
}
body.panel-open .ws-panel { transform: translateX(0); }

@media (prefers-reduced-motion: reduce) {
  .ws-panel { transition: opacity .12s ease; transform: none; opacity: 0; }
  body.panel-open .ws-panel { opacity: 1; }
}

.wp-account { display: flex; gap: 12px; align-items: center; padding: 18px 20px; }
.wp-avatar {
  width: 36px; height: 36px; border-radius: var(--radius-pill); flex: 0 0 36px;
  background: var(--accent); color: var(--accent-text);
  display: grid; place-items: center;
  font-family: var(--font-display); font-size: 15px; font-weight: 600;
  background-size: cover; background-position: center;
}
.wp-who { display: flex; flex-direction: column; min-width: 0; }
.wp-name { font-family: var(--font-display); font-size: 15px; color: var(--text); }
.wp-mail { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.wp-scroll { flex: 1; overflow-y: auto; padding: 4px 10px 14px; }
.wp-caption {
  margin: 14px 10px 6px; font-size: 10.5px; font-weight: 800;
  text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
}

.wp-foot {
  display: flex; gap: 8px; align-items: center;
  padding: 12px 16px; border-top: 1px solid var(--border);
}
.wp-ghost {
  font: inherit; font-size: 12.5px; color: var(--muted);
  background: none; border: none; border-radius: var(--radius-sm);
  padding: 7px 9px; cursor: pointer;
}
.wp-ghost:hover { background: var(--hover); color: var(--text); }
.wp-foot #wp-signout { margin-left: auto; }
```

**Step 5: Write the module**

Create `src/ui/panel.js`:

```js
// ---------------------------------------------------------------------------
// The workspace panel: a slide-over owning workspaces, their boards, and People.
//
// A PURE VIEW, like ui/gate.js. It takes callbacks via wirePanel() rather than
// importing boards.js, because boards.js imports THIS module — reaching back
// would add a second cycle alongside the load-bearing
// state -> sync -> boards one.
// ---------------------------------------------------------------------------
import { $ } from "../dom.js";

let handlers = {};
let open = false;

export function isPanelOpen() { return open; }

export function wirePanel(h) {
  handlers = h || {};
  $("ws-scrim").addEventListener("click", closePanel);
  $("wp-signout").addEventListener("click", () => { if (handlers.onSignOut) handlers.onSignOut(); });
  $("wp-copy-link").addEventListener("click", () => { if (handlers.onCopyLink) handlers.onCopyLink(); });
  // Escape closes the panel. The invite dialog (Task 7) registers its own
  // handler and stops propagation, so Escape closes the dialog first.
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) closePanel(); });
}

export function openPanel() {
  open = true;
  $("ws-scrim").hidden = false;
  $("ws-panel").setAttribute("aria-hidden", "false");
  document.body.classList.add("panel-open");
  if (handlers.onOpen) handlers.onOpen();
}

export function closePanel() {
  open = false;
  $("ws-panel").setAttribute("aria-hidden", "true");
  document.body.classList.remove("panel-open");
  // Keep the scrim in the DOM until the transition finishes so it fades out.
  setTimeout(() => { if (!open) $("ws-scrim").hidden = true; }, 200);
}
```

**Step 6: Run to verify it passes**

Run: `node tools/ui-test/run.mjs`
Expected: all Task-2 assertions PASS.

**Step 7: Commit**

```bash
git add index.html styles/panel.css src/ui/panel.js tools/ui-test/suite.js
git commit -m "Add the workspace panel shell as a slide-over"
```

---

## Task 3: Account header

**Files:** Modify `src/ui/panel.js`, `tools/ui-test/suite.js`

**Step 1: Assertions**

```js
const { renderPanel } = await import("../../src/ui/panel.js");
renderPanel();
ck("account name", $("wp-name").textContent, "Guy Taieb");
ck("account email", $("wp-mail").textContent, "guy@korro.ai");
ck("avatar falls back to an initial", $("wp-avatar").textContent, "G");
```

**Step 2:** Run — FAIL, `renderPanel` is not exported.

**Step 3:** Add to `panel.js`:

```js
import { S } from "../state.js";
import { esc } from "../dom.js";

export function renderPanel() {
  renderAccount();
  // later tasks add renderWorkspaces() and renderPeople() here
}

function renderAccount() {
  const u = S.user || {};
  const name = u.displayName || u.email || "";
  $("wp-name").textContent = name;
  $("wp-mail").textContent = u.displayName ? (u.email || "") : "";
  const av = $("wp-avatar");
  if (u.photoURL) {
    av.style.backgroundImage = `url("${u.photoURL}")`;
    av.textContent = "";
  } else {
    av.style.backgroundImage = "";
    av.textContent = (name.trim()[0] || "?").toUpperCase();
  }
}
```

Note `S` is imported but only dereferenced inside functions — required, see the import-cycle trap.

**Step 4:** Run — PASS.

**Step 5:** `git commit -m "Render the panel's account header"`

---

## Task 4: Workspaces accordion with boards

The core of the redesign.

**Files:** Modify `src/ui/panel.js`, `styles/panel.css`, `tools/ui-test/suite.js`

**Step 1: Assertions**

```js
renderPanel();
const rows = document.querySelectorAll("#wp-workspaces .wp-ws");
ck("both workspaces listed", rows.length, 2);
ck("no switch button anywhere", !!document.querySelector("#c-ws-switch"), false);
ck("active workspace is expanded", rows[0].classList.contains("active"), true);
ck("inactive workspace is collapsed", rows[1].classList.contains("active"), false);
ck("active shows its boards", document.querySelectorAll("#wp-workspaces .wp-board").length, 2);
ck("current board marked", document.querySelector("#wp-workspaces .wp-board.current .wp-board-name").textContent, "Main");
ck("role chip rendered", rows[0].querySelector(".wp-role").textContent.trim(), "admin");
ck("New board offered to an admin", !!rows[0].querySelector(".wp-newboard"), true);

// switching board goes through the callback, not straight to the backend
let switched = null;
wirePanel({ onSelectBoard: (ws, b) => { switched = [ws, b]; } });
renderPanel();
document.querySelectorAll("#wp-workspaces .wp-board")[1].click();
ck("clicking a board reports it", JSON.stringify(switched), JSON.stringify(["game-dev", "b2"]));

let picked = null;
wirePanel({ onSelectWorkspace: (ws) => { picked = ws; } });
renderPanel();
document.querySelectorAll("#wp-workspaces .wp-ws")[1].querySelector(".wp-ws-head").click();
ck("clicking a workspace reports it", picked, "product");
```

**Step 2:** Run — FAIL.

**Step 3: Implement**

In `panel.js`, call `renderWorkspaces()` from `renderPanel()` and add:

```js
import { canEdit, isAdmin } from "../permissions.js";

const ROLE_LABEL = { admin: "admin", editor: "editor", viewer: "viewer" };

function renderWorkspaces() {
  const box = $("wp-workspaces");
  const list = S.memberships || [];
  box.innerHTML = list.map((m) => {
    const active = m.wsId === S.ws.id;
    const boards = active ? S.registry : [];
    return `<div class="wp-ws${active ? " active" : ""}" data-ws="${esc(m.wsId)}">` +
        `<div class="wp-ws-head" role="button" tabindex="0">` +
          `<span class="wp-chev" aria-hidden="true">${active ? "▾" : "▸"}</span>` +
          `<span class="wp-ws-name">${esc(m.name || m.wsId)}</span>` +
          `<span class="wp-role role-${esc(m.role)}">${esc(ROLE_LABEL[m.role] || m.role)}</span>` +
        `</div>` +
        (active
          ? `<div class="wp-boards">` +
              boards.map((b) =>
                `<div class="wp-board${b.id === S.ws.boardId ? " current" : ""}" data-board="${esc(b.id)}" role="button" tabindex="0">` +
                  `<span class="wp-board-name">${esc(b.name)}</span>` +
                  `<span class="wp-board-actions">` +
                    (canEdit() ? `<button class="wp-icon" data-rename="${esc(b.id)}" title="Rename">✎</button>` : "") +
                    `<button class="wp-icon" data-link="${esc(b.id)}" title="Copy link">🔗</button>` +
                  `</span>` +
                `</div>`).join("") +
              (canEdit() ? `<button class="wp-newboard">＋ New board</button>` : "") +
            `</div>`
          : "") +
      `</div>`;
  }).join("");
}
```

Add one delegated listener in `wirePanel()`:

```js
$("wp-workspaces").addEventListener("click", (e) => {
  const icon = e.target.closest(".wp-icon");
  if (icon) {
    e.stopPropagation();
    if (icon.dataset.rename && handlers.onRenameBoard) handlers.onRenameBoard(icon.dataset.rename);
    if (icon.dataset.link && handlers.onCopyBoardLink) handlers.onCopyBoardLink(icon.dataset.link);
    return;
  }
  if (e.target.closest(".wp-newboard")) { if (handlers.onNewBoard) handlers.onNewBoard(); return; }
  const board = e.target.closest(".wp-board");
  if (board) {
    const ws = board.closest(".wp-ws").dataset.ws;
    if (handlers.onSelectBoard) handlers.onSelectBoard(ws, board.dataset.board);
    return;
  }
  const head = e.target.closest(".wp-ws-head");
  if (head && handlers.onSelectWorkspace) handlers.onSelectWorkspace(head.closest(".wp-ws").dataset.ws);
});
```

Mirror it for `keydown` on Enter/Space, as `gate.js` does.

**Step 4: CSS** — append to `styles/panel.css`:

```css
.wp-ws { border-radius: var(--radius-md); margin-bottom: 2px; }
.wp-ws-head {
  display: flex; align-items: center; gap: 8px;
  height: 44px; padding: 0 10px; border-radius: var(--radius-md);
  cursor: pointer; position: relative;
}
.wp-ws-head:hover { background: var(--hover); }
.wp-ws.active > .wp-ws-head::before {
  content: ""; position: absolute; left: 0; top: 9px; bottom: 9px;
  width: 3px; border-radius: var(--radius-pill); background: var(--accent);
}
.wp-chev { color: var(--muted); font-size: 10px; width: 12px; }
.wp-ws-name {
  flex: 1; min-width: 0; font-family: var(--font-display); font-size: 14.5px;
  color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wp-role {
  font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em;
  padding: 3px 8px; border-radius: var(--radius-pill);
  color: var(--muted); background: var(--chip-bg);
}
.wp-role.role-admin  { color: var(--ok-text);   background: var(--ok-bg); }
.wp-role.role-editor { color: var(--warn-text); background: var(--warn-bg); }

.wp-boards { padding: 2px 0 8px 30px; }
.wp-board {
  display: flex; align-items: center; gap: 8px;
  height: 38px; padding: 0 10px; border-radius: var(--radius-sm); cursor: pointer;
}
.wp-board:hover { background: var(--hover); }
.wp-board-name { flex: 1; min-width: 0; font-size: 13.5px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wp-board.current .wp-board-name { color: var(--accent); font-weight: 700; }
.wp-board.current::after {
  content: ""; width: 6px; height: 6px; border-radius: var(--radius-pill);
  background: var(--accent); flex: 0 0 6px;
}
.wp-board-actions { display: flex; gap: 2px; opacity: 0; }
.wp-board:hover .wp-board-actions, .wp-board:focus-within .wp-board-actions { opacity: 1; }
.wp-icon {
  border: none; background: none; cursor: pointer; font-size: 12px;
  color: var(--muted); padding: 4px 5px; border-radius: 6px; line-height: 1;
}
.wp-icon:hover { background: var(--chip-bg); color: var(--text); }
.wp-newboard {
  font: inherit; font-size: 13px; color: var(--muted);
  background: none; border: none; cursor: pointer;
  padding: 8px 10px; border-radius: var(--radius-sm); width: 100%; text-align: left;
}
.wp-newboard:hover { background: var(--hover); color: var(--accent); }
```

**Step 5:** Run — PASS.

**Step 6:** `git commit -m "Render workspaces with their boards in the panel"`

---

## Task 5: Inline new/rename board (kill the two `prompt()` calls)

**Files:** Modify `src/ui/panel.js`, `styles/panel.css`, `src/boards.js`, `tools/ui-test/suite.js`

**Step 1: Assertions**

```js
await setup("admin");
wirePanel({ onNewBoard: () => beginNewBoard(), onRenameBoard: (id) => beginRenameBoard(id) });
renderPanel();
document.querySelector(".wp-newboard").click();
ck("new board shows an inline input, not a prompt", !!document.querySelector(".wp-inline-input"), true);
const inp = document.querySelector(".wp-inline-input");
inp.value = "Sprint 12";
inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(50);
ck("Enter created the board", calls.some(c => c[0] === "createBoardData" && c[1] === "Sprint 12"), true);
```

**Step 2:** Run — FAIL.

**Step 3:** Add `beginNewBoard()` / `beginRenameBoard(id)` to `panel.js`, each replacing the row with an `<input class="wp-inline-input">`: Enter commits via `handlers.onCommitNewBoard(name)` / `onCommitRenameBoard(id, name)`, Escape and blur cancel and re-render.

In `src/boards.js`, change `newBoard()` and `renameBoard()` to take a `name` argument instead of calling `prompt()`. Keep `requireEdit()` as the first line of each — the guard must not move into the view layer.

**Step 4:** Run — PASS.

**Step 5:** `git commit -m "Replace prompt() with inline board name editing"`

---

## Task 6: People

**Files:** Modify `src/ui/panel.js`, `styles/panel.css`, `tools/ui-test/suite.js`

**Step 1: Assertions**

```js
await setup("admin");
renderPanel(); await sleep(300);
ck("roster rendered", document.querySelectorAll("#wp-people .wp-member").length, 2);
ck("own row marked", document.querySelector("#wp-people .wp-member .wp-you").textContent.trim(), "you");
ck("protected founder not removable", document.querySelectorAll("#wp-people [data-remove]").length, 1);
ck("admin gets a role select for others", document.querySelectorAll("#wp-people select.wp-member-role").length, 1);
ck("invite affordance present", !!$("wp-invite-open"), true);

await setup("viewer");
renderPanel(); await sleep(300);
ck("viewer sees the roster", document.querySelectorAll("#wp-people .wp-member").length, 2);
ck("viewer gets no role selects", document.querySelectorAll("#wp-people select.wp-member-role").length, 0);
ck("viewer gets no invite", $("wp-invite-open").hidden, true);
```

**Step 2:** Run — FAIL.

**Step 3:** Port the render and handlers from `src/ui/members.js` into `panel.js`, adapted to the new markup. Keep every behaviour that file already got right:

- roster sorted admin → editor → viewer, then by email
- a role `<select>` only when `isAdmin() && !me && !isProtected` (an admin cannot change their *own* role; the rules refuse it so the workspace can't reach zero admins)
- the admin `<option>` is **removed, not disabled**, unless `isAdmin()`
- `canAssignRole(role)` checked before any write
- `permission-denied` reported as "your access may have changed", then re-render from the server

`＋ Invite someone` is a `<button id="wp-invite-open" hidden>`; unhide when `canInvite()`.

**Step 4:** Run — PASS.

**Step 5:** `git commit -m "Render People in the panel"`

---

## Task 7: Invite dialog

**Files:** Modify `index.html`, `styles/panel.css`, `src/ui/panel.js`, `tools/ui-test/suite.js`

**Step 1: Assertions**

```js
await setup("admin");
renderPanel(); await sleep(300);
$("wp-invite-open").click();
ck("dialog opens", $("invite-dialog").classList.contains("show"), true);
ck("dialog names the workspace", $("invite-ws").textContent, "Game Dev");
ck("admin sees three roles", document.querySelectorAll("#invite-roles .wp-seg").length, 3);
ck("default role is viewer", document.querySelector("#invite-roles .wp-seg.on").dataset.role, "viewer");
document.querySelector('#invite-roles [data-role="editor"]').click();
ck("selecting a role shows one line of meaning", $("invite-role-note").textContent.length > 0, true);
// Escape closes the DIALOG first, not the panel
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(50);
ck("Escape closed the dialog", $("invite-dialog").classList.contains("show"), false);
ck("...and left the panel open", isPanelOpen(), true);

await setup("editor");
renderPanel(); await sleep(300);
$("wp-invite-open").click();
ck("editor cannot see the admin role at all", document.querySelectorAll("#invite-roles .wp-seg").length, 2);
```

**Step 2:** Run — FAIL.

**Step 3:** Add the markup to `index.html`:

```html
<div class="overlay" id="invite-dialog">
  <div class="modal invite-modal">
    <h3>Invite to <span id="invite-ws"></span></h3>
    <div class="body">
      <input type="email" id="invite-email" autocomplete="off" placeholder="name@company.com">
      <div class="wp-segs" id="invite-roles" role="radiogroup" aria-label="Permission level">
        <button class="wp-seg on" data-role="viewer" role="radio" aria-checked="true">Viewer</button>
        <button class="wp-seg" data-role="editor" role="radio" aria-checked="false">Editor</button>
        <button class="wp-seg" data-role="admin"  role="radio" aria-checked="false">Admin</button>
      </div>
      <p class="wp-note" id="invite-role-note"></p>
      <div class="c-status" id="invite-status" style="display:none"></div>
    </div>
    <div class="foot">
      <button class="btn" id="invite-cancel">Cancel</button>
      <button class="btn primary" id="invite-send">Send invite</button>
    </div>
  </div>
</div>
```

This one **is** an `.overlay` — a modal dialog *should* pause syncing while open, unlike the panel.

In `panel.js`, one line of meaning per role, replacing the deleted paragraph:

```js
const ROLE_NOTE = {
  viewer: "Can see boards but not change anything.",
  editor: "Can edit boards, and invite viewers and editors.",
  admin:  "Can do everything, including managing people."
};
```

`openInviteDialog()` removes the admin segment unless `isAdmin()`, focuses the email field, and registers a capture-phase Escape handler that calls `stopPropagation()` so the panel's handler doesn't also fire. Enter in the email field submits.

**Step 4: CSS** — append segmented-control styles: `.wp-segs` a `--chip-bg` track with `--radius-pill`, `.wp-seg` flex-1 pill buttons, `.wp-seg.on` filled with `--accent` and `--accent-text`.

**Step 5:** Run — PASS.

**Step 6:** `git commit -m "Add the invite dialog with a segmented role control"`

---

## Task 8: Workspace overflow menu — rename and leave

**Files:** Modify `src/ui/panel.js`, `styles/panel.css`, `tools/ui-test/suite.js`

Rename is admin-only and edits the name inline (reuse Task 5's inline input). Leave is offered only to non-admins; an admin leaving could strand the workspace, so that path is CLI-only and the menu says so rather than offering a button that fails.

**Assertions:** admin sees Rename and no Leave; viewer sees Leave and no Rename; committing a rename calls `putWorkspaceName`.

`git commit -m "Add the workspace overflow menu"`

---

## Task 9: Wire the panel to boards.js and drop the old panel

**Files:** Modify `src/boards.js`, `src/main.js`; delete `src/ui/members.js`; modify `index.html`, `styles/modals.css`, `tools/ui-test/suite.js`

**Step 1:** In `boards.js`, replace the old `$("cloud-btn")`/`$("c-*")` wiring with one `wirePanel({...})` call mapping every callback to the existing logic. Keep `updateCloudUI()` as the thing that calls `renderPanel()`.

**Step 2:** Remove from `index.html`'s toolbar:

```html
<select id="board-select" class="board-select" title="Switch board"></select>
<button class="btn" id="board-new" …>Board</button>
```

**Step 3:** Delete `src/boards.js`'s `renderBoardSelect()` and `fitBoardSelect()` — ~30 lines including the hand-rolled width prober, now dead. Remove every call site.

**Step 4:** `git rm src/ui/members.js`. Remove stale `#c-*` rules from `styles/modals.css`.

**Step 5:** Run the harness AND `node --check` every changed file. Then load the app in a browser signed in and confirm switching workspace and board both work.

**Step 6:** `git commit -m "Wire the panel and remove the old workspace modal"`

---

## Task 10: Slim the gate, auto-open on startup

**Files:** Modify `src/ui/gate.js`, `src/session.js`, `index.html`, `tools/ui-test/suite.js`

**Step 1:** Remove the `picker` view and the denied state's workspace list from `gate.js` and its markup. Gate views become `boot | signin | empty | denied`.

**Step 2:** In `session.js`, delete the `S.memberships.length > 1 → showGate("picker")` branch. Always open `lastWorkspace()`, else `S.memberships[0]`.

**Step 3:** `pickWorkspace()` stays — it's now called by the panel instead of the gate.

**Step 4:** Assertions: with two memberships and none remembered, the first alphabetically opens and the gate is hidden; with an unknown share target, `denied` still shows and no longer renders a workspace list.

**Step 5:** `git commit -m "Slim the gate to sign-in and dead-ends"`

---

## Task 11: Role gating sweep

Re-verify the whole matrix in `docs/plans/2026-09-03-workspace-panel-redesign-design.md` against the built panel, for all three roles. Every mutating handler must call `requireEdit()` / `canAssignRole()`; the panel hiding a control is not a guard.

Add a suite block looping `["viewer","editor","admin"]` and asserting the visible affordances per role.

`git commit -m "Verify role gating across the panel"`

---

## Task 12: Visual verification

**Not optional.** A visual redesign is not done until it has been looked at — a previous redesign in this repo was rejected for reading as "exactly the same" because it changed colours without changing geometry.

**Step 1:** Serve the app and sign in.

**Step 2:** Screenshot the open panel in **light and dark** themes, and the invite dialog in both. Confirm: 44px workspace rows, pill role chips, the accent left-edge on the active workspace only, one hairline per region, no bordered sub-boxes, and **zero hint paragraphs**.

**Step 3:** Toggle `prefers-reduced-motion` and confirm the panel fades instead of sliding.

**Step 4:** Narrow the window to ~420px and confirm `max-width: 88vw` keeps the panel usable.

**Step 5:** Fix what looks wrong, then `git commit -m "Polish the panel visuals"`.

---

## Out of scope

- The README still documents the JSONBin model (`README.md:59-137`) — tracked separately.
- Emulator rules tests (needs a JRE).
- `onSnapshot` live sync.
- A CSP.
