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
import { $, esc, toast } from "../dom.js";
import { S } from "../state.js";
import { canWrite, canInvite, canAssignRole, isAdmin } from "../permissions.js";
// share.js is a leaf — dom.js and state.js only — so this adds no cycle and
// does not compromise the "pure view" rule above: it is a utility, not
// boards.js reaching back in.
import { buildShareLink, buildInviteMailto, copyText, openMail } from "../share.js";

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

  // Escape closes the panel — unless the invite dialog is on top, which takes
  // Escape first.
  //
  // This is an explicit check rather than stopPropagation() from the dialog,
  // because both listeners sit on `window`: stopPropagation does not stop other
  // listeners on the SAME node, and at the target they fire in registration
  // order, so the panel's (registered first) would win regardless. Checking is
  // order-independent.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !open) return;
    if (isInviteOpen()) return;
    closePanel();
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

  // Invite dialog.
  $("invite-roles").addEventListener("click", (e) => {
    const seg = e.target.closest(".wp-seg");
    if (seg) setInviteRole(seg.dataset.role);
  });
  $("invite-cancel").addEventListener("click", closeInvite);
  $("invite-send").addEventListener("click", () => { submitInvite(); });
  $("invite-email").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitInvite(); }
  });
  // Never scold while someone is still typing: the field is judged on blur and
  // on submit, and any keystroke takes the verdict back.
  $("invite-email").addEventListener("input", clearFieldVerdict);
  $("invite-email").addEventListener("blur", judgeField);
  // Tab must not walk out of a modal dialog into the layer it is covering.
  // `inert` on #ws-panel already removes that layer from the tab order in every
  // current browser; this is the part that works without it, and it also keeps
  // Tab from reaching the browser chrome and back.
  $("invite-dialog").addEventListener("keydown", trapTab);
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
  const more = e.target.closest(".wp-more");
  if (more) {
    e.stopPropagation();
    openWorkspaceMenu(more);
    return;
  }
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
  lastRoster = [];
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
    // Cached for the invite dialog, which uses it to answer "they're already
    // here" before the click rather than letting the rules say it afterwards.
    lastRoster = members;
    box.innerHTML = members.map(memberRow).join("");
  } catch (err) {
    if (token !== peopleToken) return;
    lastRoster = [];               // a stale roster is worse than no roster
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
          // An SVG chevron rotated by CSS. The ▾/▸ glyphs rendered as
          // near-invisible dots at this size.
          `<svg class="wp-chev" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>` +
          `<span class="wp-ws-name">${esc(m.name || m.wsId)}</span>` +
          `<span class="wp-role role-${esc(role)}">${esc(role)}</span>` +
          // Rare and destructive actions live behind a menu on the ACTIVE row
          // only, keeping them out of the main flow.
          (active ? `<button class="wp-icon wp-more" type="button" title="Workspace options" aria-label="Workspace options">⋯</button>` : "") +
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
// Workspace overflow menu.
//
// Rename is admin-only, because the name lives on the workspace document and
// firestore.rules grants `name` to admins while granting `boards` to editors.
//
// Leave is offered to everyone EXCEPT admins. An admin removing themselves
// could leave a workspace nobody can manage, so the rules refuse it and this
// routes through tools/admin instead — better than offering a button that fails.
// ---------------------------------------------------------------------------
function closeMenu() {
  const m = document.querySelector(".wp-menu");
  if (m) m.remove();
  document.removeEventListener("click", onDocClickCloseMenu, true);
}

function onDocClickCloseMenu(e) {
  if (e.target.closest(".wp-menu") || e.target.closest(".wp-more")) return;
  closeMenu();
}

function openWorkspaceMenu(anchor) {
  closeMenu();
  const items = [];
  if (isAdmin()) items.push(`<button class="wp-menu-item" type="button" data-act="rename-ws">Rename workspace</button>`);
  else items.push(`<button class="wp-menu-item danger" type="button" data-act="leave-ws">Leave workspace</button>`);

  const menu = document.createElement("div");
  menu.className = "wp-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = items.join("");
  anchor.closest(".wp-ws-head").appendChild(menu);

  menu.addEventListener("click", (e) => {
    const item = e.target.closest(".wp-menu-item");
    if (!item) return;
    e.stopPropagation();
    const act = item.dataset.act;
    closeMenu();
    if (act === "rename-ws") beginRenameWorkspace();
    if (act === "leave-ws" && handlers.onLeaveWorkspace) handlers.onLeaveWorkspace();
  });

  // Capture phase, so this sees the click before anything re-renders the tree
  // out from under it.
  document.addEventListener("click", onDocClickCloseMenu, true);
}

export function beginRenameWorkspace() {
  const head = $("wp-workspaces").querySelector(".wp-ws.active .wp-ws-head");
  if (!head) return;
  const field = inlineField(S.workspaceName || "", (name) => {
    if (handlers.onCommitRenameWorkspace) handlers.onCommitRenameWorkspace(name);
  });
  field.setAttribute("aria-label", "Workspace name");
  head.replaceWith(field);
  field.focus();
  field.select();
}

// ---------------------------------------------------------------------------
// Invite dialog.
//
// A real modal rather than an inline row: inviting someone is a commitment and
// deserves focus, and it is easy to fat-finger a row you didn't mean to touch.
//
// The role segments carry ONE line of meaning for the SELECTED role, which is
// what replaced the paragraph that used to explain all three upfront.
// ---------------------------------------------------------------------------
const ROLE_NOTE = {
  viewer: "Can see boards, but not change anything.",
  editor: "Can edit boards, and invite viewers and editors.",
  admin: "Can do everything, including managing people."
};

let inviteRole = "viewer";
let inviteEsc = null;
// The last roster renderPeople() fetched, so the dialog can answer "they are
// already here" locally. Presentation only — memberships.js and the rules still
// decide, this just stops the user learning it from a rejection.
let lastRoster = [];
// Whatever had focus when the dialog opened, so closing it doesn't dump a
// keyboard user on <body> with nothing to Tab from.
let inviteReturnFocus = null;

// Deliberately narrower than RFC 5321 and deliberately the same shape the
// member document's id is validated against server-side: it is a document id
// as well as an address, and '/' is legal in one and illegal in the other.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function isInviteOpen() {
  const dlg = $("invite-dialog");
  return !!dlg && dlg.classList.contains("show");
}

