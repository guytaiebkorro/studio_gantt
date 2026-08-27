// ---------------------------------------------------------------------------
// Tasks view: a full-width list of every group with its tasks and milestones,
// shown instead of the list+chart split when S.viewTab === "tasks".
//
// Consumes the same orderedRows() output as the gantt panes, so the toolbar
// filter, collapse state and "Ungrouped" synthesis behave identically.
// ---------------------------------------------------------------------------
import { $, esc } from "../dom.js";
import { progressOf } from "../dates.js";
import { icon } from "../icons.js";
import { S, isCollapsed, toggleCollapse } from "../state.js";
import { openEditor } from "../ui/editor.js";
import { openGroupEditor } from "../ui/groupEditor.js";
import { isSelected, toggleSelection } from "../ui/interactions.js";

export function renderTasksView(rows) {
  const inner = $("tasks-inner");
  if (!inner) return; // older saved-HTML shell without the tasks pane
  inner.innerHTML = "";

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "tv-empty";
    empty.textContent = S.filter.trim() ? "Nothing matches your filter." : "No tasks yet.";
    inner.appendChild(empty);
    return;
  }

  for (const r of rows) {
    if (r.type === "group") inner.appendChild(groupHeader(r));
    else inner.appendChild(taskCard(r));
  }
}

function groupHeader(r) {
  const g = r.group;
  const col = isCollapsed(g.id);
  const el = document.createElement("div");
  el.className = "tv-group";
  el.innerHTML = `<span class="caret" title="${col ? "Expand" : "Collapse"}">${col ? "▸" : "▾"}</span>
                  <span class="tv-swatch" style="background:${g.color}"></span>
                  <span class="tv-group-name">${esc(g.name)}</span>
                  <span class="tv-count">${r.count}</span>`;
  el.querySelector(".caret").addEventListener("click", (e) => { e.stopPropagation(); toggleCollapse(g.id); });
  if (g.id !== "__none") {
    el.querySelector(".tv-group-name").classList.add("editable");
    el.querySelector(".tv-group-name").title = "Edit group";
    el.querySelector(".tv-group-name").addEventListener("click", () => openGroupEditor(g.id));
    const add = document.createElement("button");
    add.className = "grp-add tv-add";
    add.textContent = "+";
    add.title = "Add task to this group";
    add.addEventListener("click", (e) => { e.stopPropagation(); openEditor(null, { groupId: g.id }); });
    el.appendChild(add);
  }
  return el;
}

function taskCard(r) {
  const t = r.task;
  const color = r.color; // a subtask inherits its parent's colour
  const col = r.hasKids && isCollapsed(t.id);
  const el = document.createElement("div");
  el.className = "tv-row"
               + (r.hasKids ? " parent" : "")
               + (r.depth ? " subtask" : "")
               + (isSelected(t.id) ? " sel" : "");
  el.dataset.id = t.id;

  const dates = t.isMilestone ? esc(t.start) : `${esc(t.start)} – ${esc(t.end)}`;
  const marker = t.isMilestone
    ? `<span class="tv-ms" style="background:${color}" title="Milestone"></span>`
    : "";
  const caret = r.hasKids
    ? `<span class="caret" title="${col ? "Expand" : "Collapse"}">${col ? "▸" : "▾"}</span>` : "";
  const kidChip = r.hasKids
    ? `<span class="tv-count">${r.kidCount} subtask${r.kidCount > 1 ? "s" : ""}</span>` : "";
  const desc = t.description
    ? `<div class="tv-desc">${esc(t.description)}</div>`
    : "";
  const prog = progressOf(t);
  const progress = prog.done
    ? `<span class="tv-done"><span class="done-badge">${icon("check")}</span>Done</span>`
    : t.isMilestone ? "" :
      `<div class="tv-progress-wrap">
         <div class="tv-progress"><span class="tv-progress-fill" style="width:${prog.pct}%; background:${color}"></span></div>
         <span class="tv-pct">${prog.pct}%</span>
       </div>`;

  el.innerHTML = `<span class="tv-rail" style="background:${color}"></span>
                  <div class="tv-main">
                    <div class="tv-name">${caret}${marker}${esc(t.name)}${kidChip}</div>
                    ${desc}
                  </div>
                  <div class="tv-side">
                    <span class="tv-dates"${r.hasKids ? ' title="Rolled up from this task’s subtasks"' : ""}>${dates}</span>
                    ${progress}
                  </div>`;
  if (r.hasKids) el.querySelector(".caret")
    .addEventListener("click", (e) => { e.stopPropagation(); toggleCollapse(t.id); });
  el.addEventListener("click", (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSelection(t.id); return; }
    openEditor(t.id);
  });
  if (!r.depth) {
    const add = document.createElement("button");
    add.className = "grp-add tv-add tv-row-add";
    add.textContent = "+";
    add.title = "Add a subtask";
    add.addEventListener("click", (e) => { e.stopPropagation(); openEditor(null, { parentId: t.id }); });
    el.appendChild(add);
  }
  return el;
}
