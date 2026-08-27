// ---------------------------------------------------------------------------
// Task / milestone editor modal: open/populate, dependency checkboxes, color
// swatches, and the save / delete / duplicate actions.
// ---------------------------------------------------------------------------
import { COLORS } from "../config.js";
import { $, esc, toast, wireBackdropClose } from "../dom.js";
import { S, markDirty, snapshot, restoreState, uid, childrenOf, subtreeIds, colorOf } from "../state.js";
import { today, fmtD, addDays, parseD } from "../dates.js";
import { render } from "../render/index.js";

const edOverlay = $("editor-overlay");

// `preset` seeds a NEW task: { groupId, parentId }.
export function openEditor(id, preset) {
  if (S.locked && !id) return; // can't add while view-only (existing items open read-only)
  preset = preset || {};
  S.editingId = id;
  const t = id ? S.state.tasks.find(x => x.id === id) : null;
  $("editor-title").textContent = id ? "Edit Task" : (preset.parentId ? "New Subtask" : "New Task");

  // populate group select
  const gSel = $("f-group");
  gSel.innerHTML = S.state.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join("")
                   || `<option value="">(no groups)</option>`;
  buildParentList(id);

  if (t) {
    $("f-name").value = t.name;
    if ($("f-description")) $("f-description").value = t.description || "";
    $("f-group").value = t.groupId || (S.state.groups[0] && S.state.groups[0].id) || "";
    $("f-parent").value = t.parentId || "";
    $("f-milestone").checked = !!t.isMilestone;
    $("f-start").value = t.start;
    $("f-end").value = t.end;
    $("f-use-color").checked = !!t.color;
    $("f-color").value = t.color || groupColorOf($("f-group").value);
    $("f-delete").style.display = "";
    $("f-duplicate").style.display = "";
  } else {
    const start = today();
    const preParent = preset.parentId ? S.state.tasks.find(x => x.id === preset.parentId) : null;
    $("f-name").value = "";
    if ($("f-description")) $("f-description").value = "";
    $("f-group").value = (preParent && preParent.groupId) || preset.groupId
                         || (S.state.groups[0] && S.state.groups[0].id) || "";
    $("f-parent").value = preParent ? preParent.id : "";
    $("f-milestone").checked = false;
    $("f-start").value = fmtD(start);
    $("f-end").value = fmtD(addDays(start, 3));
    $("f-use-color").checked = !preParent && !!S.lastColor;
    $("f-color").value = S.lastColor || groupColorOf($("f-group").value);
    $("f-delete").style.display = "none";
    $("f-duplicate").style.display = "none";
  }
  buildDepList(id);
  toggleMilestoneUI();
  syncHierarchyUI();
  edOverlay.classList.add("show");
  setTimeout(() => $("f-name").focus(), 30);
}

// Candidate parents: every OTHER top-level, non-milestone task. Nesting is one
// level deep, so a task that already has subtasks is never offered a parent.
function buildParentList(id) {
  const sel = $("f-parent");
  const opts = S.state.tasks
    .filter(x => x.id !== id && !x.parentId && !x.isMilestone)
    .map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
  sel.innerHTML = `<option value="">— None (top-level) —</option>` + opts;
}

// One owner for every control the hierarchy takes over: a subtask's group and
// colour come from its parent, and a parent's dates come from its subtasks.
function syncHierarchyUI() {
  const editing = S.editingId ? S.state.tasks.find(x => x.id === S.editingId) : null;
  const kids = editing ? childrenOf(editing.id) : [];
  const parent = S.state.tasks.find(x => x.id === $("f-parent").value) || null;

  // --- a task that HAS subtasks: dates and milestone-ness are not its own ---
  const sel = $("f-parent");
  sel.disabled = kids.length > 0;
  $("f-parent-hint").textContent = kids.length
    ? "A task with subtasks can’t be nested under another task."
    : "";
  const dated = kids.length > 0;
  $("f-start").disabled = dated;
  $("f-end").disabled = dated;
  $("f-milestone").disabled = dated;
  $("f-dates-hint").textContent = dated
    ? `Dates roll up from this task’s ${kids.length} subtask${kids.length > 1 ? "s" : ""}.`
    : "";

  // --- a subtask: group and colour follow the parent ---
  $("f-group").disabled = !!parent;
  if (parent) $("f-group").value = parent.groupId || "";
  if (parent && !kids.length) {
    $("f-parent-hint").textContent = "Group and colour follow the parent task.";
  }
  syncColorUI(!!parent, parent);
}

