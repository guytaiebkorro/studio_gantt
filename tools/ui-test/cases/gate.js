// ---------------------------------------------------------------------------
// Startup gate (#auth-overlay) cases.
//
// Owned by the login workstream, so two people working in parallel never edit
// the same test file. Imported (and awaited) from the end of suite.js.
//
// Import from ../harness.js, NEVER from ../suite.js: suite.js is suspended on
// the very `await import()` that loads this file, and a static import of a
// module that is mid-evaluation waits on its evaluation promise. That is a
// deadlock, and it presents as the whole run timing out with no failure to
// point at.
//
// NOTE THE ../../../ ON THE APP IMPORT. This file is one level deeper than
// suite.js, so the repo root is three up, not two. A wrong depth here does not
// fail as a clean assertion — it throws "Failed to fetch dynamically imported
// module" into window.onerror and then ends the whole run in TIMED OUT.
//
// Most of what the gate promises is a LAYOUT contract, and the evidence for
// that is tools/ui-test/shot.mjs's PNGs, not this file. What is here is the
// part that fails SILENTLY: gate.js is full of `if (!modal) return` guards, so
// a markup change that breaks it produces a gate that simply stops responding
// rather than an error anyone would notice.
// ---------------------------------------------------------------------------
import { ck, note, $ } from "../harness.js";
import { showGate, hideGate, gateStatus, setBusy, wireGate }
  from "../../../src/ui/gate.js";

const overlay = $("auth-overlay");
const VIEWS = ["boot", "signin", "empty", "denied"];
const BUTTONS = ["gate-google", "gate-refresh", "gate-signout", "gate-copy-email"];
const disp = (el) => getComputedStyle(el).display;

// --- the element gate.js binds to at module scope --------------------------
// gate.js does `overlay.querySelector(".gate")` once, at evaluation time, and
// every exported function begins `if (!modal) return`. Lose the .gate element
// and the whole module no-ops without a single error in the console. This is
// the assertion that makes that loud.
ck("gate: #auth-overlay exists", !!overlay, true);
const modal = overlay ? overlay.querySelector(".gate") : null;
ck("gate: a .gate element exists inside it", !!modal, true);
ck("gate: .gate is the element carrying data-view", !!modal && "view" in modal.dataset, true);

// A full-screen sign-in is not a card. It deliberately drops the `.modal`
// class rather than out-specifying modals.css rule by rule, so if `.modal`
// ever comes back the fixed 440px width and the drop shadow come with it.
ck("gate: .gate is not a .modal", !!modal && modal.classList.contains("modal"), false);

// --- views: exactly one section, and the right one -------------------------
for (const view of VIEWS) {
  showGate(view, { email: "guy@korro.ai" });
  const shown = [...modal.querySelectorAll("section[data-when]")]
    .filter((s) => disp(s) !== "none");
  ck(`gate: ${view} shows exactly one section`, shown.length, 1);
  ck(`gate: ${view} shows its own section`,
    shown.length === 1 ? shown[0].dataset.when : null, view);
}

// --- .gate-foot: meaningless before sign-in --------------------------------
// gate.js toggles this with an inline style.display, setting it to "" to
// restore. That means the layout value MUST come from a `display` declaration
// in gate.css — convert it to a class and gate.js stops being able to show it.
const foot = modal.querySelector(".gate-foot");
ck("gate: .gate-foot exists", !!foot, true);
for (const view of VIEWS) {
  showGate(view, { email: "guy@korro.ai" });
  const hidden = view === "boot" || view === "signin";
  ck(`gate: .gate-foot ${hidden ? "hidden" : "shown"} for ${view}`,
    disp(foot) === "none", hidden);
}

// --- identity: every copy of the address, not just the first ---------------
showGate("empty", { email: "guy@korro.ai" });
const mails = [...modal.querySelectorAll(".gate-email")];
ck("gate: there is at least one .gate-email slot", mails.length > 0, true);
ck("gate: EVERY .gate-email carries the address",
  mails.every((el) => el.textContent === "guy@korro.ai"), true);
