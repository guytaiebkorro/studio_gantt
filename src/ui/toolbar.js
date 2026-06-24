// ---------------------------------------------------------------------------
// Toolbar: add task / milestone / group, the Day/Week/Month view switch, the
// Today jump, and view-only (lock) mode.
// ---------------------------------------------------------------------------
import { $, chartPane } from "../dom.js";
import { S, markDirty } from "../state.js";
import { xToDate, dateToX, dayWidth, today } from "../dates.js";
import { render } from "../render/index.js";
import { openEditor, toggleMilestoneUI, closeEditor } from "./editor.js";
import { openGroupEditor } from "./groupEditor.js";

export function updateViewButtons() {
  $("view-seg").querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.view === S.state.settings.viewMode));
}

// --- view-only (lock) mode ---
export function applyLockUI() {
  document.body.classList.toggle("locked", S.locked);
  const btn = $("lock-btn");
  btn.classList.toggle("locked", S.locked);
  btn.classList.toggle("editing", !S.locked);
  btn.textContent = S.locked ? "🔒 View only" : "🔓 Editing";
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
$("lock-btn").addEventListener("click", toggleLock);

// --- text filter: show only rows whose task (or group) name matches ---
$("filter-input").addEventListener("input", (e) => {
  S.filter = e.target.value;
  render(); // view-only state — no markDirty, nothing persisted
});
