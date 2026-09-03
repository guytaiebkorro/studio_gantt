// ---------------------------------------------------------------------------
// Invite dialog cases.
//
// Owned by the invite workstream, so two people working in parallel never edit
// the same test file. Imported (and awaited) from the end of suite.js.
//
// Import from ../harness.js, NEVER from ../suite.js: suite.js is suspended on
// the very `await import()` that loads this file, and a static import of a
// module that is mid-evaluation waits on its evaluation promise. That is a
// deadlock, and it presents as the whole run timing out with no failure to
// point at.
//
// What is under test here is MODALITY and the FIELD, not the role segments —
// suite.js T7 already covers those, and duplicating them here would just mean
// two places to update.
// ---------------------------------------------------------------------------
import { ck, note, sleep, $, MEMBERS, calls, setup } from "../harness.js";

// THREE levels up, not two: this file sits in tools/ui-test/cases/, one deeper
// than suite.js and harness.js. `../../src/…` resolves to tools/src/… and fails
// at run time as an unhandled "Failed to fetch dynamically imported module",
// which the suite reports through window.onerror and then times out.
const panel = await import("../../../src/ui/panel.js");

// suite.js has a peopleHandlers() of its own, but it is a local function in a
// module this file must not import (see the header). Six lines is cheaper than
// a deadlock.
function peopleHandlers(extra) {
  return Object.assign({
    loadMembers: async () => MEMBERS.map((m) => ({ ...m })),
    onSetRole: (email, role) => { calls.push(["setRole", email, role]); },
    onRemoveMember: (email) => { calls.push(["removeMember", email]); },
    onOpenInvite: () => { calls.push(["openInvite"]); }
  }, extra || {});
}

const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const key = (el, k, opt) =>
  el.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true }, opt)));
const type = (v) => {
  $("invite-email").value = v;
  $("invite-email").dispatchEvent(new Event("input", { bubbles: true }));
};
const blur = () => $("invite-email").dispatchEvent(new Event("blur"));
// parseFloat, not Number: computed lengths come back as "44px" and Number()
// gives NaN for those, which then compares false against everything silently.
const num = (s) => parseFloat(s) || 0;

// Open it the way a keyboard user would, so the focus-restore assertion has a
// real element to go back to. dispatchEvent does not move focus by itself.
function openViaButton() {
  $("wp-invite-open").focus();
  click($("wp-invite-open"));
}

let invited = null;
await setup("admin");
panel.wirePanel(peopleHandlers({
  onOpenInvite: () => panel.openInvite(),
  onInvite: (email, role) => { invited = [email, role]; return Promise.resolve(); }
}));
panel.renderPanel();
panel.openPanel();
await sleep(200);                       // let the roster land, so lastRoster is warm

// --- stacking --------------------------------------------------------------
// Issue #1's first half. The dialog used to claim 100 while the panel claimed
// 151, so it painted UNDERNEATH the thing it was opened from.
const zDlg = num(getComputedStyle($("invite-dialog")).zIndex);
const zPanel = num(getComputedStyle($("ws-panel")).zIndex);
ck("stacking: the dialog outranks the panel", zDlg > zPanel, true);
ck("stacking: ...and the panel is actually layered at all", zPanel > 0, true);

// --- opening ---------------------------------------------------------------
openViaButton();
ck("modality: the dialog opens", $("invite-dialog").classList.contains("show"), true);
// uiBusy() in sync.js matches ".overlay.show" to pause polling while a modal is
// being filled in. Losing this class would silently break syncing, not the UI.
ck("regress: the dialog is still an .overlay (uiBusy contract)",
   $("invite-dialog").classList.contains("overlay"), true);
ck("a11y: it announces itself as a modal dialog",
   document.querySelector(".invite-modal").getAttribute("aria-modal"), "true");
ck("a11y: ...labelled by its own heading",
   document.querySelector(".invite-modal").getAttribute("aria-labelledby"), "invite-title");
ck("regress: #invite-ws is still plain text", $("invite-ws").textContent, "Game Dev");

// --- focus -----------------------------------------------------------------
ck("focus: lands on the email field on open", document.activeElement, $("invite-email"));

// The panel behind is removed from hit-testing AND from the tab order. inert is
// reinforcement — trapTab below is the mechanism — so an old Chrome skips
// rather than fails.
if ("inert" in HTMLElement.prototype) {
  ck("modality: the panel behind is inert while the dialog is up", $("ws-panel").inert, true);
} else {
  note("modality: no `inert` support in this browser — skipped (the focus trap covers it)");
}

