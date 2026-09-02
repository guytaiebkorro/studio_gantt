// ---------------------------------------------------------------------------
// Left list pane: group headers and task rows, plus drag-to-reorder (including
// dragging a task onto a group header to move it between groups).
// ---------------------------------------------------------------------------
import { listInner, esc, toast } from "../dom.js";
import { progressOf } from "../dates.js";
import { icon } from "../icons.js";
import { S, isCollapsed, toggleCollapse, markDirty, childrenOf } from "../state.js";
import { canEdit } from "../permissions.js";
import { render } from "./index.js";
import { openEditor } from "../ui/editor.js";
import { openGroupEditor } from "../ui/groupEditor.js";
import { isSelected, toggleSelection } from "../ui/interactions.js";

function clearDropMarks() {
  listInner.querySelectorAll(".drop-before, .drop-after, .drop-into")
    .forEach(e => e.classList.remove("drop-before", "drop-after", "drop-into"));
}
// Lift a task (and its subtasks, which always travel with it) out of the array
// so it can be spliced back in somewhere else.
function detach(dragged) {
  const kids = childrenOf(dragged.id);
  const moving = new Set([dragged.id, ...kids.map(k => k.id)]);
  S.state.tasks = S.state.tasks.filter(x => !moving.has(x.id));
  return kids;
}

// The three drag-drop mutations below are guarded here rather than at each drop
// handler: gating `draggable` and `dragstart` is not enough, because a drop can
// arrive from an external drag source or from a stale S.dragTaskId left over
// from before a lock toggle or a role change.
function reorderTaskRelativeTo(targetTask, after) {
  if (!canEdit()) return;
  if (!S.dragTaskId || S.dragTaskId === targetTask.id) return;
  const dragged = S.state.tasks.find(x => x.id === S.dragTaskId);
  if (!dragged) return;
  // Nesting is one level deep, so a task that has subtasks can only ever land at
  // the top level: dropping it beside a subtask puts it beside that subtask's
  // PARENT instead.
  const hasKids = childrenOf(dragged.id).length > 0;
  let anchor = targetTask;
  if (hasKids && targetTask.parentId) {
    anchor = S.state.tasks.find(x => x.id === targetTask.parentId) || targetTask;
  }
  if (anchor.id === dragged.id) return;
  const kids = detach(dragged);
  // adopt the anchor's group AND nesting — dropping beside a subtask joins that
  // parent, dropping beside a top-level task un-nests
  dragged.parentId = hasKids ? null : (anchor.parentId || null);
  dragged.groupId = anchor.groupId;
  kids.forEach(k => { k.groupId = dragged.groupId; });
  let idx = S.state.tasks.findIndex(x => x.id === anchor.id);
  if (idx < 0) idx = S.state.tasks.length; else if (after) idx += 1;
  S.state.tasks.splice(idx, 0, dragged, ...kids);
  markDirty(); render();
}

// Drop onto the middle of a top-level row → become its subtask.
function nestTaskUnder(parentTask) {
  if (!canEdit()) return;
  if (!S.dragTaskId || S.dragTaskId === parentTask.id) return;
  const dragged = S.state.tasks.find(x => x.id === S.dragTaskId);
  if (!dragged || parentTask.parentId) return;
  if (childrenOf(dragged.id).length) { toast("Move or delete its subtasks first"); return; }
  detach(dragged);
  dragged.parentId = parentTask.id;
  dragged.groupId = parentTask.groupId;   // a subtask lives in its parent's group
  parentTask.isMilestone = false;         // a container is never a milestone
  // NOTE: dragged.color is deliberately untouched — a subtask RENDERS its
  // parent's colour, so un-nesting brings its own colour straight back.
  const sibs = childrenOf(parentTask.id);
  const anchorId = sibs.length ? sibs[sibs.length - 1].id : parentTask.id;
  const idx = S.state.tasks.findIndex(x => x.id === anchorId);
  S.state.tasks.splice(idx < 0 ? S.state.tasks.length : idx + 1, 0, dragged);
  markDirty(); render();
}

function moveTaskToGroupTop(groupId) {
  if (!canEdit()) return;
  if (!S.dragTaskId) return;
  const dragged = S.state.tasks.find(x => x.id === S.dragTaskId);
  if (!dragged) return;
  const kids = detach(dragged);
  dragged.parentId = null; // dropping on a group header always means "top level here"
  dragged.groupId = (groupId === "__none") ? null : groupId;
  kids.forEach(k => { k.groupId = dragged.groupId; });
  const idx = S.state.tasks.findIndex(x => !x.parentId && x.groupId === dragged.groupId);
  if (idx < 0) S.state.tasks.push(dragged, ...kids);
  else S.state.tasks.splice(idx, 0, dragged, ...kids);
  markDirty(); render();
}