ck("gate: #gate-who names the signed-in address",
  $("gate-who").textContent, "Signed in as guy@korro.ai");

// copyEmail() parses the address back OUT of #gate-who's text, so that prefix
// is load-bearing, not decoration.
ck("gate: #gate-who's text is parseable back to the address",
  ($("gate-who").textContent || "").replace(/^Signed in as\s*/, "").trim(),
  "guy@korro.ai");

showGate("signin");
ck("gate: no email means an empty #gate-who", $("gate-who").textContent, "");

// --- status line -----------------------------------------------------------
gateStatus("Nope", "err");
ck("gate: gateStatus sets the text", $("gate-status").textContent, "Nope");
ck("gate: gateStatus keeps c-status and adds the kind",
  $("gate-status").className, "c-status err");
ck("gate: a set status is visible", disp($("gate-status")) !== "none", true);
gateStatus("Copied", "ok");
ck("gate: gateStatus swaps the kind rather than stacking",
  $("gate-status").className, "c-status ok");
gateStatus("");
ck("gate: an empty status is hidden", disp($("gate-status")), "none");
ck("gate: an empty status has no text", $("gate-status").textContent, "");

// --- busy ------------------------------------------------------------------
showGate("empty", { email: "guy@korro.ai" });
setBusy(true);
ck("gate: setBusy(true) marks .gate busy", modal.classList.contains("busy"), true);
ck("gate: setBusy(true) disables every button",
  BUTTONS.every((id) => $(id).disabled), true);
setBusy(false);
ck("gate: setBusy(false) clears busy", modal.classList.contains("busy"), false);
ck("gate: setBusy(false) re-enables every button",
  BUTTONS.every((id) => !$(id).disabled), true);

// showGate is the other way in and out of busy — data.busy drives it.
showGate("boot", { busy: true });
ck("gate: showGate({busy:true}) is busy", modal.classList.contains("busy"), true);
showGate("signin");
ck("gate: showGate with no busy flag clears it", modal.classList.contains("busy"), false);

// --- the sign-in click must reach the handler SYNCHRONOUSLY ----------------
// Safari blocks a popup that was not opened synchronously from the click, so
// anything awaited between the listener and signInWithPopup silently breaks
// sign-in on Safari only. Asserting the flag BEFORE yielding is what pins that
// down: a stray `await` in gate.js would leave `when` at "not called".
let when = "not called";
let signIns = 0;
wireGate({
  onSignIn() { signIns++; when = "sync"; },
  onSignOut() {}, onRefresh() {}
});
$("gate-google").dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("gate: #gate-google reached onSignIn before the next microtask", when, "sync");
await Promise.resolve();
ck("gate: onSignIn fired exactly once", signIns, 1);

// No double sign-in while one is in flight. Note what is NOT asserted here: a
// dispatchEvent("click") on a DISABLED button still runs the listener — the
// `disabled` attribute only suppresses real user-generated clicks, so a
// synthetic click cannot test that guard and an assertion built on one just
// records that dispatchEvent ignores `disabled`. The two things that actually
// stop the second click are both declarative, so assert those instead.
setBusy(true);
ck("gate: a busy gate's sign-in button is disabled", $("gate-google").disabled, true);
ck("gate: a busy gate is not hit-testable at all",
  getComputedStyle(modal).pointerEvents, "none");
setBusy(false);
ck("gate: a settled gate is hit-testable again",
  getComputedStyle(modal).pointerEvents, "auto");

// --- sealed ----------------------------------------------------------------
// The gate is non-dismissable: main.js's Escape handler deliberately does not
// name #auth-overlay and nothing wires a backdrop close. main.js is NOT loaded
// in this suite (suite.js runs in its place), so what this actually pins down
// is that gate.js itself never grew an Escape or backdrop dismissal of its own.
showGate("signin");
document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
ck("gate: Escape does not dismiss the gate", overlay.classList.contains("show"), true);
overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
ck("gate: a backdrop click does not dismiss the gate",
  overlay.classList.contains("show"), true);
