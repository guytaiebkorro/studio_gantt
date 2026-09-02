// ---------------------------------------------------------------------------
// The workspace panel: a slide-over owning workspaces, their boards, and People.
//
// A PURE VIEW, like ui/gate.js. It receives callbacks through wirePanel() and
// never imports boards.js — boards.js imports THIS module, so reaching back
// would add a second cycle alongside the load-bearing
// state -> sync -> boards one documented in boards.js.
//
// It reads S, but only ever inside function bodies. Nothing here dereferences
// an import at module-evaluation time.
// ---------------------------------------------------------------------------
import { $, esc } from "../dom.js";
import { S } from "../state.js";
import { canWrite } from "../permissions.js";

let handlers = {};
let open = false;
let scrimTimer = null;

export function isPanelOpen() { return open; }

export function wirePanel(h) {
  handlers = h || {};
  wireOnce();
}

// wirePanel() may be called more than once (tests re-wire with new callbacks,
// and updateCloudUI can run repeatedly), so the DOM listeners are attached
// exactly once and read the current `handlers` when they fire.
let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;

  $("ws-scrim").addEventListener("click", closePanel);
  $("wp-signout").addEventListener("click", () => { if (handlers.onSignOut) handlers.onSignOut(); });
  $("wp-copy-link").addEventListener("click", () => { if (handlers.onCopyLink) handlers.onCopyLink(); });

  // Escape closes the panel. The invite dialog registers a capture-phase
  // handler that stops propagation, so Escape closes the dialog first.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) closePanel();
  });

  // One delegated listener for the whole workspace tree, so re-rendering never
  // has to re-attach anything.
  $("wp-workspaces").addEventListener("click", onWorkspacesClick);
  $("wp-workspaces").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const hit = e.target.closest(".wp-board, .wp-ws-head");
    if (!hit) return;
    e.preventDefault();
    onWorkspacesClick(e);
  });
}

function onWorkspacesClick(e) {
  // Per-board icons first, and stop there: without this the click would bubble
  // to the row and also switch board, so renaming would navigate away from
  // whatever you were looking at.
  const icon = e.target.closest(".wp-icon");
  if (icon) {
    e.stopPropagation();
    if (icon.dataset.rename && handlers.onRenameBoard) handlers.onRenameBoard(icon.dataset.rename);
    else if (icon.dataset.link && handlers.onCopyBoardLink) handlers.onCopyBoardLink(icon.dataset.link);
    return;
  }
  if (e.target.closest(".wp-newboard")) {
    if (handlers.onNewBoard) handlers.onNewBoard();
    return;
  }
  const board = e.target.closest(".wp-board");
  if (board) {
    const ws = board.closest(".wp-ws");
    if (handlers.onSelectBoard) handlers.onSelectBoard(ws && ws.dataset.ws, board.dataset.board);
    return;
  }
  const head = e.target.closest(".wp-ws-head");
  if (head) {
    const ws = head.closest(".wp-ws");
    if (handlers.onSelectWorkspace) handlers.onSelectWorkspace(ws && ws.dataset.ws);
  }
}

// Repaint the whole panel. Cheap enough to call on every state change, which
// is what keeps it from drifting out of step with S.
export function renderPanel() {
  renderAccount();
  renderWorkspaces();
}

// Every workspace, always. The active one is expanded and shows its boards —
// which is the whole point of the redesign: switching workspace and switching
// board were previously two different places.
function renderWorkspaces() {
  const box = $("wp-workspaces");
  if (!box) return;
  const list = S.memberships || [];

  box.innerHTML = list.map((m) => {
    const active = m.wsId === S.ws.id;
    const role = m.role || "viewer";
    return `<div class="wp-ws${active ? " active" : ""}" data-ws="${esc(m.wsId)}">` +
        `<div class="wp-ws-head" role="button" tabindex="0" aria-expanded="${active}">` +
          `<span class="wp-chev" aria-hidden="true">${active ? "▾" : "▸"}</span>` +
          `<span class="wp-ws-name">${esc(m.name || m.wsId)}</span>` +
          `<span class="wp-role role-${esc(role)}">${esc(role)}</span>` +
        `</div>` +
        (active ? renderBoards() : "") +
      `</div>`;
  }).join("");
}

function renderBoards() {
  const boards = S.registry || [];
  // canWrite(), NOT canEdit(): these are workspace-management actions, and the
  // chart lock has no business hiding them. See requireWrite() in permissions.js.
  const mayEdit = canWrite();
  return `<div class="wp-boards">` +
    boards.map((b) => {
      const current = b.id === S.ws.boardId;
      return `<div class="wp-board${current ? " current" : ""}" data-board="${esc(b.id)}" role="button" tabindex="0">` +
          `<span class="wp-board-name">${esc(b.name)}</span>` +
          `<span class="wp-board-actions">` +
            // Rename is a write, so editors and above only. Copy-link is a read
            // and stays available to everyone including viewers — the link
            // carries no credential and grants nothing.
            (mayEdit ? `<button class="wp-icon" data-rename="${esc(b.id)}" title="Rename board" aria-label="Rename board">✎</button>` : "") +
            `<button class="wp-icon" data-link="${esc(b.id)}" title="Copy link to this board" aria-label="Copy link to this board">🔗</button>` +
          `</span>` +
        `</div>`;
    }).join("") +
    (mayEdit ? `<button class="wp-newboard" type="button">＋ New board</button>` : "") +
  `</div>`;
}

function renderAccount() {
  const u = S.user || {};
  const name = u.displayName || u.email || "";
  // With no display name the email is the primary line rather than being shown
  // twice, one above the other.
  $("wp-name").textContent = name;
  $("wp-mail").textContent = u.displayName ? (u.email || "") : "";

  const av = $("wp-avatar");
  if (u.photoURL) {
    av.style.backgroundImage = `url("${encodeURI(u.photoURL)}")`;
    av.textContent = "";
  } else {
    av.style.backgroundImage = "";
    av.textContent = (name.trim()[0] || "?").toUpperCase();
  }
}

export function openPanel() {
  open = true;
  clearTimeout(scrimTimer);
  $("ws-scrim").hidden = false;
  $("ws-panel").setAttribute("aria-hidden", "false");
  // Force a reflow so the transform transition runs from the closed position
  // rather than being collapsed into the same frame as unhiding the scrim.
  void $("ws-panel").offsetWidth;
  document.body.classList.add("panel-open");
  if (handlers.onOpen) handlers.onOpen();
}

export function closePanel() {
  open = false;
  $("ws-panel").setAttribute("aria-hidden", "true");
  document.body.classList.remove("panel-open");
  // Keep the scrim in the DOM until the fade finishes, then take it out of the
  // hit-testing path entirely — a transparent full-viewport div left behind
  // would silently swallow every click on the chart.
  clearTimeout(scrimTimer);
  scrimTimer = setTimeout(() => { if (!open) $("ws-scrim").hidden = true; }, 220);
}
