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
import { canWrite, canInvite, canAssignRole, isAdmin } from "../permissions.js";

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
  $("wp-invite-open").addEventListener("click", () => { if (handlers.onOpenInvite) handlers.onOpenInvite(); });
  $("wp-people").addEventListener("change", (e) => {
    const sel = e.target.closest(".wp-member-role");
    if (!sel) return;
    const role = sel.value;
    // The dropdown is an affordance, not a boundary: re-check before reporting,
    // and let firestore.rules have the final say regardless.
    if (!canAssignRole(role)) { renderPanel(); return; }
    if (handlers.onSetRole) handlers.onSetRole(sel.dataset.email, role);
  });
  $("wp-people").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (btn && handlers.onRemoveMember) handlers.onRemoveMember(btn.dataset.remove);
  });
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
  renderPeople();
}

// ---------------------------------------------------------------------------
// People.
//
// The controls here are an affordance, not a boundary: the role <select> omits
// admin unless you are one, but every write is checked again by
// firestore.rules, which is the only thing that actually decides. A
// permission-denied from any of these is the rules working.
//
// The roster is fetched through handlers.loadMembers() rather than by importing
// memberships.js, keeping this module a pure view — and making it testable
// without Firestore.
// ---------------------------------------------------------------------------
const ROLE_NAME = { admin: "Admin", editor: "Editor", viewer: "Viewer" };
let peopleToken = 0;

export function clearPeople() {
  const box = $("wp-people");
  if (box) box.innerHTML = "";
  const btn = $("wp-invite-open");
  if (btn) btn.hidden = true;
}

async function renderPeople() {
  const box = $("wp-people");
  const caption = $("wp-people-caption");
  const inviteBtn = $("wp-invite-open");
  if (!box) return;

  const live = S.ws.id && S.gate === "open";
  if (caption) caption.hidden = !live;
  if (inviteBtn) inviteBtn.hidden = !live || !canInvite();
  if (!live) { box.innerHTML = ""; return; }

  // Renders are cheap and frequent, and the fetch is async — a stale response
  // must not overwrite a newer one after switching workspace.
  const token = ++peopleToken;
  if (!handlers.loadMembers) { box.innerHTML = ""; return; }

  try {
    const members = await handlers.loadMembers();
    if (token !== peopleToken) return;
    box.innerHTML = members.map(memberRow).join("");
  } catch (err) {
    if (token !== peopleToken) return;
    // Never leave an empty list: "nobody is here" and "we couldn't ask" look
    // identical, and one of them is alarming for the wrong reason.
    box.innerHTML = `<p class="wp-empty">${
      err && err.code === "permission-denied"
        ? "Couldn't load the list — your access may have changed."
        : "Couldn't load the list."
    }</p>`;
  }
}

function memberRow(m) {
  const me = !!(S.user && S.user.email === m.email);
  const label = m.displayName || m.email;
  // An admin may change anyone's role EXCEPT their own — the rules refuse that,
  // so no self-demotion can strand a workspace with no admin — and except the
  // CLI-provisioned protected founder.
  const mayManage = isAdmin() && !me && !m.isProtected;

  const notes = [];
  if (m.isProtected) notes.push("founder");
  if (!m.signedIn) notes.push("not signed in yet");

  return `<div class="wp-member" data-email="${esc(m.email)}">` +
      `<span class="wp-member-who">` +
        // The "you" chip is a SIBLING of the name, not nested inside it, so the
        // name element's text is just the name.
        `<span class="wp-member-line">` +
          `<span class="wp-member-name">${esc(label)}</span>` +
          (me ? `<span class="wp-you">you</span>` : "") +
        `</span>` +
        (m.displayName ? `<span class="wp-member-mail">${esc(m.email)}</span>` : "") +
        (notes.length ? `<span class="wp-member-note">${esc(notes.join(" · "))}</span>` : "") +
      `</span>` +
      (mayManage
        ? `<select class="wp-member-role" data-email="${esc(m.email)}" aria-label="Role for ${esc(m.email)}">` +
            ["admin", "editor", "viewer"].map((r) =>
              `<option value="${r}"${r === m.role ? " selected" : ""}>${ROLE_NAME[r]}</option>`).join("") +
          `</select>`
        : `<span class="wp-role role-${esc(m.role)}">${esc(m.role)}</span>`) +
      (mayManage
        ? `<button class="wp-icon wp-remove" data-remove="${esc(m.email)}" title="Remove from this workspace" aria-label="Remove ${esc(m.email)}">×</button>`
        : "") +
    `</div>`;
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
    (mayEdit ? `<button class="wp-add wp-newboard" type="button">＋ New board</button>` : "") +
  `</div>`;
}

// ---------------------------------------------------------------------------
// Inline naming, replacing the two prompt() calls the app used to use for
// creating and renaming boards. prompt() was the least sleek thing in the app:
// it is unstyleable, blocks the whole page, and looks nothing like the rest.
//
// Both entry points swap a row for a text field in place. Enter commits, and
// Escape or blur abandons — matching the workspace-name field's existing
// behaviour, so there is one convention for naming things.
// ---------------------------------------------------------------------------

function inlineField(value, onCommit) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "wp-inline";
  input.value = value || "";
  input.maxLength = 120;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Board name");

  let settled = false;
  const finish = (commit) => {
    if (settled) return;           // Enter fires blur too; only act once
    settled = true;
    const name = input.value.trim();
    if (commit && name) onCommit(name);
    renderPanel();                 // always repaint back to the real rows
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    // Stop Escape reaching the panel's handler, or abandoning a name would also
    // close the whole panel.
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener("blur", () => finish(false));
  return input;
}

export function beginNewBoard() {
  const anchor = $("wp-workspaces").querySelector(".wp-newboard");
  if (!anchor) return;
  const field = inlineField("", (name) => {
    if (handlers.onCommitNewBoard) handlers.onCommitNewBoard(name);
  });
  field.placeholder = "Board name";
  anchor.replaceWith(field);
  field.focus();
}

export function beginRenameBoard(boardId) {
  const row = $("wp-workspaces").querySelector(`.wp-board[data-board="${CSS.escape(boardId)}"]`);
  if (!row) return;
  const current = (S.registry.find((b) => b.id === boardId) || {}).name || "";
  const field = inlineField(current, (name) => {
    if (handlers.onCommitRenameBoard) handlers.onCommitRenameBoard(boardId, name);
  });
  row.replaceWith(field);
  field.focus();
  field.select();
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
