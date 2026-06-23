// ---------------------------------------------------------------------------
// Left list pane: group headers and task rows, plus drag-to-reorder (including
// dragging a task onto a group header to move it between groups).
// ---------------------------------------------------------------------------
import { listInner, esc } from "../dom.js";
import { S, isCollapsed, toggleCollapse, markDirty } from "../state.js";
import { render } from "./index.js";
import { openEditor } from "../ui/editor.js";
import { openGroupEditor } from "../ui/groupEditor.js";
import { isSelected, toggleSelection } from "../ui/interactions.js";

function clearDropMarks() {
  listInner.querySelectorAll(".drop-before, .drop-after, .drop-into")
    .forEach(e => e.classList.remove("drop-before", "drop-after", "drop-into"));
}
function reorderTaskRelativeTo(targetTask, after) {
  if (!S.dragTaskId || S.dragTaskId === targetTask.id) return;
  const dragged = S.state.tasks.find(x => x.id === S.dragTaskId);
  if (!dragged) return;
  S.state.tasks = S.state.tasks.filter(x => x.id !== S.dragTaskId);
  dragged.groupId = targetTask.groupId; // adopt the target's group (supports cross-group moves)
  let idx = S.state.tasks.findIndex(x => x.id === targetTask.id);
  if (idx < 0) idx = S.state.tasks.length;
  if (after) idx += 1;
  S.state.tasks.splice(idx, 0, dragged);
  markDirty(); render();
}
function moveTaskToGroupTop(groupId) {
  if (!S.dragTaskId) return;
  const dragged = S.state.tasks.find(x => x.id === S.dragTaskId);
  if (!dragged) return;
  S.state.tasks = S.state.tasks.filter(x => x.id !== S.dragTaskId);
  dragged.groupId = (groupId === "__none") ? null : groupId;
  const idx = S.state.tasks.findIndex(x => x.groupId === dragged.groupId);
  if (idx < 0) S.state.tasks.push(dragged); else S.state.tasks.splice(idx, 0, dragged);
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
        add.addEventListener("click", (e) => { e.stopPropagation(); openEditor(null, r.group.id); });
        el.appendChild(add);
      }
      // drop a task onto a group header to move it into that group
      el.addEventListener("dragover", (e) => { if (!S.dragTaskId) return; e.preventDefault(); el.classList.add("drop-into"); });
      el.addEventListener("dragleave", () => el.classList.remove("drop-into"));
      el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("drop-into"); moveTaskToGroupTop(r.group.id); });
    } else {
      const t = r.task;
      el.className = "list-row task-row" + (isSelected(t.id) ? " sel" : "");
      el.dataset.id = t.id;
      const mark = t.isMilestone ? "◆ " : "";
      el.innerHTML = `<span class="swatch" style="background:${t.color || r.group.color}"></span>
                      <span class="nm">${mark}${esc(t.name)}</span>`;
      el.addEventListener("click", (e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSelection(t.id); return; }
        openEditor(t.id);
      });
      // drag to reorder (disabled while view-only)
      el.draggable = !S.locked;
      el.addEventListener("dragstart", (e) => {
        if (S.locked) { e.preventDefault(); return; }
        S.dragTaskId = t.id; S.dragging = true;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          try { e.dataTransfer.setData("text/plain", t.id); } catch (_) {}
        }
        el.classList.add("dragging");
      });
      el.addEventListener("dragend", () => { el.classList.remove("dragging"); clearDropMarks(); S.dragTaskId = null; S.dragging = false; });
      el.addEventListener("dragover", (e) => {
        if (!S.dragTaskId || S.dragTaskId === t.id) return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        clearDropMarks(); el.classList.add(after ? "drop-after" : "drop-before");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        clearDropMarks(); reorderTaskRelativeTo(t, after);
      });
    }
    listInner.appendChild(el);
  }
}