function buildDepList(id) {
  const t = id ? S.state.tasks.find(x => x.id === id) : null;
  const deps = (t && t.deps) || [];
  const candidates = S.state.tasks.filter(x => x.id !== id);
  const box = $("f-deps");
  if (!candidates.length) { box.innerHTML = `<span style="color:var(--muted)">No other tasks yet.</span>`; return; }
  box.innerHTML = candidates.map(c =>
    `<label class="d"><input type="checkbox" value="${c.id}" ${deps.includes(c.id) ? "checked" : ""}>
     ${c.isMilestone ? "◆ " : ""}${esc(c.name)}</label>`).join("");
}

export function toggleMilestoneUI() {
  const ms = $("f-milestone").checked;
  $("end-wrap").style.display = ms ? "none" : "";
  // older saved-HTML shells still contain the removed progress slider — hide it
  if ($("progress-wrap")) $("progress-wrap").style.display = "none";
}
function groupColorOf(gid) { const g = S.state.groups.find(x => x.id === gid); return g ? g.color : "#94a3b8"; }

export function renderSwatches() {
  const box = $("f-swatches");
  box.innerHTML = "";
  COLORS.forEach(c => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "sw"; b.style.background = c; b.dataset.color = c; b.title = c;
    b.addEventListener("click", () => {
      $("f-color").value = c; $("f-use-color").checked = true; syncHierarchyUI();
    });
    box.appendChild(b);
  });
}
// `inherited` = this is a subtask, so the colour belongs to `parent` and the
// whole block is shown read-only. The task's OWN color field is never rewritten
// in that state, so un-nesting brings its colour straight back.
function syncColorUI(inherited, parent) {
  if (inherited) {
    // the parent is top-level, so colorOf() on it yields exactly what the
    // subtask will render with
    const c = colorOf(parent, groupColorOf($("f-group").value));
    $("f-use-color").checked = false;
    $("f-color").value = c;
    $("f-color").disabled = true;
    $("f-color").style.opacity = "1";
    $("f-swatches").querySelectorAll(".sw").forEach(b => b.classList.remove("sel"));
    $("f-color-hint").textContent = "Subtasks always use their parent task’s colour.";
    $("f-use-color").closest("div").classList.add("derived");
    $("f-swatches").classList.add("derived");
    return;
  }
  $("f-color-hint").textContent = "";
  $("f-use-color").closest("div").classList.remove("derived");
  $("f-swatches").classList.remove("derived");
  const custom = $("f-use-color").checked;
  $("f-color").disabled = !custom;
  $("f-color").style.opacity = custom ? "1" : ".5";
  const cur = ($("f-color").value || "").toLowerCase();
  $("f-swatches").querySelectorAll(".sw").forEach(b =>
    b.classList.toggle("sel", custom && b.dataset.color.toLowerCase() === cur));
}

export function closeEditor() { edOverlay.classList.remove("show"); S.editingId = null; }

// --- wiring ---
$("f-milestone").addEventListener("change", toggleMilestoneUI);
$("f-use-color").addEventListener("change", () => {
  if (!$("f-use-color").checked) $("f-color").value = groupColorOf($("f-group").value);
  syncHierarchyUI();
});
$("f-color").addEventListener("input", () => { $("f-use-color").checked = true; syncHierarchyUI(); });
$("f-group").addEventListener("change", () => {
  if (!$("f-use-color").checked) $("f-color").value = groupColorOf($("f-group").value);
  syncHierarchyUI();
});
// picking a parent locks the group + colour and previews the inherited colour
$("f-parent").addEventListener("change", syncHierarchyUI);

$("f-cancel").addEventListener("click", closeEditor);
wireBackdropClose(edOverlay, closeEditor);

