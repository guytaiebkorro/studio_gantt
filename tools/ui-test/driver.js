// ---------------------------------------------------------------------------
// Screenshot driver. Runs inside the real index.html in place of src/main.js,
// exactly like suite.js does, but instead of asserting it puts ONE surface on
// screen and holds it there for shot.mjs to photograph.
//
// Which surface comes from ?shot=<name> on the page URL. The theme is NOT set
// from here — shot.mjs stamps data-theme onto <html> in the served markup,
// which is deterministic in a way localStorage juggling is not.
// ---------------------------------------------------------------------------
import { $, setup, MEMBERS, calls } from "./harness.js";

const which = new URL(location.href).searchParams.get("shot") || "gate";

// The veil is `show` in the shipped markup and session.js normally lowers it.
// Nothing starts a session here, so lower it by hand or every shot is a blank
// "Loading board…" panel.
function unveil() { const el = $("loading"); if (el) el.classList.remove("show"); }

function peopleHandlers(extra) {
  return Object.assign({
    loadMembers: async () => MEMBERS.map((m) => ({ ...m })),
    onSetRole: (email, role) => { calls.push(["setRole", email, role]); },
    onRemoveMember: (email) => { calls.push(["removeMember", email]); },
    onOpenInvite: () => { calls.push(["openInvite"]); }
  }, extra || {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the surfaces ----------------------------------------------------------
const SHOTS = {
  // The signed-out gate. Deliberately does NOT call startSession(): that would
  // reach Firebase Auth for real, and the shot must not depend on the network.
  async gate() {
    const gate = await import("../../src/ui/gate.js");
    gate.wireGate({ onSignIn() {}, onSignOut() {}, onRefresh() {} });
    gate.showGate("signin");
    unveil();
  },

  // The gate's "you're in no workspace" branch, which carries the footer row.
  async gateEmpty() {
    const gate = await import("../../src/ui/gate.js");
    gate.wireGate({ onSignIn() {}, onSignOut() {}, onRefresh() {} });
    gate.showGate("empty", { email: "guy@korro.ai" });
    unveil();
  },

  // The workspace panel with the invite dialog on top of it — the whole point
  // of the stacking fix, so the shot has to show both at once.
  async invite() {
    await setup("admin");
    const panel = await import("../../src/ui/panel.js");
    panel.wirePanel(peopleHandlers({ onOpenInvite: () => panel.openInvite() }));
    panel.renderPanel();
    panel.openPanel();
    await sleep(150);          // let the roster land and the slide-over settle
    panel.openInvite();
    unveil();
  }
};

await (SHOTS[which] || SHOTS.gate)();

// Tell shot.mjs the surface is up. Chrome's own --screenshot fires on load and
// would catch a half-built page; shot.mjs waits for this instead.
try { await fetch("/ready?shot=" + encodeURIComponent(which)); } catch (_) {}
