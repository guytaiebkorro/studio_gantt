// ---------------------------------------------------------------------------
// Bootstrap. This is the entry point loaded by index.html
// (<script type="module" src="src/main.js">).
//
// Importing the modules below runs their top-level wiring (event listeners on
// the toolbar, editor, workspace panel, etc.); this file then performs first-run
// setup and hands off to session.js.
//
// Startup is AUTH-FIRST now. It used to read a credential out of localStorage
// and connect synchronously behind the loading veil. It can't: auth.currentUser
// is null synchronously at boot even for a valid persisted session, so session.js
// waits on the first onAuthStateChanged before deciding anything, and owns the
// veil until then.
// ---------------------------------------------------------------------------
import { $, chartPane } from "./dom.js";
import { S } from "./state.js";
import { dateToX, today } from "./dates.js";
import { render } from "./render/index.js";
import { setupTheme } from "./theme.js";
import { applyLockUI, updateViewButtons, updateModeButtons } from "./ui/toolbar.js";
import { renderSwatches, closeEditor } from "./ui/editor.js";
import { closeGroupEditor } from "./ui/groupEditor.js";
import { flushSave, refreshOnActivate, boardOpen } from "./sync.js";
import { updateCloudUI, closeCloud } from "./boards.js";
import { canEdit } from "./permissions.js";
import { save } from "./persistence.js";
import { startSession } from "./session.js";
import "./ui/interactions.js";  // ensure its top-level wiring runs
import "./ui/members.js";       // ditto — the People panel wires its own handlers

// --- window-level shortcuts & lifecycle ---
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  // Note the deliberate omission of #auth-overlay: the startup gate is not
  // dismissable, because behind it there is either no session or no workspace.
  if (e.key === "Escape") { closeEditor(); closeGroupEditor(); closeCloud(); }
});
// warn before leaving with unsaved changes
window.addEventListener("beforeunload", (e) => {
  if (S.dirty) { e.preventDefault(); e.returnValue = ""; }
});
// On tab hide (switch away / minimize): flush any pending batched save.
// On tab show: reload data + refresh the clock-derived UI (today marker, progress).
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (S.dirty && canEdit() && boardOpen()) flushSave(); }
  else refreshOnActivate();
});
// Window regaining focus is the desktop-browser equivalent of "becomes active".
window.addEventListener("focus", refreshOnActivate);

// --- startup ---
function init() {
  renderSwatches();
  applyLockUI();       // start read-only
  updateViewButtons();
  updateModeButtons(); // restore the saved gantt/tasks view before first render
  updateCloudUI();
  render();            // paint an empty board behind the gate so the veil has something to lift onto
  scrollToToday();

  // Everything from here — who's signed in, which workspaces they have, what to
  // open — is session.js's decision tree. It owns the loading veil until it
  // either opens a board or shows the gate.
  startSession();
}

function scrollToToday() {
  requestAnimationFrame(() => {
    const x = dateToX(today());
    chartPane.scrollLeft = Math.max(0, x - chartPane.clientWidth / 2);
  });
}

setupTheme(); // sync the theme button to whatever the <head> script set
init();
