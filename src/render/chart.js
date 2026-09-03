// ---------------------------------------------------------------------------
// Right chart pane: the date-axis header, grid columns/row lines, task bars and
// milestones, dependency arrows, and the today line.
// ---------------------------------------------------------------------------
import { ROW_H, BAR_PAD, MONTHS, DOW } from "../config.js";
import { chartHeader, chartBody, depSvg, todayLine } from "../dom.js";
import { esc } from "../dom.js";
import { addDays, diffDays, parseD, fmtD, dateToX, today, dayWidth, totalDays, chartWidth, progressOf } from "../dates.js";
import { S, isCollapsed } from "../state.js";
import { attachBarDrag, attachMilestoneDrag, isSelected } from "../ui/interactions.js";
import { attachTip, hideTip } from "../ui/tooltip.js";
import { hasTip, taskTipHtml, checkpointTipHtml, isOutside } from "../ui/taskTip.js";
import { rowIndexOfTask } from "./index.js";

export function renderHeader(w) {
  chartHeader.innerHTML = "";
  const vm = S.state.settings.viewMode;
  const dw = dayWidth();
  const n = totalDays();

  if (vm === "day") {
    for (let i = 0; i < n; i++) {
      const d = addDays(S.rangeStart, i);
      const cell = hdrCell(i * dw, dw);
      if (d.getDay() === 5 || d.getDay() === 6) cell.classList.add("weekend"); // Fri–Sat (matches grid)
      cell.innerHTML = `<span>${DOW[d.getDay()]}</span><span class="big">${d.getDate()}</span>`;
      if (d.getDate() === 1) cell.innerHTML = `<span>${MONTHS[d.getMonth()]}</span><span class="big">${d.getDate()}</span>`;
      chartHeader.appendChild(cell);
    }
  } else if (vm === "week") {
    // week cells (7 days), label = month + start date
    for (let i = 0; i < n; i += 7) {
      const d = addDays(S.rangeStart, i);
      const cell = hdrCell(i * dw, dw * 7);
      cell.innerHTML = `<span>${MONTHS[d.getMonth()]}</span><span class="big">${d.getDate()}</span>`;
      chartHeader.appendChild(cell);
    }
  } else { // month
    let i = 0;
    while (i < n) {
      const d = addDays(S.rangeStart, i);
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const fromIdx = Math.max(0, diffDays(S.rangeStart, monthStart));
      const span = Math.min(n, diffDays(S.rangeStart, monthEnd) + 1) - fromIdx;
      const cell = hdrCell(fromIdx * dw, span * dw);
      cell.innerHTML = `<span class="big">${MONTHS[d.getMonth()]} ${d.getFullYear()}</span>`;
      chartHeader.appendChild(cell);
      i = fromIdx + span;
    }
  }
}
function hdrCell(left, width) {
  const c = document.createElement("div");
  c.className = "hdr-cell";
  c.style.left = left + "px";
  c.style.width = width + "px";
  return c;
}

export function renderGrid(rows, w, h) {
  // remove old grid cols & row lines
  chartBody.querySelectorAll(".grid-col, .row-line").forEach(e => e.remove());
  const vm = S.state.settings.viewMode;
  const dw = dayWidth();
  const n = totalDays();

  // vertical columns
  if (vm === "day" || vm === "week") {
    for (let i = 0; i < n; i++) {
      const d = addDays(S.rangeStart, i);
      const col = document.createElement("div");
      col.className = "grid-col";
      if (d.getDay() === 5 || d.getDay() === 6) col.classList.add("weekend"); // Fri–Sat (Israel)
      if (d.getDate() === 1) col.classList.add("month-start");
      col.style.left = (i * dw) + "px";
      col.style.width = dw + "px";
      chartBody.appendChild(col);
    }
  } else {
    let i = 0;
    while (i < n) {
      const d = addDays(S.rangeStart, i);
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const span = Math.min(n, diffDays(S.rangeStart, monthEnd) + 1) - i;
      const col = document.createElement("div");
      col.className = "grid-col month-start";
      col.style.left = (i * dw) + "px";
      col.style.width = (span * dw) + "px";
      chartBody.appendChild(col);
      i += span;
    }
  }

  // horizontal row lines
  rows.forEach((r, idx) => {
    const line = document.createElement("div");
    line.className = "row-line" + (r.type === "group" ? " group" : "");
    line.style.top = (idx * ROW_H) + "px";
    chartBody.appendChild(line);
  });
}