// "No close button" spelled out as an inventory rather than as a guess at what
// a close button would be called: the gate has exactly four, all of them known.
ck("gate: the gate has no button beyond the four known ones",
  [...modal.querySelectorAll("button")].map((b) => b.id).sort().join(","),
  [...BUTTONS].sort().join(","));

// --- the full-screen paint -------------------------------------------------
// Not a look-and-feel assertion — a regression guard. `.overlay` in modals.css
// is a translucent scrim with a backdrop blur, which is correct over a board
// and wrong for a sign-in page: it let the toolbar and the empty grid show
// through, so the gate read as an interruption rather than as its own screen.
// gate.css overrides both, and only the cascade is holding it.
const ocs = getComputedStyle(overlay);
ck("gate: the gate surface has no backdrop blur", ocs.backdropFilter, "none");
ck("gate: the gate surface is opaque (no alpha in its base colour)",
  /rgba?\([^)]*,\s*(0|0?\.\d+)\)/.test(ocs.backgroundColor), false);
ck("gate: the gate fills the viewport width",
  Math.round(overlay.getBoundingClientRect().width),
  document.documentElement.clientWidth);

// Google brand guidance pins the button's surface white and its label #3c4043
// in BOTH themes. Only the active theme is observable here — the suite runs
// light — and the dark one is verified in shot.mjs's PNGs.
ck("gate: the Google button's surface is white",
  getComputedStyle($("gate-google")).backgroundColor, "rgb(255, 255, 255)");

// --- brand reach -----------------------------------------------------------
// "Korro Gantt" is approved for the login screen and NOWHERE else, so both
// halves are worth pinning: the tempting next commit is to sweep the name.
ck("gate: the wordmark reads Korro Gantt",
  (modal.querySelector(".gate-wordmark").textContent || "").replace(/\s+/g, ""),
  "KorroGantt");

// Read from the SERVED MARKUP, not from the live DOM. boards.js:238 renames the
// tab after the open workspace and updateWorkspaceButton() does the same to
// #cloud-label, so by the time this file runs both say "Game Dev" — asserting
// on the DOM would be asserting on the fixture, not on the brand decision.
const served = await fetch("/index.html").then((r) => r.text()).catch(() => "");
ck("gate: the served <title> is still plain Gantt",
  /<title>Gantt<\/title>/.test(served), true);
ck("gate: the toolbar's fallback label is still plain Gantt",
  /id="cloud-label">Gantt</.test(served), true);

// --- show / hide, and the uiBusy contract ----------------------------------
// uiBusy() in sync.js matches ".overlay.show". If hideGate() ever stops
// removing .show, every future poll and every refresh-on-activate is silently
// suppressed for the rest of the session — no error, no symptom you would find
// by hand. gate.js:62 carries a comment saying so; this is the assertion.
ck("gate: #auth-overlay carries the .overlay class",
  overlay.classList.contains("overlay"), true);
showGate("signin");
ck("gate: showGate raises .show", overlay.classList.contains("show"), true);
ck("gate: an open gate is what uiBusy() sees",
  overlay.matches(".overlay.show"), true);

hideGate();
ck("gate: hideGate removes .show", overlay.classList.contains("show"), false);
ck("gate: hideGate leaves nothing for uiBusy() to match on the gate",
  overlay.matches(".overlay.show"), false);
ck("gate: hideGate also clears busy", modal.classList.contains("busy"), false);

// The plan asks for `document.querySelector(".overlay.show") === null`. Scoped
// to the gate rather than the document on purpose: this file runs after
// cases/invite.js, and a dialog that workstream left open would otherwise fail
// a login assertion. Report the global state instead of asserting on it.
const stillOpen = [...document.querySelectorAll(".overlay.show")].map((e) => e.id || "(unnamed)");
ck("gate: no gate remains in uiBusy's selector", stillOpen.includes("auth-overlay"), false);
note(stillOpen.length
  ? `gate: other overlays still open (not this workstream's): ${stillOpen.join(", ")}`
  : "gate: document has no .overlay.show at all — uiBusy() is clear");

// Leave the app as we found it: signed out of the gate, no status, not busy.
gateStatus("");
setBusy(false);
