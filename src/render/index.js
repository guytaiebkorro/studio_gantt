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
import { S, isCollapsed, colorOf } from "../state.js";
import { renderList } from "./list.js";
import { renderTasksView } from "./tasksView.js";
import { renderHeader, renderGrid, renderBars, renderDeps, positionTodayLine } from "./chart.js";

export function render() {
  ensureRange();
  const rows = orderedRows();

  // Tasks view replaces the list+chart split; skip the (hidden) chart work.
  if (S.viewTab === "tasks") { renderTasksView(rows); return; }

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
// A task row nests one level: a top-level task (depth 0) is immediately followed
// by its subtasks (depth 1), so the flat row index still drives the chart's
// `idx * ROW_H` geometry and the dependency-arrow lookup. Collapsing a parent
// reuses the group collapse machinery — collapsedMap is keyed by any id.
//
// Every task row carries its RESOLVED colour, so the renderers never re-derive
// it: a subtask inherits its parent's colour (see colorOf).
//
// The toolbar filter (S.filter) narrows the rows: a task is shown when its name
// matches, or when its group's name matches (so you can isolate a whole team).
// A parent also survives when one of its subtasks matches, so a hit is never
// shown without its parent for context; a subtask survives when its parent
// matches. Groups with no visible task — and whose own name doesn't match —
// drop out.
export function orderedRows() {
  const rows = [];
  const used = new Set();
  const q = (S.filter || "").trim().toLowerCase();
  const matches = (s) => (s || "").toLowerCase().includes(q);

  // one pass over the tasks to index the hierarchy
  const kids = new Map();
  for (const t of S.state.tasks) {
    if (!t.parentId) continue;
    if (!kids.has(t.parentId)) kids.set(t.parentId, []);
    kids.get(t.parentId).push(t);
  }
  const kidsOf = (id) => kids.get(id) || [];

  const selfVisible = (t, g) => !q || matches(t.name) || (g && matches(g.name));
  const rootVisible = (t, g) => selfVisible(t, g) || kidsOf(t.id).some(c => matches(c.name));
  const kidVisible = (c, parent, g) => selfVisible(c, g) || matches(parent.name);

  // Emit a top-level task row followed by its (visible) subtask rows. `mg` is the
  // group used for FILTER matching — null for the synthetic Ungrouped group, whose
  // name has never been matchable, even though its colour is used for the rows.
  function pushTask(t, g, mg) {
    const cs = kidsOf(t.id);
    rows.push({ type: "task", task: t, group: g, depth: 0,
                kidCount: cs.length, hasKids: cs.length > 0, color: colorOf(t, g.color) });
    if (!cs.length || isCollapsed(t.id)) return;
    for (const c of cs) {
      if (!kidVisible(c, t, mg)) continue;
      rows.push({ type: "task", task: c, group: g, depth: 1,
                  kidCount: 0, hasKids: false, color: colorOf(c, g.color) });
    }
  }
  // How many task rows this group would contribute — shown on the header chip.
  const countOf = (roots, mg) => roots.reduce((n, t) =>
    n + 1 + kidsOf(t.id).filter(c => kidVisible(c, t, mg)).length, 0);

  for (const g of S.state.groups) {
    const groupRoots = S.state.tasks.filter(t => !t.parentId && t.groupId === g.id);
    // a whole subtree belongs to its group even when filtered out
    groupRoots.forEach(t => { used.add(t.id); kidsOf(t.id).forEach(c => used.add(c.id)); });
    const visible = groupRoots.filter(t => rootVisible(t, g));
    if (q && visible.length === 0) continue; // filtering: hide groups with nothing to show
    rows.push({ type: "group", group: g, count: countOf(visible, g) });
    if (isCollapsed(g.id)) continue; // collapsed: skip its task rows (in both list and chart)
    for (const t of visible) pushTask(t, g, g);
  }

  const ng = { id: "__none", name: "Ungrouped", color: "#b3a08c" };
  const orphans = S.state.tasks
    .filter(t => !t.parentId && !used.has(t.id))
    .filter(t => rootVisible(t, null));
  if (orphans.length) {
    rows.push({ type: "group", group: ng, count: countOf(orphans, null) });
    if (!isCollapsed("__none")) for (const t of orphans) pushTask(t, ng, null);
  }
  return rows;
}

export function rowIndexOfTask(id, rows) { return rows.findIndex(r => r.type === "task" && r.task.id === id); }