export function renderBars(rows, w, h) {
  // The hover card describes an element that is about to be destroyed — and a
  // bar vanishing from under the cursor never fires pointerleave.
  hideTip();
  // remove old bars / milestones / labels (checkpoint dots live inside a bar,
  // so they go with it)
  chartBody.querySelectorAll(".bar, .milestone, .ms-label, .gs-label").forEach(e => e.remove());
  const dw = dayWidth();
  rows.forEach((r, idx) => {
    if (r.type === "group") {
      // Always draw a summary bar on the group header row spanning its tasks'
      // date range — an outlined "bracket" track (clearly distinct from the
      // solid task pills) filled by the group's time-based progress.
      // Top-level tasks only — a subtask is already covered by its parent's
      // rolled-up range, so folding it in again would just double-count.
      const members = S.state.tasks.filter(t => !t.parentId && (t.groupId === r.group.id
        || (r.group.id === "__none" && !S.state.groups.some(g => g.id === t.groupId))));
      if (!members.length) return;
      let min = null, max = null;
      for (const t of members) {
        const s = parseD(t.start);
        const e = t.isMilestone ? s : parseD(t.end);
        if (!min || s < min) min = s;
        if (!max || e > max) max = e;
      }
      const top = idx * ROW_H;
      const x = dateToX(min);
      const days = Math.max(1, diffDays(min, max) + 1);
      const prog = progressOf({ start: fmtD(min), end: fmtD(max), isMilestone: false });
      const sum = document.createElement("div");
      sum.className = "bar group-summary";
      sum.style.left = x + "px";
      sum.style.top = (top + (ROW_H - 14) / 2) + "px";
      sum.style.width = (days * dw) + "px";
      sum.style.setProperty("--gs-color", r.group.color);
      sum.innerHTML = `<div class="fill" style="width:${prog.pct}%"></div>`;
      chartBody.appendChild(sum);
      const lbl = document.createElement("div");
      lbl.className = "gs-label";
      lbl.textContent = prog.pct + "%";
      lbl.style.left = (x + days * dw + 8) + "px";
      lbl.style.top = (top + (ROW_H - 14) / 2) + "px";
      chartBody.appendChild(lbl);
      return;
    }
    if (r.type !== "task") return;
    const t = r.task;
    const top = idx * ROW_H;
    if (t.isMilestone) {
      const x = dateToX(parseD(t.start));
      const m = document.createElement("div");
      m.className = "milestone" + (isSelected(t.id) ? " selected" : "");
      m.style.left = (x - 9) + "px";
      m.style.top = (top + (ROW_H - 18) / 2) + "px";
      m.style.background = r.color;
      m.dataset.id = t.id;
      if (hasTip(t)) attachTip(m, taskTipHtml(t));
      chartBody.appendChild(m);
      const lbl = document.createElement("div");
      lbl.className = "ms-label";
      lbl.textContent = t.name;
      lbl.style.left = (x + 14) + "px";
      lbl.style.top = (top + (ROW_H - 14) / 2) + "px";
      chartBody.appendChild(lbl);
      attachMilestoneDrag(m, t);
    } else {
      const x = dateToX(parseD(t.start));
      const days = Math.max(1, diffDays(parseD(t.start), parseD(t.end)) + 1);
      const bw = days * dw;
      const bar = document.createElement("div");
      // A task with subtasks is a container: its span is rolled up from its
      // children, so it wears a fixed --parent-frame outline over a tint of its
      // own colour and offers no resize handles. Shape and frame — not hue —
      // separate it from the pills nested under it, which share its colour.
      bar.className = "bar" + (r.hasKids ? " parent" : "") + (isSelected(t.id) ? " selected" : "");
      bar.style.left = x + "px";
      bar.style.top = (top + BAR_PAD) + "px";
      bar.style.width = bw + "px";
      bar.dataset.id = t.id;
      if (r.hasKids) {
        bar.style.setProperty("--task-color", r.color);
        bar.innerHTML = `<div class="fill" style="width:${progressOf(t).pct}%"></div>
                         <span class="label">${esc(t.name)}</span>`;
      } else {
        bar.style.background = r.color;
        bar.innerHTML = `<div class="fill" style="width:${progressOf(t).pct}%"></div>
                         <div class="handle l"></div>
                         <span class="label">${esc(t.name)}</span>
                         <div class="handle r"></div>`;
      }
      renderCheckpoints(bar, t, x, bw);
      if (hasTip(t)) attachTip(bar, taskTipHtml(t));
      chartBody.appendChild(bar);
      attachBarDrag(bar, t);
    }
  });
}

