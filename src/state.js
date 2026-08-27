// ---------------------------------------------------------------------------
// Central app store.
//
// In the original single-file app every piece of state was a module-scope
// `let`. With ES modules you cannot reassign an imported binding from another
// file, so all mutable state now lives as PROPERTIES of one shared object `S`.
// Modules read/write `S.foo`; the live object is the single source of truth.
// ---------------------------------------------------------------------------
import { VIEW, COLLAPSE_KEY, VIEWTAB_KEY, COLORS } from "./config.js";
import { scheduleCloudSave } from "./sync.js";
import { render } from "./render/index.js";
import { updateViewButtons } from "./ui/toolbar.js";

// Whether this browser can write files in place (Chrome/Edge File System API).
export const supportsFS = typeof window.showSaveFilePicker === "function";

export const S = {
  state: loadState(),          // the board document { version, settings, groups, tasks }
  fileHandle: null,            // FileSystemFileHandle (Chrome/Edge in-place save)
  dirty: false,
  selectedId: null,            // primary selection (editor / delete target)
  selectedIds: new Set(),      // multi-selection: tasks tagged to move together
  editingId: null,             // task id open in editor (null = new)
  editingGroupId: null,
  filter: "",                  // toolbar text filter (runtime only, not persisted)
  rangeStart: null,            // Date objects defining the visible timeline (grows on scroll)
  rangeEnd: null,
  lastColor: null,             // remembers the last custom color picked, to reuse on new tasks
  dragging: false,             // true during a bar/milestone/row drag (pauses cloud refresh)
  locked: true,                // app starts view-only every launch; lock button toggles editing
  dragTaskId: null,            // task id being dragged in the left list
  extending: false,            // guards the endless-timeline scroll extension

  // collapsed groups, remembered per board in localStorage
  collapsedMap: (() => { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}"); } catch (_) { return {}; } })(),

  // active main view (gantt chart or full-width task list) — a personal UI
  // preference, so it lives in localStorage rather than the shared board doc
  viewTab: (() => { try { return localStorage.getItem(VIEWTAB_KEY) === "tasks" ? "tasks" : "gantt"; } catch (_) { return "gantt"; } })(),

  // --- cloud runtime (configured by boards.js at startup) ---
  cloud: null,                 // { apiKey, binId, registryId } — credentials + board + discovered registry
  cloudGate: true,             // true until a valid key connects; gates the non-dismissable Cloud popup
  registry: [],                // [{ id, name }] list of boards
  loadedAt: 0,                 // updatedAt of the remote version our state descends from
  baseState: null,             // common ancestor for 3-way merge
  pollTimer: null,
  suppressAutosave: false,
  cloudReady: false,           // true only after a successful load/create — gates autosave
  savePromise: null,
  saveAgain: false,
  autosaveTimer: null,
  firstDirtyAt: 0
};

// --- dirty tracking ---
export function markDirty() {
  recomputeRollups();          // a parent's dates are derived — refresh before anything reads them
  S.dirty = true;
  document.body.classList.add("dirty");
  scheduleCloudSave();
}
export function clearDirty() {
  S.dirty = false;
  document.body.classList.remove("dirty");
}

// --- collapse state (per board) ---
export function boardKey() { return (S.cloud && S.cloud.binId) || "local"; }
export function isCollapsed(gid) { return (S.collapsedMap[boardKey()] || []).includes(gid); }
export function toggleCollapse(gid) {
  const k = boardKey(), set = new Set(S.collapsedMap[k] || []);
  set.has(gid) ? set.delete(gid) : set.add(gid);
  S.collapsedMap[k] = [...set];
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(S.collapsedMap)); } catch (_) {}
  render();
}

// --- load / normalize the board document ---
export function loadState() {
  try {
    const raw = document.getElementById("gantt-data").textContent.trim();
    return normalize(JSON.parse(raw));
  } catch (e) {
    return normalize({ version: 1, settings: { viewMode: "week" }, groups: [], tasks: [] });
  }
}
export function normalize(data) {
  const s = {
    version: 1,
    settings: { viewMode: (data.settings && data.settings.viewMode) || "week" },
    groups: Array.isArray(data.groups) ? data.groups : [],
    tasks: Array.isArray(data.tasks) ? data.tasks : []
  };
  if (!VIEW[s.settings.viewMode]) s.settings.viewMode = "week";
  s.tasks.forEach(t => {
    t.deps = Array.isArray(t.deps) ? t.deps : [];
    delete t.progress; // legacy field — progress is now derived from dates (see dates.js progressOf)
    t.isMilestone = !!t.isMilestone;
    t.description = typeof t.description === "string" ? t.description : "";
    t.parentId = typeof t.parentId === "string" ? t.parentId : null; // absent in pre-subtask boards
    if (!t.end) t.end = t.start;
    if (!t.id) t.id = uid("t");
  });
  repairHierarchy(s);
  recomputeRollups(s);
  return s;
}