// Tab wraps inside the dialog rather than walking out into the panel.
const focusables = Array.from($("invite-dialog").querySelectorAll(
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
ck("focus: the dialog has a focusable ring", focusables.length >= 4, true);
const firstF = focusables[0];
const lastF = focusables[focusables.length - 1];
ck("focus: the first focusable is the email field", firstF, $("invite-email"));
ck("focus: the last focusable is Send", lastF, $("invite-send"));
lastF.focus();
key(lastF, "Tab");
ck("focus: Tab from the last focusable wraps to the first", document.activeElement, firstF);
key(firstF, "Tab", { shiftKey: true });
ck("focus: Shift+Tab from the first wraps to the last", document.activeElement, lastF);

// --- modality --------------------------------------------------------------
// The bug: clicking outside the dialog dismissed the PANEL out from under it.
click($("ws-scrim"));
await sleep(40);
ck("modality: a scrim click cannot close the panel while the dialog is up",
   document.body.classList.contains("panel-open"), true);
ck("modality: ...and the dialog is untouched by it",
   $("invite-dialog").classList.contains("show"), true);

// Send or Cancel only. wireBackdropClose() is deliberately not wired: brushing
// the backdrop must not throw away a typed address.
click($("invite-dialog"));
await sleep(40);
ck("modality: a backdrop click does not dismiss the dialog",
   $("invite-dialog").classList.contains("show"), true);

// Escape unwinds one layer at a time.
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(40);
ck("modality: Escape closes the dialog", $("invite-dialog").classList.contains("show"), false);
ck("modality: ...and leaves the panel open", panel.isPanelOpen(), true);
ck("focus: returns to the button that opened it", document.activeElement, $("wp-invite-open"));
if ("inert" in HTMLElement.prototype) {
  ck("modality: the panel is interactive again once the dialog closes", $("ws-panel").inert, false);
}

window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(40);
ck("modality: Escape again then closes the panel", panel.isPanelOpen(), false);

// --- the field -------------------------------------------------------------
panel.openPanel();
await sleep(200);
openViaButton();

// Trap #4: `.modal input[type=email]` in modals.css pads the input to 11px. If
// this reads 11 the new rules lost the specificity fight and the "field" is a
// plain box wearing a wrapper.
const inputPad = num(getComputedStyle($("invite-email")).paddingLeft);
ck("field: the wrapper's inset beats .modal input[type=email]", inputPad >= 40, true);
ck("field: the slab is a slab, not a form control",
   num(getComputedStyle($("invite-field")).height) >= 50, true);
ck("field: the floating label needs a blank placeholder to work",
   $("invite-email").getAttribute("placeholder"), " ");

// Malformed: says so, and does not report an invite.
invited = null;
type("nope@nowhere");
click($("invite-send"));
await sleep(80);
ck("field: a malformed address does not invite", invited, null);
ck("field: ...it marks the field", $("invite-field").classList.contains("is-invalid"), true);
ck("field: ...and says what is wrong",
   $("invite-field-msg").textContent, "That doesn't look like an email address.");
ck("field: ...and the dialog stays open to fix it",
   $("invite-dialog").classList.contains("show"), true);

// Never scold while typing: the next keystroke takes the verdict back.
type("nope@nowhere.io");
ck("field: the error clears on the next keystroke",
   $("invite-field").classList.contains("is-invalid"), false);
ck("field: ...and so does the message", $("invite-field-msg").textContent, "");

// A blur on a good, unknown address is a quiet confirmation.
blur();
ck("field: a valid unknown address is confirmed",
   $("invite-field").classList.contains("is-valid"), true);
ck("field: ...with nothing to say about it", $("invite-field-msg").textContent, "");
ck("field: ...and Send is available", $("invite-send").disabled, false);

// Someone already on the roster: answered here rather than by a server refusal
// after the click. Neutral, not an error — nothing is wrong, it just wouldn't
// do anything.
type("  MATAN@Korro.AI  ");
blur();
ck("field: a known member is named, with their role",
   $("invite-field-msg").textContent, "Already an editor in this workspace.");
ck("field: ...that is not an error", $("invite-field").classList.contains("is-invalid"), false);
ck("field: ...Send is disabled", $("invite-send").disabled, true);
ck("field: ...with the reason on the button",
   $("invite-send").title.includes("already an editor"), true);

// And it lets go again on the next edit.
type("matan@korro.a");
ck("field: the block lifts on the next keystroke", $("invite-send").disabled, false);
ck("field: ...and the reason goes with it", $("invite-send").hasAttribute("title"), false);

// The happy path: trimmed, lowercased, and reported once.
invited = null;
type("   Ada.Lovelace@Korro.AI  ");
blur();
click($("invite-send"));
await sleep(120);
ck("field: a valid unknown address invites, trimmed and lowercased",
   JSON.stringify(invited), JSON.stringify(["ada.lovelace@korro.ai", "viewer"]));
ck("modality: the dialog closes after a successful send",
   $("invite-dialog").classList.contains("show"), false);
if ("inert" in HTMLElement.prototype) {
  ck("modality: ...and releases the panel", $("ws-panel").inert, false);
}
panel.closePanel();
ck("modality: after a successful send the panel is closable again", panel.isPanelOpen(), false);

// Leave the DOM as the next case file expects to find it.
panel.closeInvite();
panel.closePanel();
