// ---------------------------------------------------------------------------
// Chart interactions: dragging/resizing bars and milestones, the selection
// model (single + multi-select), vertical scroll sync between the list and the
// chart, and the endless-timeline extension on horizontal scroll.
// ---------------------------------------------------------------------------
import { EDGE_PX } from "../config.js";
import { $, chartPane, chartBody, listInner } from "../dom.js";
import { S, markDirty, subtreeIds } from "../state.js";
import { canEdit } from "../permissions.js";
import { dayWidth, dateToX, addDays, parseD, fmtD, diffDays, chartWidth } from "../dates.js";
import { render } from "../render/index.js";
import { openEditor } from "./editor.js";

// --- attach handlers to a rendered bar / milestone ---
export function attachBarDrag(bar, t) {
  // A parent bar renders no handles — its span is rolled up from its subtasks,
  // so there is nothing to resize.
  const lh = bar.querySelector(".handle.l");
  const rh = bar.querySelector(".handle.r");
  if (lh) lh.addEventListener("pointerdown", (e) => startResize(e, t, "l"));
  if (rh) rh.addEventListener("pointerdown", (e) => startResize(e, t, "r"));
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("handle")) return;
    startDrag(e, t, bar, false);
  });
  bar.addEventListener("dblclick", () => openEditor(t.id));
}

export function attachMilestoneDrag(m, t) {
  m.addEventListener("pointerdown", (e) => startDrag(e, t, m, true));
  m.addEventListener("dblclick", () => openEditor(t.id));
}

// Unified bar/milestone drag. Ctrl/Cmd/Shift-click tags a task into the
// multi-selection instead of dragging; a plain drag on any tagged task moves
// the whole selection together by the same number of days.
function startDrag(e, t, anchorEl, isMs) {
  const modifier = e.shiftKey || e.metaKey || e.ctrlKey;
  // No edit rights: degrade to selection only. Viewers should still be able to
  // select and inspect, they just can't move anything.
  if (!canEdit()) { modifier ? toggleSelection(t.id) : select(t.id); return; }
  if (modifier) { e.preventDefault(); toggleSelection(t.id); return; }
  // Plain click on an untagged bar selects only it; on an already-tagged bar
  // it keeps the group so the drag moves everything.
  if (!isSelected(t.id)) select(t.id);
  e.preventDefault();
  S.dragging = true;
  const dw = dayWidth();
  const startX = e.clientX;
  // Dragging a parent moves its whole subtree by the same number of days: the
  // parent's own dates are re-derived from the moved children afterwards, so
  // they land on exactly the values set here.
  const dragIds = new Set();
  for (const id of S.selectedIds) for (const sid of subtreeIds(id)) dragIds.add(sid);
  // Snapshot every task in the drag that is currently on screen.
  const items = [...dragIds].map(id => {
    const task = S.state.tasks.find(x => x.id === id);
    const el = chartBody.querySelector(`.bar[data-id="${id}"], .milestone[data-id="${id}"]`);
    if (!task || !el) return null;
    return { task, el, ms: el.classList.contains("milestone"),
             origStart: parseD(task.start), origEnd: parseD(task.end) };
  }).filter(Boolean);
  anchorEl.setPointerCapture(e.pointerId);
  function move(ev) {
    const delta = Math.round((ev.clientX - startX) / dw);
    for (const it of items) {
      const nx = dateToX(addDays(it.origStart, delta));
      it.el.style.left = (it.ms ? nx - 9 : nx) + "px";
    }
  }
  function up(ev) {
    S.dragging = false;
    anchorEl.releasePointerCapture(e.pointerId);
    anchorEl.removeEventListener("pointermove", move);
    anchorEl.removeEventListener("pointerup", up);
    const delta = Math.round((ev.clientX - startX) / dw);
    if (delta !== 0) {
      for (const it of items) {
        it.task.start = fmtD(addDays(it.origStart, delta));
        it.task.end = it.ms ? it.task.start : fmtD(addDays(it.origEnd, delta));
      }
      markDirty(); render();
    }
  }
  anchorEl.addEventListener("pointermove", move);
  anchorEl.addEventListener("pointerup", up);
}

