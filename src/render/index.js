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
//
// The toolbar filter (S.filter) narrows the rows: a task is shown when its name
// matches, or when its group's name matches (so you can isolate a whole team).
// Groups with no visible task — and whose own name doesn't match — drop out.
export function orderedRows() {
  const rows = [];
  const used = new Set();
  const q = (S.filter || "").trim().toLowerCase();
  const matches = (s) => (s || "").toLowerCase().includes(q);
  const taskVisible = (t, g) => !q || matches(t.name) || (g && matches(g.name));

  for (const g of S.state.groups) {
    const groupTasks = S.state.tasks.filter(t => t.groupId === g.id);
    groupTasks.forEach(t => used.add(t.id)); // a task belongs to its group even when filtered out
    const visible = groupTasks.filter(t => taskVisible(t, g));
    if (q && visible.length === 0) continue; // filtering: hide groups with nothing to show
    rows.push({ type: "group", group: g, count: visible.length });
    if (isCollapsed(g.id)) continue; // collapsed: skip its task rows (in both list and chart)
    for (const t of visible) rows.push({ type: "task", task: t, group: g });
  }
  const orphans = S.state.tasks.filter(t => !used.has(t.id) && taskVisible(t, null));
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