// ---------------------------------------------------------------------------
// Subtasks
//
// One field carries the hierarchy: `parentId`. There is deliberately no
// `isParent` flag — a task IS a parent exactly when something points at it, so
// the two can never disagree. Nesting is ONE level deep: a subtask's parent is
// always top-level.
//
// A parent's start/end are DERIVED from its children but still stored, so
// exports, 3-way merges and any other reader see a valid document. They are
// written in exactly one place (recomputeRollups) which runs on every load and
// on every local edit, so they cannot drift.
//
// Colour is different: it is derived at RENDER time (see colorOf) and never
// written to the subtask, so nesting never destroys a task's own colour and
// un-nesting restores it.
// ---------------------------------------------------------------------------
export function childrenOf(id) { return S.state.tasks.filter(t => t.parentId === id); }
export function isParent(t) { return !!t && S.state.tasks.some(x => x.parentId === t.id); }
export function parentOf(t) {
  return (t && t.parentId) ? (S.state.tasks.find(x => x.id === t.parentId) || null) : null;
}
export function subtreeIds(id) { return [id, ...childrenOf(id).map(c => c.id)]; }

// Effective colour: a subtask always shows its PARENT's colour. `fallback` is
// the row's group colour (already "#b3a08c" for the synthetic Ungrouped group).
export function colorOf(t, fallback) {
  const owner = parentOf(t) || t;
  return owner.color || fallback;
}

// Restore the invariants on a freshly loaded / merged document.
function repairHierarchy(s) {
  const byId = new Map(s.tasks.map(t => [t.id, t]));

  // parentId must name a different, existing task
  for (const t of s.tasks) {
    if (t.parentId && (t.parentId === t.id || !byId.has(t.parentId))) t.parentId = null;
  }
  // one level only: re-point at the top-most ancestor. A merge can produce a
  // depth-2 chain (or even a cycle) that neither client ever created, so the
  // walk carries a visited set and gives up into "top-level" rather than hang.
  for (const t of s.tasks) {
    if (!t.parentId) continue;
    const seen = new Set([t.id]);
    let p = byId.get(t.parentId);
    while (p && p.parentId && !seen.has(p.id)) { seen.add(p.id); p = byId.get(p.parentId); }
    t.parentId = (p && p.id !== t.id && !p.parentId) ? p.id : null;
  }
  // a subtask lives in its parent's group
  for (const t of s.tasks) {
    const p = t.parentId ? byId.get(t.parentId) : null;
    if (p) t.groupId = p.groupId;
  }
  // a task with subtasks is a container, never a milestone
  const parents = new Set(s.tasks.filter(t => t.parentId).map(t => t.parentId));
  for (const t of s.tasks) if (parents.has(t.id)) t.isMilestone = false;
}

// Roll every parent's start/end up from its children. Dates are "YYYY-MM-DD",
// so plain string compare is the same as chronological compare.
export function recomputeRollups(state) {
  const s = state || S.state;
  if (!s || !Array.isArray(s.tasks)) return;
  const kids = new Map();
  for (const t of s.tasks) {
    if (!t.parentId) continue;
    if (!kids.has(t.parentId)) kids.set(t.parentId, []);
    kids.get(t.parentId).push(t);
  }
  for (const t of s.tasks) {
    const cs = kids.get(t.id);
    if (!cs || !cs.length) continue;
    let min = null, max = null;
    for (const c of cs) {
      if (!c.start) continue;
      const end = c.isMilestone ? c.start : (c.end || c.start);
      if (min === null || c.start < min) min = c.start;
      if (max === null || end > max) max = end;
    }
    if (min) { t.start = min; t.end = max; }
  }
}

// --- misc state utilities ---
let _counter = 0;
export function uid(prefix) { return prefix + Date.now().toString(36) + (_counter++).toString(36); }

export function pickColor() { return COLORS[S.state.groups.length % COLORS.length]; }

export function snapshot() { return JSON.parse(JSON.stringify(S.state)); }
export function restoreState(snap) { S.state = snap; markDirty(); updateViewButtons(); render(); }