export function renderList(rows) {
  listInner.innerHTML = "";
  for (const r of rows) {
    const el = document.createElement("div");
    if (r.type === "group") {
      el.className = "list-row group-head";
      const col = isCollapsed(r.group.id);
      el.innerHTML = `<span class="caret" title="${col ? "Expand" : "Collapse"}">${col ? "▸" : "▾"}</span>
                      <span class="swatch" style="background:${r.group.color}"></span>
                      <span class="nm">${esc(r.group.name)}</span>` +
                      (col ? `<span class="meta">${r.count}</span>` : "");
      // caret toggles collapse (works even in view-only mode)
      el.querySelector(".caret").addEventListener("click", (e) => { e.stopPropagation(); toggleCollapse(r.group.id); });
      if (r.group.id !== "__none") {
        el.style.cursor = "pointer";
        el.title = "Edit group";
        el.addEventListener("click", () => openGroupEditor(r.group.id));
        const add = document.createElement("button");
        add.className = "grp-add";
        add.textContent = "+";
        add.title = "Add task to this group";
        add.addEventListener("click", (e) => { e.stopPropagation(); openEditor(null, { groupId: r.group.id }); });
        el.appendChild(add);
      }
      // drop a task onto a group header to move it into that group
      el.addEventListener("dragover", (e) => { if (!S.dragTaskId) return; e.preventDefault(); el.classList.add("drop-into"); });
      el.addEventListener("dragleave", () => el.classList.remove("drop-into"));
      el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("drop-into"); moveTaskToGroupTop(r.group.id); });
    } else {
      const t = r.task;
      const col = r.hasKids && isCollapsed(t.id);
      el.className = "list-row task-row"
                   + (r.hasKids ? " parent" : "")
                   + (r.depth ? " subtask" : "")
                   + (isSelected(t.id) ? " sel" : "");
      el.dataset.id = t.id;
      const mark = t.isMilestone ? "◆ " : "";
      const done = progressOf(t).done ? `<span class="done-badge" title="Done — end date has passed">${icon("check")}</span>` : "";
      const caret = r.hasKids
        ? `<span class="caret" title="${col ? "Expand" : "Collapse"}">${col ? "▸" : "▾"}</span>` : "";
      el.innerHTML = caret +
                     `<span class="swatch" style="background:${r.color}"></span>
                      <span class="nm">${mark}${esc(t.name)}</span>${done}` +
                     (col ? `<span class="meta">${r.kidCount}</span>` : "");
      // a parent collapses like a group header (same per-board collapsedMap)
      if (r.hasKids) el.querySelector(".caret")
        .addEventListener("click", (e) => { e.stopPropagation(); toggleCollapse(t.id); });
      el.addEventListener("click", (e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSelection(t.id); return; }
        openEditor(t.id);
      });
      // only top-level rows can take subtasks (nesting is one level deep)
      if (!r.depth) {
        const add = document.createElement("button");
        add.className = "grp-add row-add";
        add.textContent = "+";
        add.title = "Add a subtask";
        add.addEventListener("click", (e) => { e.stopPropagation(); openEditor(null, { parentId: t.id }); });
        el.appendChild(add);
      }
      // drag to reorder (disabled without edit rights)
      el.draggable = canEdit();
      el.addEventListener("dragstart", (e) => {
        if (!canEdit()) { e.preventDefault(); return; }
        S.dragTaskId = t.id; S.dragging = true;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", t.id); } catch (_) {}
        }
        el.classList.add("dragging");
      });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); clearDropMarks(); S.dragTaskId = null; S.dragging = false; });
      // Three drop zones on a top-level row: the outer quarters reorder, the
      // middle half nests the dragged task as a subtask. Subtask rows keep the
      // plain 50/50 before/after split, as does a dragged task that has its own
      // subtasks (it can't be nested — one level only).
      const zoneOf = (e) => {
        const rect = el.getBoundingClientRect();
        const y = (e.clientY - rect.top) / rect.height;
        const half = y > .5 ? "after" : "before";
        if (r.depth) return half;
        const dragged = S.state.tasks.find(x => x.id === S.dragTaskId);
        if (!dragged || childrenOf(dragged.id).length) return half;
        if (y < .25) return "before";
        if (y > .75) return "after";
        return "into";
      };
      el.addEventListener("dragover", (e) => {
        if (!S.dragTaskId || S.dragTaskId === t.id) return;
        e.preventDefault();
        const z = zoneOf(e);
        clearDropMarks(); el.classList.add(z === "into" ? "drop-into" : "drop-" + z);
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after", "drop-into"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        const z = zoneOf(e);
        clearDropMarks();
        if (z === "into") nestTaskUnder(t); else reorderTaskRelativeTo(t, z === "after");
      });
    }
    listInner.appendChild(el);
  }
}
