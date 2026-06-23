// ---------------------------------------------------------------------------
// Task / milestone editor modal: open/populate, dependency checkboxes, color
// swatches, and the save / delete / duplicate actions.
// ---------------------------------------------------------------------------
import { COLORS } from "../config.js";
import { $, esc, toast } from "../dom.js";
import { S, markDirty, snapshot, restoreState, uid } from "../state.js";
import { today, fmtD, addDays, parseD } from "../dates.js";
import { render } from "../render/index.js";

const edOverlay = $("editor-overlay");

export function openEditor(id, presetGroupId) {
  if (S.locked && !id) return; // can't add while view-only (existing items open read-only)
  S.editingId = id;
  const t = id ? S.state.tasks.find(x => x.id === id) : null;
  $("editor-title").textContent = id ? "Edit Task" : "New Task";

  // populate group select
  const gSel = $("f-group");
  gSel.innerHTML = S.state.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join("")
                   || `<option value="">(no groups)</option>`;

  if (t) {
    $("f-name").value = t.name;
    $("f-group").value = t.groupId || (S.state.groups[0] && S.state.groups[0].id) || "";
    $("f-milestone").checked = !!t.isMilestone;
    $("f-start").value = t.start;
    $("f-end").value = t.end;
    $("f-progress").value = t.progress || 0;
    $("prog-val").textContent = t.progress || 0;
    $("f-use-color").checked = !!t.color;
    $("f-color").value = t.color || groupColorOf($("f-group").value);
    $("f-delete").style.display = "";
    $("f-duplicate").style.display = "";
  } else {
    const start = today();
    $("f-name").value = "";
    $("f-group").value = presetGroupId || (S.state.groups[0] && S.state.groups[0].id) || "";
    $("f-milestone").checked = false;
    $("f-start").value = fmtD(start);
    $("f-end").value = fmtD(addDays(start, 3));
    $("f-progress").value = 0;
    $("prog-val").textContent = 0;
    $("f-use-color").checked = !!S.lastColor;
    $("f-color").value = S.lastColor || groupColorOf($("f-group").value);
    $("f-delete").style.display = "none";
    $("f-duplicate").style.display = "none";
  }
  buildDepList(id);
  toggleMilestoneUI();
  syncColorUI();
  edOverlay.classList.add("show");
  setTimeout(() => $("f-name").focus(), 30);
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
  $("progress-wrap").style.display = ms ? "none" : "";
}
function groupColorOf(gid) { const g = S.state.groups.find(x => x.id === gid); return g ? g.color : "#94a3b8"; }

export function renderSwatches() {
  const box = $("f-swatches");
  box.innerHTML = "";
  COLORS.forEach(c => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "sw"; b.style.background = c; b.dataset.color = c; b.title = c;
    b.addEventListener("click", () => {
      $("f-color").value = c; $("f-use-color").checked = true; syncColorUI();
    });
    box.appendChild(b);
  });
}
function syncColorUI() {
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
$("f-progress").addEventListener("input", () => $("prog-val").textContent = $("f-progress").value);
$("f-use-color").addEventListener("change", () => {
  if (!$("f-use-color").checked) $("f-color").value = groupColorOf($("f-group").value);
  syncColorUI();
});
$("f-color").addEventListener("input", () => { $("f-use-color").checked = true; syncColorUI(); });
$("f-group").addEventListener("change", () => {
  if (!$("f-use-color").checked) { $("f-color").value = groupColorOf($("f-group").value); syncColorUI(); }
});

$("f-cancel").addEventListener("click", closeEditor);
edOverlay.addEventListener("click", (e) => { if (e.target === edOverlay) closeEditor(); });

$("f-save").addEventListener("click", () => {
  if (S.locked) return;
  const name = $("f-name").value.trim() || "Untitled";
  const isMs = $("f-milestone").checked;
  let start = $("f-start").value || fmtD(today());
  let end = isMs ? start : ($("f-end").value || start);
  if (!isMs && parseD(end) < parseD(start)) end = start;
  const groupId = $("f-group").value || null;
  const progress = isMs ? 0 : Number($("f-progress").value);
  const deps = Array.from($("f-deps").querySelectorAll("input:checked")).map(i => i.value);
  const color = $("f-use-color").checked ? $("f-color").value : null;
  if (color) S.lastColor = color; // reuse this color as the default for the next new task

  if (S.editingId) {
    const t = S.state.tasks.find(x => x.id === S.editingId);
    Object.assign(t, { name, groupId, start, end, progress, isMilestone: isMs, deps, color });
  } else {
    S.state.tasks.push({ id: uid("t"), name, groupId, start, end, progress, isMilestone: isMs, deps, color });
  }
  markDirty(); closeEditor(); render();
});

$("f-delete").addEventListener("click", () => {
  if (!S.editingId) return;
  const snap = snapshot();
  const id = S.editingId;
  S.state.tasks = S.state.tasks.filter(x => x.id !== id);
  // clean up dependencies referencing it
  S.state.tasks.forEach(t => { if (t.deps) t.deps = t.deps.filter(d => d !== id); });
  S.selectedIds.delete(id);
  if (S.selectedId === id) S.selectedId = null;
  markDirty(); closeEditor(); render();
  toast("Task deleted", "Undo", () => restoreState(snap));
});

$("f-duplicate").addEventListener("click", () => {
  if (!S.editingId) return;
  const orig = S.state.tasks.find(x => x.id === S.editingId);
  if (!orig) return;
  const copy = JSON.parse(JSON.stringify(orig));
  copy.id = uid("t");
  copy.name = orig.name + " (copy)";
  copy.deps = Array.isArray(orig.deps) ? orig.deps.slice() : [];
  const idx = S.state.tasks.findIndex(x => x.id === S.editingId);
  S.state.tasks.splice(idx + 1, 0, copy); // place right after the original
  S.selectedId = copy.id;
  S.selectedIds = new Set([copy.id]);
  markDirty(); closeEditor(); render();
  toast("Task duplicated");
});