$("f-save").addEventListener("click", () => {
  if (S.locked) return;
  const name = $("f-name").value.trim() || "Untitled";
  const prev = S.editingId ? S.state.tasks.find(x => x.id === S.editingId) : null;
  // older saved-HTML shells have no description field — keep the stored value
  const description = $("f-description") ? $("f-description").value.trim() : ((prev && prev.description) || "");
  const hasKids = prev ? childrenOf(prev.id).length > 0 : false;
  const parent = S.state.tasks.find(x => x.id === $("f-parent").value) || null;
  const parentId = (parent && !hasKids) ? parent.id : null;

  const isMs = hasKids ? false : $("f-milestone").checked;
  let start = $("f-start").value || fmtD(today());
  let end = isMs ? start : ($("f-end").value || start);
  if (!isMs && parseD(end) < parseD(start)) end = start;
  // a parent's span belongs to its subtasks — ignore the (disabled) date inputs
  // and keep the rolled-up values, which recomputeRollups() rewrites anyway
  if (hasKids && prev) { start = prev.start; end = prev.end; }

  // a subtask lives in its parent's group
  const groupId = parent ? (parent.groupId || null) : ($("f-group").value || null);
  const deps = Array.from($("f-deps").querySelectorAll("input:checked")).map(i => i.value);

  // Colour: a subtask RENDERS its parent's colour, so its own field is left
  // exactly as it was — nesting never destroys it and un-nesting restores it.
  // The colour picker is disabled in that state, so reading it would be wrong.
  let color;
  if (parentId) color = prev ? prev.color : null;
  else {
    color = $("f-use-color").checked ? $("f-color").value : null;
    if (color) S.lastColor = color; // reuse this color as the default for the next new task
  }

  if (S.editingId) {
    const t = S.state.tasks.find(x => x.id === S.editingId);
    Object.assign(t, { name, description, groupId, parentId, start, end, isMilestone: isMs, deps, color });
  } else {
    const t = { id: uid("t"), name, description, groupId, parentId, start, end, isMilestone: isMs, deps, color };
    if (parentId) {
      // place a new subtask after its parent's last existing child
      const sibs = childrenOf(parentId);
      const anchorId = sibs.length ? sibs[sibs.length - 1].id : parentId;
      const idx = S.state.tasks.findIndex(x => x.id === anchorId);
      S.state.tasks.splice(idx < 0 ? S.state.tasks.length : idx + 1, 0, t);
      const p = S.state.tasks.find(x => x.id === parentId);
      if (p) p.isMilestone = false; // a container is never a milestone
    } else {
      S.state.tasks.push(t);
    }
  }
  markDirty(); closeEditor(); render();
});

// Deleting a parent takes its subtasks with it, the same way deleting a group
// takes its tasks — one Undo restores the whole subtree.
$("f-delete").addEventListener("click", () => {
  if (!S.editingId) return;
  const snap = snapshot();
  const kidCount = childrenOf(S.editingId).length;
  const removed = new Set(subtreeIds(S.editingId));
  S.state.tasks = S.state.tasks.filter(x => !removed.has(x.id));
  // clean up dependencies referencing anything we removed
  S.state.tasks.forEach(t => { if (t.deps) t.deps = t.deps.filter(d => !removed.has(d)); });
  removed.forEach(rid => S.selectedIds.delete(rid));
  if (removed.has(S.selectedId)) S.selectedId = null;
  markDirty(); closeEditor(); render();
  toast(kidCount ? `Task + ${kidCount} subtask${kidCount > 1 ? "s" : ""} deleted` : "Task deleted",
        "Undo", () => restoreState(snap));
});

// Duplicating a parent copies the whole subtree with fresh ids. Dependencies
// INSIDE the subtree are remapped onto the copies; links pointing outside are
// kept as-is.
$("f-duplicate").addEventListener("click", () => {
  if (!S.editingId) return;
  const orig = S.state.tasks.find(x => x.id === S.editingId);
  if (!orig) return;
  const kids = childrenOf(orig.id);

  const copy = JSON.parse(JSON.stringify(orig));
  copy.id = uid("t");
  copy.name = orig.name + " (copy)";
  const idMap = { [orig.id]: copy.id };
  const kidCopies = kids.map(k => {
    const c = JSON.parse(JSON.stringify(k));
    c.id = uid("t");
    c.parentId = copy.id;
    idMap[k.id] = c.id;
    return c;
  });
  [copy, ...kidCopies].forEach(c => {
    c.deps = (Array.isArray(c.deps) ? c.deps : []).map(d => idMap[d] || d);
  });

  // place the copy after the original's last subtask, so neither block is split
  const anchorId = kids.length ? kids[kids.length - 1].id : orig.id;
  const idx = S.state.tasks.findIndex(x => x.id === anchorId);
  S.state.tasks.splice(idx < 0 ? S.state.tasks.length : idx + 1, 0, copy, ...kidCopies);
  S.selectedId = copy.id;
  S.selectedIds = new Set([copy.id]);
  markDirty(); closeEditor(); render();
  toast(kids.length ? `Task + ${kids.length} subtask${kids.length > 1 ? "s" : ""} duplicated` : "Task duplicated");
});
