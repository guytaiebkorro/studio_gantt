// ---------------------------------------------------------------------------
// Bootstrap. This is the entry point loaded by index.html
// (<script type="module" src="src/main.js">).
//
// Importing the modules below runs their top-level wiring (event listeners on
// the toolbar, editor, cloud panel, etc.); this file then performs first-run
// setup and starts the app.
// ---------------------------------------------------------------------------
import { $, chartPane } from "./dom.js";
import { S, supportsFS } from "./state.js";
import { dateToX, today } from "./dates.js";
import { render } from "./render/index.js";
import { setupTheme } from "./theme.js";
import { applyLockUI, updateViewButtons } from "./ui/toolbar.js";
import { renderSwatches, closeEditor } from "./ui/editor.js";
import { closeGroupEditor } from "./ui/groupEditor.js";
import { cloudConnected, flushSave } from "./sync.js";
import { initCloudConfig, connect, openCloud, updateCloudUI, closeCloud } from "./boards.js";
import { save } from "./persistence.js";
import "./ui/interactions.js"; // ensure its top-level wiring runs

// --- window-level shortcuts & lifecycle ---
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  if (e.key === "Escape") { closeEditor(); closeGroupEditor(); closeCloud(); }
});
// warn before leaving with unsaved changes
window.addEventListener("beforeunload", (e) => {
  if (S.dirty) { e.preventDefault(); e.returnValue = ""; }
});
// flush any pending batched save when the tab is hidden (switch away / minimize)
document.addEventListener("visibilitychange", () => { if (document.hidden && S.dirty) flushSave(); });

// --- startup ---
function init() {
  initCloudConfig(); // seed S.cloud + backend credential before anything reads them

  if (!supportsFS && !cloudConnected()) {
    const b = $("save-mode-banner");
    if (location.protocol === "file:") {
      // Chrome/Edge DO support in-place save, but the browser blocks the API on file:// pages.
      b.innerHTML = '⚠️ <b>In-place saving is disabled because this page was opened directly from a file</b> ' +
        '(<code>file://</code>). For now, <b>Save</b> downloads an updated copy. ' +
        'To save back into the same file, open it via <code>http://localhost</code> in Chrome/Edge — ' +
        'just double-click <code>serve.command</code> in this folder (see README).';
    } else {
      b.textContent = "This browser doesn't support writing files in place. \"Save\" downloads a fresh gantt.html that you drop into your shared folder. For in-place saving, open it in Chrome or Edge.";
    }
    b.classList.add("show");
  }
  renderSwatches();
  applyLockUI(); // start in view-only mode
  updateCloudUI();
  updateViewButtons();
  if (cloudConnected()) {
    // a key is remembered — connect (discover + load) behind the loading veil.
    // connect() lifts the gate on success; on failure it surfaces an error and
    // we pop the gated panel so the user can re-enter a valid Master Key.
    connect(S.cloud.apiKey)
      .then(ok => { if (!ok) openCloud(); })
      .finally(() => { $("loading").classList.remove("show"); scrollToToday(); });
  } else {
    // no key yet — render an empty board behind a non-dismissable Cloud gate.
    $("loading").classList.remove("show");
    render();
    updateCloudUI();
    openCloud(); // S.cloudGate is true by default → popup can't be closed
    scrollToToday();
  }
}

function scrollToToday() {
  requestAnimationFrame(() => {
    const x = dateToX(today());
    chartPane.scrollLeft = Math.max(0, x - chartPane.clientWidth / 2);
  });
}

setupTheme(); // sync the theme button to whatever the <head> script set
init();
