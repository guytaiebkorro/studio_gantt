// ---------------------------------------------------------------------------
// The single permission gate.
//
// CSS `display:none` IS PRESENTATION. IT IS NOT A GUARD. Every handler that
// mutates S.state, the board registry, or the workspace must call requireEdit()
// (or check canEdit()) first. Before this module existed, several mutating
// handlers — #f-delete, #f-duplicate, #g-delete, #g-save, #import-btn, newBoard,
// renameBoard — relied solely on being hidden by `body.locked` CSS, so anything
// that could dispatch a click (devtools, a keyboard path, a stale stylesheet, a
// modal left open across a lock toggle) could still write.
//
// ROLE decides, and nothing else: admin > editor > viewer, assigned by the
// server. A viewer can never write; an editor can always edit. There used to be
// a second, per-session lock the user toggled from the toolbar; it is gone, and
// the toolbar chip is now a pure readout of the role. `S.locked` survives only
// as a derived mirror of !canWrite() for the CSS that hides edit affordances.
//
// Import rule: this module imports S but never dereferences it at module-eval
// time, only inside function bodies. That keeps it safe to import from anywhere
// despite the load-bearing state.js -> sync.js -> boards.js -> state.js cycle
// documented in boards.js.
// ---------------------------------------------------------------------------
import { toast } from "./dom.js";
import { S } from "./state.js";

export const ROLES = { admin: 3, editor: 2, viewer: 1 };

// The effective role.
//
// `S.role` is assigned by the server (from the member document) once Firebase
// lands, and when set it is AUTHORITATIVE. Only when it is absent do we fall
// back to the legacy signal: S.viewOnly, which today arrives from a view-only
// share link. Absence of both means full rights, preserving the app's current
// behavior exactly.
//
// The order matters. Consulting S.viewOnly first made viewer status a sticky
// latch: applyRole() derives S.viewOnly from canWrite(), so once S.viewOnly was
// true, role() answered "viewer" forever and promoting a viewer to editor left
// their client read-only until a reload.
function role() {
  if (S.role) return S.role;
  return S.viewOnly ? "viewer" : "admin";
}

export function currentRole() { return role(); }
export function atLeast(r) { return (ROLES[role()] || 0) >= (ROLES[r] || 99); }

export function isAdmin() { return atLeast("admin"); }

// Inviting is an editor-level power: whoever can edit can bring people in.
// Which ROLES they may hand out is a separate question — see canAssignRole.
export function canInvite() { return atLeast("editor"); }

// Only admins mint admins; editors may hand out editor/viewer.
export function canAssignRole(r) {
  if (!ROLES[r]) return false;
  return isAdmin() || (canInvite() && r !== "admin");
}

// Role-level write permission.
export function canWrite() { return atLeast("editor"); }

// The predicate for "may this edit happen right now". Use in render and
// predicate paths, where a silent false is the right answer. Identical to
// canWrite() now that the lock is gone; kept as the name every chart-mutation
// path already calls, and as the seam if a second condition ever returns.
export function canEdit() { return canWrite(); }

// Same test, but it explains itself. Use in click handlers: a refusal with no
// feedback reads as a bug.
export function requireEdit() {
  if (canEdit()) return true;
  toast("You have view-only access to this workspace");
  return false;
}

// Role-only gate for WORKSPACE MANAGEMENT — creating and renaming boards,
// renaming the workspace, inviting people. Same test as requireEdit() today;
// the two names still mark which surface a refusal came from.
export function requireWrite() {
  if (canWrite()) return true;
  toast("You have view-only access to this workspace");
  return false;
}

// Adopt the role the server gave us. S.viewOnly is DERIVED from it — it is no
// longer a per-workspace flag remembered in localStorage, so it cannot be
// stale, and closing the tab can never promote a viewer.
//
// Deliberately does not call applyLockUI(): that would pull ui/toolbar.js in
// here and widen the import cycle. Callers invoke it right after.
export function applyRole(r) {
  S.role = ROLES[r] ? r : "viewer";
  S.viewOnly = !canWrite();
  S.locked = S.viewOnly; // derived: the CSS mirror of "you may not write"
  document.body.classList.toggle("view-only", S.viewOnly);
  document.body.classList.toggle("role-editor", canWrite());
  document.body.classList.toggle("role-admin", isAdmin());
}
