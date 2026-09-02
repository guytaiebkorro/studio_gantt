// ---------------------------------------------------------------------------
// The People section of the Workspace panel: who's in, what they can do, and
// inviting more.
//
// The controls here are an affordance, not a boundary. The role dropdown omits
// "admin" unless you're an admin, but every write still calls canAssignRole()
// first AND is checked again by firestore.rules — which is the only thing that
// actually decides. A permission-denied from any of these is the rules working,
// not a bug, and is reported as such.
// ---------------------------------------------------------------------------
import { $, esc, toast } from "../dom.js";
import { S } from "../state.js";
import { canInvite, canAssignRole, isAdmin } from "../permissions.js";
import { listMembers, inviteMember, setMemberRole, removeMember } from "../memberships.js";

const ROLE_LABEL = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

let rendering = false;

export function clearMembers() {
  const box = $("c-members");
  if (box) box.innerHTML = "";
}

export async function renderMembers() {
  const box = $("c-members");
  const section = $("c-people");
  if (!box || !section) return;

  if (!S.ws.id || S.gate !== "open") { section.style.display = "none"; return; }
  section.style.display = "";

  // Viewers see the roster (so they know who to ask) but get no controls.
  const mayInvite = canInvite();
  const row = $("c-invite-row");
  if (row) row.style.display = mayInvite ? "" : "none";
  const hint = $("c-invite-hint");
  if (hint) hint.style.display = mayInvite ? "" : "none";

  // Only admins can hand out admin. The option is REMOVED rather than disabled
  // so it can't be re-enabled from devtools and produce a confusing rejection.
  const sel = $("c-invite-role");
  if (sel) {
    const adminOpt = sel.querySelector('option[value="admin"]');
    if (adminOpt && !isAdmin()) adminOpt.remove();
  }

  if (rendering) return;
  rendering = true;
  box.innerHTML = `<div class="hint">Loading…</div>`;
  try {
    const members = await listMembers(S.ws.id);
    box.innerHTML = members.map(renderRow).join("");
  } catch (err) {
    box.innerHTML = `<div class="hint">Couldn't load the member list${
      err.code === "permission-denied" ? " — your access may have changed" : ""}.</div>`;
  } finally {
    rendering = false;
  }
}

function renderRow(m) {
  const me = S.user && S.user.email === m.email;
  // An admin may change anyone's role EXCEPT their own (the rules refuse it, so
  // that no self-demotion can strand a workspace with no admin) and except the
  // CLI-provisioned protected founder.
  const editable = isAdmin() && !me && !m.isProtected;
  const roleCell = editable
    ? `<select class="member-role" data-email="${esc(m.email)}">` +
        ["admin", "editor", "viewer"].map((r) =>
          `<option value="${r}"${r === m.role ? " selected" : ""}>${ROLE_LABEL[r]}</option>`).join("") +
      `</select>`
    : `<span class="ws-badge role-${esc(m.role)}">${esc(ROLE_LABEL[m.role] || m.role)}</span>`;

  const notes = [];
  if (me) notes.push("you");
  if (m.isProtected) notes.push("founder");
  if (!m.signedIn) notes.push("not signed in yet");

  return `<div class="member-row">` +
      `<span class="ws-name">${esc(m.displayName || m.email)}` +
        (m.displayName ? `<span class="member-mail">${esc(m.email)}</span>` : "") +
      `</span>` +
      roleCell +
      (notes.length ? `<span class="member-note">${esc(notes.join(" · "))}</span>` : "") +
      (isAdmin() && !me && !m.isProtected
        ? `<button class="ws-forget" data-remove="${esc(m.email)}" title="Remove from this workspace">&times;</button>`
        : "") +
    `</div>`;
}

async function doInvite() {
  const emailEl = $("c-invite-email");
  const roleEl = $("c-invite-role");
  const email = (emailEl.value || "").trim().toLowerCase();
  const role = roleEl.value;
  if (!email) { toast("Enter an email address"); return; }
  if (!canAssignRole(role)) { toast(`You can't invite someone as ${role}`); return; }

  const btn = $("c-invite-btn");
  btn.disabled = true;
  try {
    await inviteMember(S.ws.id, email, role);
    emailEl.value = "";
    toast(`Invited ${email} as ${role} — they're in next time they sign in`);
    await renderMembers();
  } catch (err) {
    // The most likely cause is a malformed address: the member document's ID is
    // the email, and the rules validate it with an ASCII pattern that is
    // narrower than RFC 5321 (a '/' is legal in an address but illegal in a
    // document id).
    toast(err.code === "permission-denied"
      ? "Refused — check the address is a plain lowercase email, and that you can grant that role"
      : "Invite failed: " + (err.message || err.code));
  } finally {
    btn.disabled = false;
  }
}

// --- wiring -----------------------------------------------------------------
$("c-invite-btn").addEventListener("click", () => { doInvite(); });
$("c-invite-email").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); doInvite(); }
});

$("c-members").addEventListener("change", async (e) => {
  const sel = e.target.closest(".member-role");
  if (!sel) return;
  const email = sel.dataset.email;
  const role = sel.value;
  if (!canAssignRole(role)) { toast(`You can't set someone to ${role}`); await renderMembers(); return; }
  try {
    await setMemberRole(S.ws.id, email, role);
    toast(`${email} is now ${role}`);
  } catch (err) {
    toast("Couldn't change that role: " + (err.message || err.code));
  }
  await renderMembers();
});

$("c-members").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-remove]");
  if (!btn) return;
  const email = btn.dataset.remove;
  if (!confirm(`Remove ${email} from “${S.workspaceName}”?\nThey lose access immediately.`)) return;
  try {
    await removeMember(S.ws.id, email);
    toast(`Removed ${email}`);
  } catch (err) {
    toast("Couldn't remove them: " + (err.message || err.code));
  }
  await renderMembers();
});