export function openInvite() {
  const dlg = $("invite-dialog");
  if (!dlg) return;

  inviteReturnFocus = document.activeElement;

  $("invite-ws").textContent = S.workspaceName || "";
  $("invite-email").value = "";
  inviteStatus("");
  clearFieldVerdict();

  // Only admins may hand out admin. The segment is REMOVED, not disabled: a
  // disabled control can be re-enabled from devtools, and the write would then
  // fail server-side with a confusing rejection. Absence is honest.
  const adminSeg = document.querySelector('#invite-roles [data-role="admin"]');
  if (adminSeg && !isAdmin()) adminSeg.remove();

  setInviteRole("viewer");
  dlg.classList.add("show");
  // The layer behind goes inert: one attribute takes the whole subtree out of
  // hit-testing AND out of the tab order, which is most of what "modal" means.
  // trapTab() is the part that still works where inert doesn't.
  setPanelInert(true);
  $("invite-email").focus();

  // The panel's own Escape handler defers while this is open (see wireOnce),
  // so a plain listener is enough.
  inviteEsc = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    closeInvite();
  };
  window.addEventListener("keydown", inviteEsc);
}

export function closeInvite() {
  const dlg = $("invite-dialog");
  if (dlg) dlg.classList.remove("show");
  if (inviteEsc) { window.removeEventListener("keydown", inviteEsc); inviteEsc = null; }
  clearFieldVerdict();
  // Un-inert BEFORE restoring focus: focusing into an inert subtree is a no-op,
  // so the order here is the whole point.
  setPanelInert(false);
  const back = inviteReturnFocus;
  inviteReturnFocus = null;
  if (back && back.isConnected && typeof back.focus === "function") back.focus();
}

function setPanelInert(on) {
  const p = $("ws-panel");
  if (!p) return;
  // Feature-detected rather than assumed: on a browser without it the focus
  // trap is still the mechanism, and setting an unknown property would just be
  // an inert (sorry) expando.
  if ("inert" in HTMLElement.prototype) p.inert = on;
}

