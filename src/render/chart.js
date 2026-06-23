// ---------------------------------------------------------------------------
// Right chart pane: the date-axis header, grid columns/row lines, task bars and
// milestones, dependency arrows, and the today line.
// ---------------------------------------------------------------------------
import { ROW_H, BAR_PAD, MONTHS, DOW } from "../config.js";
import { chartHeader, chartBody, depSvg, todayLine } from "../dom.js";
import { esc } from "../dom.js";
import { addDays, diffDays, parseD, dateToX, today, dayWidth, totalDays, chartWidth } from "../dates.js";
import { S, isCollapsed } from "../state.js";
import { attachBarDrag, attachMilestoneDrag, isSelected } from "../ui/interactions.js";
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
  // remove old bars / milestones / labels
  chartBody.querySelectorAll(".bar, .milestone, .ms-label").forEach(e => e.remove());
  const dw = dayWidth();
  rows.forEach((r, idx) => {
    if (r.type === "group") {
      // When a group is collapsed its task rows are hidden, so draw a single
      // rollup bar on the group header row spanning its tasks' date range.
      if (!isCollapsed(r.group.id)) return;
      const members = S.state.tasks.filter(t => t.groupId === r.group.id
        || (r.group.id === "__none" && !S.state.groups.some(g => g.id === t.groupId)));
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
      const sum = document.createElement("div");
      sum.className = "bar group-summary";
      sum.style.left = x + "px";
      sum.style.top = (top + (ROW_H - 10) / 2) + "px";
      sum.style.width = (days * dw) + "px";
      sum.style.background = r.group.color;
      chartBody.appendChild(sum);
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
      m.style.background = t.color || r.group.color;
      m.dataset.id = t.id;
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
      bar.className = "bar" + (isSelected(t.id) ? " selected" : "");
      bar.style.left = x + "px";
      bar.style.top = (top + BAR_PAD) + "px";
      bar.style.width = bw + "px";
      bar.style.background = t.color || r.group.color;
      bar.dataset.id = t.id;
      bar.innerHTML = `<div class="fill" style="width:${t.progress}%"></div>
                       <div class="handle l"></div>
                       <span class="label">${esc(t.name)}</span>
                       <div class="handle r"></div>`;
      chartBody.appendChild(bar);
      attachBarDrag(bar, t);
    }
  });
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