function startResize(e, t, side) {
  if (!canEdit()) return;
  e.preventDefault(); e.stopPropagation();
  select(t.id);
  S.dragging = true;
  const dw = dayWidth();
  const startX = e.clientX;
  const origStart = parseD(t.start), origEnd = parseD(t.end);
  const target = e.target;
  target.setPointerCapture(e.pointerId);
  function move(ev) {
    const delta = Math.round((ev.clientX - startX) / dw);
    const bar = target.parentElement;
    if (side === "l") {
      const ns = addDays(origStart, Math.min(delta, diffDays(origStart, origEnd)));
      bar.style.left = dateToX(ns) + "px";
      bar.style.width = ((diffDays(ns, origEnd) + 1) * dw) + "px";
    } else {
      const ne = addDays(origEnd, Math.max(delta, -diffDays(origStart, origEnd)));
      bar.style.width = ((diffDays(origStart, ne) + 1) * dw) + "px";
    }
  }
  function up(ev) {
    S.dragging = false;
    target.releasePointerCapture(e.pointerId);
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    const delta = Math.round((ev.clientX - startX) / dw);
    if (side === "l") {
      const ns = addDays(origStart, Math.min(delta, diffDays(origStart, origEnd)));
      t.start = fmtD(ns);
    } else {
      const ne = addDays(origEnd, Math.max(delta, -diffDays(origStart, origEnd)));
      t.end = fmtD(ne);
    }
    markDirty(); render();
  }
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
}

// --- selection ---
export function isSelected(id) { return S.selectedIds.has(id); }

// Replace the whole selection with a single task.
export function select(id) {
  S.selectedId = id;
  S.selectedIds = id == null ? new Set() : new Set([id]);
  refreshSelection();
}

// Add/remove one task from the selection (used for tagging several together).
export function toggleSelection(id) {
  if (S.selectedIds.has(id)) {
    S.selectedIds.delete(id);
    if (S.selectedId === id) S.selectedId = [...S.selectedIds].pop() || null;
  } else {
    S.selectedIds.add(id);
    S.selectedId = id;
  }
  refreshSelection();
}

// Sync the .selected / .sel classes in the chart, list and tasks view to selectedIds.
export function refreshSelection() {
  chartBody.querySelectorAll(".bar, .milestone").forEach(el => {
    el.classList.toggle("selected", S.selectedIds.has(el.dataset.id));
  });
  listInner.querySelectorAll(".list-row.task-row").forEach(el => {
    el.classList.toggle("sel", S.selectedIds.has(el.dataset.id));
  });
  const tasksInner = $("tasks-inner");
  if (tasksInner) tasksInner.querySelectorAll(".tv-row").forEach(el => {
    el.classList.toggle("sel", S.selectedIds.has(el.dataset.id));
  });
}

// --- scroll sync (list <-> chart vertical) + endless timeline extension ---
chartPane.addEventListener("scroll", () => {
  listInner.style.transform = `translateY(${-chartPane.scrollTop}px)`;
  if (S.extending) return;
  const dw = dayWidth();
  let addN = Math.ceil((chartPane.clientWidth * 1.5) / dw);
  addN = Math.ceil(addN / 7) * 7; // keep week columns aligned
  if (chartPane.scrollLeft < EDGE_PX) {
    // extend into the past; re-anchor scroll so the view doesn't jump
    S.extending = true;
    S.rangeStart = addDays(S.rangeStart, -addN);
    render();
    chartPane.scrollLeft += addN * dw;
    S.extending = false;
  } else if (chartPane.scrollLeft + chartPane.clientWidth > chartWidth() - EDGE_PX) {
    // extend into the future
    S.extending = true;
    S.rangeEnd = addDays(S.rangeEnd, addN);
    render();
    S.extending = false;
  }
});

// The left list only mirrors the chart's scroll (overflow: hidden), so wheel
// events over it would otherwise do nothing — forward them to the chart pane,
// whose scroll handler re-syncs the list. Chart stays the single scroll owner.
$("list-pane").addEventListener("wheel", (e) => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : 1; // line-mode deltas (Firefox) → px
  chartPane.scrollTop += e.deltaY * k;
  chartPane.scrollLeft += e.deltaX * k;
}, { passive: false });

// Click empty chart space to clear the selection.
chartBody.addEventListener("pointerdown", (e) => {
  if (S.dragging) return;
  if (e.target.closest(".bar, .milestone")) return;
  if (S.selectedIds.size) select(null);
});

// Escape clears the current multi-selection (when no editor is open).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("editor-overlay").classList.contains("show") || $("group-overlay").classList.contains("show")) return;
  if (S.selectedIds.size) select(null);
});
