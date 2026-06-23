// ---------------------------------------------------------------------------
// Group editor modal: add/edit a group, or delete it (which also removes its
// tasks) with an Undo toast.
// ---------------------------------------------------------------------------
import { $, toast } from "../dom.js";
import { S, markDirty, snapshot, restoreState, uid, pickColor } from "../state.js";
import { render } from "../render/index.js";

const gOverlay = $("group-overlay");

export function openGroupEditor(id) {
  if (S.locked) return; // view-only
  S.editingGroupId = id || null;
  const g = id ? S.state.groups.find(x => x.id === id) : null;
  $("group-title").textContent = id ? "Edit Group" : "Add Group";
  $("g-name").value = g ? g.name : "";
  $("g-color").value = g ? g.color : pickColor();
  $("g-delete").style.display = id ? "" : "none";
  gOverlay.classList.add("show");
  setTimeout(() => $("g-name").focus(), 30);
}
export function closeGroupEditor() { gOverlay.classList.remove("show"); S.editingGroupId = null; }

// --- wiring ---
$("g-cancel").addEventListener("click", closeGroupEditor);
gOverlay.addEventListener("click", (e) => { if (e.target === gOverlay) closeGroupEditor(); });

$("g-save").addEventListener("click", () => {
  const name = $("g-name").value.trim() || "Group";
  const color = $("g-color").value;
  if (S.editingGroupId) {
    Object.assign(S.state.groups.find(x => x.id === S.editingGroupId), { name, color });
  } else {
    S.state.groups.push({ id: uid("g"), name, color });
  }
  markDirty(); closeGroupEditor(); render();
});

$("g-delete").addEventListener("click", () => {
  if (!S.editingGroupId) return;
  const snap = snapshot();
  const gid = S.editingGroupId;
  const childIds = S.state.tasks.filter(t => t.groupId === gid).map(t => t.id);
  const removed = new Set(childIds);
  S.state.tasks = S.state.tasks.filter(t => !removed.has(t.id));
  // clean up dependencies in remaining tasks that pointed at the deleted ones
  S.state.tasks.forEach(t => { if (t.deps) t.deps = t.deps.filter(d => !removed.has(d)); });
  removed.forEach(rid => S.selectedIds.delete(rid));
  if (removed.has(S.selectedId)) S.selectedId = null;
  S.state.groups = S.state.groups.filter(x => x.id !== gid);
  markDirty(); closeGroupEditor(); render();
  const n = childIds.length;
  toast(n ? `Group + ${n} task${n > 1 ? "s" : ""} deleted` : "Group deleted", "Undo", () => restoreState(snap));
});