// Tab wraps inside the dialog. Collected on every keypress rather than cached,
// because #invite-send goes in and out of [disabled] and the admin segment can
// have been removed.
function trapTab(e) {
  if (e.key !== "Tab" || !isInviteOpen()) return;
  const dlg = $("invite-dialog");
  const items = Array.from(dlg.querySelectorAll(FOCUSABLE));
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ---------------------------------------------------------------------------
// The field's three-way verdict: nothing said, something wrong, something worth
// confirming. It is set on blur and on submit and cleared on any keystroke —
// telling someone their address is malformed while they are on the third
// character of it is noise, not help.
// ---------------------------------------------------------------------------
function fieldVerdict(cls, msg, msgKind) {
  const field = $("invite-field");
  if (field) {
    field.classList.remove("is-invalid", "is-valid", "is-busy");
    if (cls) field.classList.add(cls);
  }
  const el = $("invite-field-msg");
  if (el) {
    el.textContent = msg || "";
    el.className = "invite-field-msg" + (msgKind ? " " + msgKind : "");
  }
}

function clearFieldVerdict() {
  fieldVerdict(null, "");
  blockSend("");
}

// Disabling Send is presentation: submitInvite() re-checks, and the rules check
// again after that. The `title` is the whole reason to bother — a disabled
// button with no stated reason is worse than one that fails.
function blockSend(reason) {
  const btn = $("invite-send");
  if (!btn) return;
  btn.disabled = !!reason;
  if (reason) btn.title = reason;
  else btn.removeAttribute("title");
}

function rosterMatch(email) {
  return lastRoster.find((m) => String(m && m.email || "").trim().toLowerCase() === email);
}

// "an admin", "an editor", "a viewer". The three roles are a closed set, so
// this is a lookup rather than a guess at English.
const ROLE_ARTICLE = { admin: "an", editor: "an", viewer: "a" };
function alreadyHere(role) {
  return `Already ${ROLE_ARTICLE[role] || "a"} ${role} in this workspace.`;
}
function alreadyHereReason(email, role) {
  return `${email} is already ${ROLE_ARTICLE[role] || "a"} ${role} in this workspace.`;
}

function judgeField() {
  const email = ($("invite-email").value || "").trim().toLowerCase();
  if (!email) { clearFieldVerdict(); return; }

  if (!EMAIL_RE.test(email)) {
    fieldVerdict("is-invalid", "That doesn't look like an email address.", "err");
    blockSend("");            // let the click say it too, rather than swallowing it
    return;
  }
  const known = rosterMatch(email);
  if (known) {
    // Neutral, not an error: nothing is wrong, it just wouldn't do anything.
    fieldVerdict(null, alreadyHere(known.role));
    blockSend(alreadyHereReason(email, known.role));
    return;
  }
  fieldVerdict("is-valid", "");
}

function setInviteRole(role) {
  inviteRole = ROLE_NOTE[role] ? role : "viewer";
  document.querySelectorAll("#invite-roles .wp-seg").forEach((b) => {
    const on = b.dataset.role === inviteRole;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  });
  $("invite-role-note").textContent = ROLE_NOTE[inviteRole];
}

function inviteStatus(msg, kind) {
  const el = $("invite-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "c-status" + (kind ? " " + kind : "");
  el.style.display = msg ? "" : "none";
}

async function submitInvite() {
  const raw = $("invite-email").value || "";
  const email = raw.trim().toLowerCase();

  // Field-level problems are reported ON the field, not in the status line:
  // the status line is for what the server said.
  if (!email) {
    fieldVerdict("is-invalid", "Enter an email address.", "err");
    $("invite-email").focus();
    return;
  }
  if (!EMAIL_RE.test(email)) {
    fieldVerdict("is-invalid", "That doesn't look like an email address.", "err");
    $("invite-email").focus();
    return;
  }
  const known = rosterMatch(email);
  if (known) {
    fieldVerdict(null, alreadyHere(known.role));
    blockSend(alreadyHereReason(email, known.role));
    return;
  }
  if (!canAssignRole(inviteRole)) { inviteStatus(`You can't invite someone as ${inviteRole}`, "err"); return; }

  // Copy the link NOW, in the same task as the click that got us here.
  // navigator.clipboard rejects a write with no live user activation behind it
  // on Safari, and the Firestore round-trip below is easily long enough to lose
  // it — so this cannot wait until the invite succeeds. The link is fully
  // computable beforehand and grants nothing by itself, so the worst case of
  // copying ahead of a failed invite is a stale clipboard entry.
  //
  // The mail draft, by contrast, waits: opening one for an invite that was
  // refused would be worse than not opening one at all.
  const link = buildShareLink();
  const copying = copyText(link);

  const btn = $("invite-send");
  btn.disabled = true;
  fieldVerdict("is-busy", "");
  inviteStatus("Inviting…");
  try {
    if (handlers.onInvite) await handlers.onInvite(email, inviteRole);
    const copied = await copying;
    closeInvite();
    renderPanel();
    // No prompt() fallback when the copy failed: the draft carries the same
    // link in its body, so nobody is left without it.
    toast(copied
      ? `Invited ${email} — link copied, opening your email`
      : `Invited ${email} — opening your email with the link`);
    if (link) {
      openMail(buildInviteMailto({
        email, role: inviteRole, workspace: S.workspaceName, link
      }));
    }
  } catch (err) {
    // The likeliest cause is an address the rules reject: the member document's
    // id IS the email, validated against a pattern narrower than RFC 5321
    // (a '/' is legal in an address but illegal in a document id).
    fieldVerdict("is-invalid", "");
    inviteStatus(
      err && err.code === "permission-denied"
        ? "Refused — check it's a plain lowercase email, and that you can grant that role."
        : "Couldn't invite: " + ((err && err.message) || "unknown error"),
      "err"
    );
  } finally {
    btn.disabled = false;
    btn.removeAttribute("title");
  }
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
  // The invite dialog is modal OVER the panel: sending or cancelling are the
  // only ways out of it, and pulling the panel out from underneath is not one.
  // Guarding here rather than on the scrim's click handler catches every route
  // at once — the scrim, Escape, and any programmatic close — which is why
  // boards.js's onSignOut closes the dialog first instead of fighting this.
  if (isInviteOpen()) return;
  open = false;
  $("ws-panel").setAttribute("aria-hidden", "true");
  document.body.classList.remove("panel-open");
  // Keep the scrim in the DOM until the fade finishes, then take it out of the
  // hit-testing path entirely — a transparent full-viewport div left behind
  // would silently swallow every click on the chart.
  clearTimeout(scrimTimer);
  scrimTimer = setTimeout(() => { if (!open) $("ws-scrim").hidden = true; }, 220);
}
