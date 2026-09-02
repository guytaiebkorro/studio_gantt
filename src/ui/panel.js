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
import { $ } from "../dom.js";

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
