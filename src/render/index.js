// ---------------------------------------------------------------------------
// Render orchestration.
//
// render() recomputes the visible range and row layout, then delegates to the
// list and chart renderers. orderedRows() produces the flat list of rows
// (groups followed by their tasks) shared by both panes.
// ---------------------------------------------------------------------------
import { ROW_H } from "../config.js";
import { chartBody, chartHeader, $ } from "../dom.js";
import { ensureRange, chartWidth } from "../dates.js";
import { S, isCollapsed } from "../state.js";
import { renderList } from "./list.js";
import { renderHeader, renderGrid, renderBars, renderDeps, positionTodayLine } from "./chart.js";

export function render() {
  ensureRange();
  const rows = orderedRows();
  const w = chartWidth();
  const h = rows.length * ROW_H;

  renderList(rows);
  renderHeader(w);
  renderGrid(rows, w, h);
  renderBars(rows, w, h);
  renderDeps(rows);
  positionTodayLine(h);

  chartBody.style.width = w + "px";
  chartBody.style.height = h + "px";
  chartHeader.style.width = w + "px";
  $("chart-inner").style.width = w + "px";
}

// Groups followed by their (visible) tasks; collapsed groups skip their tasks.
// Tasks with no matching group fall under a synthetic "Ungrouped" group.
export function orderedRows() {
  const rows = [];
  const used = new Set();
  for (const g of S.state.groups) {
    const count = S.state.tasks.filter(t => t.groupId === g.id).length;
    rows.push({ type: "group", group: g, count });
    S.state.tasks.forEach(t => { if (t.groupId === g.id) used.add(t.id); });
    if (isCollapsed(g.id)) continue; // collapsed: skip its task rows (in both list and chart)
    for (const t of S.state.tasks) {
      if (t.groupId === g.id) rows.push({ type: "task", task: t, group: g });
    }
  }
  const orphans = S.state.tasks.filter(t => !used.has(t.id));
  if (orphans.length) {
    const ng = { id: "__none", name: "Ungrouped", color: "#94a3b8" };
    rows.push({ type: "group", group: ng, count: orphans.length });
    if (!isCollapsed("__none")) {
      for (const t of orphans) rows.push({ type: "task", task: t, group: { color: "#94a3b8" } });
    }
  }
  return rows;
}

export function rowIndexOfTask(id, rows) { return rows.findIndex(r => r.type === "task" && r.task.id === id); }
