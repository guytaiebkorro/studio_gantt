// ---------------------------------------------------------------------------
// Toolbar: add task / milestone / group, the Day/Week/Month view switch, the
// Today jump, and view-only (lock) mode.
// ---------------------------------------------------------------------------
import { VIEWTAB_KEY } from "../config.js";
import { $, chartPane } from "../dom.js";
import { S, markDirty } from "../state.js";
import { xToDate, dateToX, dayWidth, today } from "../dates.js";
import { render } from "../render/index.js";
import { openEditor, toggleMilestoneUI, closeEditor } from "./editor.js";
import { openGroupEditor } from "./groupEditor.js";
import { icon } from "../icons.js";

export function updateViewButtons() {
  $("view-seg").querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.view === S.state.settings.viewMode));
}

// --- gantt <-> tasks view toggle ---
let savedCenterDate = null; // chart center, captured before hiding the chart

export function updateModeButtons() {
  // Tolerate older saved-HTML shells that predate the Gantt/Tasks toggle —
  // a missing #mode-seg must not brick startup (the app runs gantt-only).
  const seg = $("mode-seg");
  if (!seg) { S.viewTab = "gantt"; return; }
  seg.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === S.viewTab));
  document.body.classList.toggle("tasks-view", S.viewTab === "tasks");
}

export function setViewTab(mode) {
  if (mode === S.viewTab) return;
  // hiding the chart (display:none) zeroes clientWidth and can drop the scroll
  // position — remember the centered date so we can restore it on return
  if (mode === "tasks") savedCenterDate = xToDate(chartPane.scrollLeft + chartPane.clientWidth / 2);
  S.viewTab = mode;
  try { localStorage.setItem(VIEWTAB_KEY, mode); } catch (_) {}
  updateModeButtons();
  render(); // personal UI state — no markDirty, nothing saved to the board
  if (mode === "gantt") {
    const center = savedCenterDate || today(); // no saved spot (started in tasks view) → today
    requestAnimationFrame(() => {
      chartPane.scrollLeft = Math.max(0, dateToX(center) + dayWidth() / 2 - chartPane.clientWidth / 2);
    });
  }
}

// --- view-only (lock) mode ---
export function applyLockUI() {
  document.body.classList.toggle("locked", S.locked);
  const btn = $("lock-btn");
  btn.classList.toggle("locked", S.locked);
  btn.classList.toggle("editing", !S.locked);
  btn.innerHTML = S.locked ? icon("lock") + "<span>View only</span>" : icon("unlock") + "<span>Editing</span>";
  btn.title = S.locked ? "Read-only — click to start editing" : "Editing — click to lock (view only)";
}
function toggleLock() {
  S.locked = !S.locked;
  if (S.locked) closeEditor();
  applyLockUI();
  render(); // refresh draggable state on list rows etc.
}

// --- wiring ---
$("add-task").addEventListener("click", () => openEditor(null));
$("add-milestone").addEventListener("click", () => {
  openEditor(null);
  $("f-milestone").checked = true; toggleMilestoneUI();
  $("editor-title").textContent = "New Milestone";
});
$("add-group").addEventListener("click", () => openGroupEditor(null));
$("today-btn").addEventListener("click", () => {
  const x = dateToX(today());
  chartPane.scrollTo({ left: Math.max(0, x - chartPane.clientWidth / 2), behavior: "smooth" });
});
$("view-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.view === S.state.settings.viewMode) return;
  // remember the date currently centered in the viewport, then restore it
  const centerDate = xToDate(chartPane.scrollLeft + chartPane.clientWidth / 2);
  S.state.settings.viewMode = b.dataset.view;
  markDirty(); updateViewButtons(); render();
  chartPane.scrollLeft = Math.max(0, dateToX(centerDate) + dayWidth() / 2 - chartPane.clientWidth / 2);
});
if ($("mode-seg")) $("mode-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  setViewTab(b.dataset.mode);
});
$("lock-btn").addEventListener("click", toggleLock);

// --- text filter: show only rows whose task (or group) name matches ---
$("filter-input").addEventListener("input", (e) => {
  S.filter = e.target.value;
  render(); // view-only state — no markDirty, nothing persisted
});