// Checkpoint dots inside a task's capsule, one per date. Appended AFTER the
// bar's innerHTML so they paint over the absolutely-positioned .fill.
//
// Only the x is set here: .cp-dot centres itself with translateX(-50%) and sits
// in the bar's bottom band, so this function never has to know a dot's size.
// The bar gets .has-cps, which is what hands that band over (see chart.css).
//
// Dots keep default pointer-events on purpose: pointerdown bubbles to the bar,
// so grabbing one drags the task exactly like grabbing anywhere else (only
// .handle is excluded, in attachBarDrag).
const CP_EDGE = 5; // keep a clamped dot's full width inside the capsule
function renderCheckpoints(bar, t, x, bw) {
  const cps = t.checkpoints || [];
  if (!cps.length) return;
  bar.classList.add("has-cps");
  const dw = dayWidth();
  const now = fmtD(today());
  for (const c of cps) {
    // Centre of the checkpoint's day column (the +dw/2 the today line uses too),
    // in bar-local coordinates — then clamped, so a date outside the task's span
    // pins to the capsule's edge instead of being clipped away by
    // .bar { overflow: hidden } and disappearing without a trace.
    const cx = Math.max(CP_EDGE, Math.min(bw - CP_EDGE, dateToX(parseD(c.date)) + dw / 2 - x));
    const dot = document.createElement("span");
    dot.className = "cp-dot"
                  + (c.date <= now ? " done" : "")
                  + (isOutside(t, c) ? " out" : "");
    dot.style.left = cx + "px";
    attachTip(dot, checkpointTipHtml(t, c));
    bar.appendChild(dot);
  }
}

export function renderDeps(rows) {
  while (depSvg.firstChild) depSvg.removeChild(depSvg.firstChild);
  const NS = "http://www.w3.org/2000/svg";
  const GAP = 5;   // distance the arrowhead stops before the target
  const STUB = 14; // short horizontal segment leaving the predecessor
  for (const t of S.state.tasks) {
    if (!t.deps || !t.deps.length) continue;
    const toIdx = rowIndexOfTask(t.id, rows);
    if (toIdx < 0) continue;
    const toX = dateToX(parseD(t.start));
    const toY = toIdx * ROW_H + ROW_H / 2;
    // entry point on the successor (left vertex for milestones); arrow points right
    const targetX = (t.isMilestone ? toX - 9 : toX) - GAP;
    for (const depId of t.deps) {
      const from = S.state.tasks.find(x => x.id === depId);
      if (!from) continue;
      const fromIdx = rowIndexOfTask(depId, rows);
      if (fromIdx < 0) continue;
      // exit point on the predecessor (right edge / right vertex for milestones)
      const x1 = from.isMilestone ? dateToX(parseD(from.start)) + 9
                                  : dateToX(addDays(parseD(from.end), 1));
      const y1 = fromIdx * ROW_H + ROW_H / 2;
      // Smooth S-curve with horizontal tangents at both ends. The end tangent
      // points right, so the arrowhead always enters the successor cleanly —
      // works for forward, adjacent, overlapping, and backward links alike.
      const k = Math.max(STUB, Math.abs(targetX - x1) * 0.4 + 10);
      const d = `M ${x1} ${y1} C ${x1 + k} ${y1}, ${targetX - k} ${toY}, ${targetX} ${toY}`;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("marker-end", "url(#arrow)");
      depSvg.appendChild(path);
    }
  }
  // arrow marker
  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = `<marker id="arrow" markerUnits="userSpaceOnUse" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="#94a3b8" stroke="none"></path></marker>`;
  depSvg.appendChild(defs);
  depSvg.setAttribute("width", chartWidth());
  depSvg.setAttribute("height", rows.length * ROW_H);
}

export function positionTodayLine(h) {
  const x = dateToX(today()) + dayWidth() / 2;
  todayLine.style.left = x + "px";
  todayLine.style.height = h + "px";
}
