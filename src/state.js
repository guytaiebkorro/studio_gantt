// ---------------------------------------------------------------------------
// Central app store.
//
// In the original single-file app every piece of state was a module-scope
// `let`. With ES modules you cannot reassign an imported binding from another
// file, so all mutable state now lives as PROPERTIES of one shared object `S`.
// Modules read/write `S.foo`; the live object is the single source of truth.
// ---------------------------------------------------------------------------
import { VIEW, COLLAPSE_KEY, COLORS } from "./config.js";
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
    t.progress = typeof t.progress === "number" ? t.progress : 0;
    t.isMilestone = !!t.isMilestone;
    if (!t.end) t.end = t.start;
    if (!t.id) t.id = uid("t");
  });
  return s;
}

// --- misc state utilities ---
let _counter = 0;
export function uid(prefix) { return prefix + Date.now().toString(36) + (_counter++).toString(36); }

export function pickColor() { return COLORS[S.state.groups.length % COLORS.length]; }

export function snapshot() { return JSON.parse(JSON.stringify(S.state)); }
export function restoreState(snap) { S.state = snap; markDirty(); updateViewButtons(); render(); }
