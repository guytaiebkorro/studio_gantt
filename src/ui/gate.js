// ---------------------------------------------------------------------------
// The startup gate (#auth-overlay).
//
// A PURE VIEW. It renders one of four states and reports clicks through the
// callbacks handed to wireGate(). It imports only dom.js, which is what keeps
// the import graph honest: session.js and boards.js both depend on this, and if
// this module reached back into either of them we would gain a second cycle
// alongside the load-bearing state -> sync -> boards one.
//
// It is NOT a workspace picker. The slide-over panel (ui/panel.js) is the app's
// one and only workspace list, at startup and afterwards, so this module handles
// exactly three states: sign in, you have no workspaces, and you don't have
// access to the one you asked for.
//
// Non-dismissable on purpose: no close button, no wireBackdropClose, and
// main.js's Escape handler does not name #auth-overlay. Signed out or with no
// workspace, there is nothing behind it to look at.
// ---------------------------------------------------------------------------
import { $ } from "../dom.js";

const overlay = $("auth-overlay");
const modal = overlay ? overlay.querySelector(".gate") : null;

let handlers = {};

export function wireGate(h) {
  handlers = h || {};
  $("gate-google").addEventListener("click", () => {
    // Straight through to the handler with NO awaits before signInWithPopup —
    // Safari blocks a popup that isn't opened synchronously from the click.
    if (handlers.onSignIn) handlers.onSignIn();
  });
  $("gate-signout").addEventListener("click", () => { if (handlers.onSignOut) handlers.onSignOut(); });
  $("gate-refresh").addEventListener("click", () => { if (handlers.onRefresh) handlers.onRefresh(); });
  $("gate-copy-email").addEventListener("click", copyEmail);
}

// view: "boot" | "signin" | "empty" | "denied"
// data: { email, error, busy }
export function showGate(view, data) {
  if (!modal) return;
  data = data || {};
  modal.dataset.view = view;

  // The signed-in-as footer is meaningless before sign-in.
  const foot = modal.querySelector(".gate-foot");
  if (foot) foot.style.display = (view === "signin" || view === "boot") ? "none" : "";

  const email = data.email || "";
  modal.querySelectorAll(".gate-email").forEach((el) => { el.textContent = email; });
  const who = $("gate-who");
  if (who) who.textContent = email ? `Signed in as ${email}` : "";

  gateStatus(data.error || "", data.error ? "err" : "");
  setBusy(!!data.busy);
  overlay.classList.add("show");
}

export function hideGate() {
  if (!overlay) return;
  overlay.classList.remove("show");
  // MUST actually remove .show: uiBusy() in sync.js matches ".overlay.show", so
  // a gate that merely looks hidden would suppress every future refresh and poll.
  setBusy(false);
}

export function gateStatus(msg, kind) {
  const el = $("gate-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "c-status" + (kind ? " " + kind : "");
  el.style.display = msg ? "" : "none";
}

export function setBusy(on) {
  if (!modal) return;
  modal.classList.toggle("busy", !!on);
  for (const id of ["gate-google", "gate-refresh", "gate-signout", "gate-copy-email"]) {
    const b = $(id);
    if (b) b.disabled = !!on;
  }
}

// The exact token email, copyable. This exists because the address an admin
// types and the address on someone's Google account can differ in ways the user
// can't see — Gmail dot-aliases especially — and access is granted per exact
// address. Copying beats retyping.
async function copyEmail() {
  const email = ($("gate-who").textContent || "").replace(/^Signed in as\s*/, "").trim();
  if (!email) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(email);
      gateStatus("Copied — send that exact address to an admin", "ok");
      return;
    }
  } catch (_) { /* fall through */ }
  // Clipboard API needs a secure context; over plain http offer it for manual copy.
  prompt("Copy your email address:", email);
}
