// ---------------------------------------------------------------------------
// The board document's invariants, ported DOM-free.
//
// ⚠️  THIS IS A DELIBERATE COPY of normalize() / repairHierarchy() /
//     recomputeRollups() from src/state.js. KEEP THE TWO IN STEP.
//
// It is copied rather than imported because src/state.js touches `document` and
// `localStorage` at module-evaluation time (it reads the #gantt-data block and
// the collapse map), so it cannot be loaded in Node. The honest fix would be to
// extract the pure invariant logic out of state.js into a shared DOM-free
// module that both the app and this CLI import; that refactor is worth doing,
// but it changes app code, so it is not bundled into an import tool.
//
// Why the CLI needs them at all: imported boards must satisfy the same
// invariants the app maintains, or the first client to load one will silently
// rewrite it — parents' dates are DERIVED but stored, so a stale rollup would
// look like a spurious edit from whoever opened it first.
// ---------------------------------------------------------------------------

const VIEW_MODES = ["day", "week", "month"];

let _counter = 0;
function uid(prefix) { return prefix + Date.now().toString(36) + (_counter++).toString(36); }

export function normalize(data) {
  data = data || {};
  const s = {
    version: 1,
    settings: { viewMode: (data.settings && data.settings.viewMode) || "week" },
    groups: Array.isArray(data.groups) ? data.groups : [],
    tasks: Array.isArray(data.tasks) ? data.tasks : []
  };
  if (!VIEW_MODES.includes(s.settings.viewMode)) s.settings.viewMode = "week";
  s.tasks.forEach((t) => {
    t.deps = Array.isArray(t.deps) ? t.deps : [];
    delete t.progress;  // legacy field — progress is derived from dates now
    t.isMilestone = !!t.isMilestone;
    t.description = typeof t.description === "string" ? t.description : "";
    t.parentId = typeof t.parentId === "string" ? t.parentId : null;
    if (!t.end) t.end = t.start;
    if (!t.id) t.id = uid("t");
  });
  repairHierarchy(s);
  recomputeRollups(s);
  return s;
}

function repairHierarchy(s) {
  const byId = new Map(s.tasks.map((t) => [t.id, t]));

  // parentId must name a different, existing task
  for (const t of s.tasks) {
    if (t.parentId && (t.parentId === t.id || !byId.has(t.parentId))) t.parentId = null;
  }
  // one level only: re-point at the top-most ancestor. The visited set is what
  // stops a cycle (which a 3-way merge can produce) from hanging this loop.
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
  const parents = new Set(s.tasks.filter((t) => t.parentId).map((t) => t.parentId));
  for (const t of s.tasks) if (parents.has(t.id)) t.isMilestone = false;
}

function recomputeRollups(s) {
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

// Report what normalize() would change, so an import can say so out loud rather
// than quietly rewriting someone's data.
export function diffReport(before, after) {
  const notes = [];
  const b = before || {}, a = after || {};
  const bt = Array.isArray(b.tasks) ? b.tasks : [];
  const at = Array.isArray(a.tasks) ? a.tasks : [];
  if (bt.length !== at.length) notes.push(`task count ${bt.length} -> ${at.length}`);
  if ((b.settings || {}).viewMode !== (a.settings || {}).viewMode) {
    notes.push(`viewMode ${(b.settings || {}).viewMode} -> ${(a.settings || {}).viewMode}`);
  }
  const byId = new Map(bt.map((t) => [t.id, t]));
  let reparented = 0, unmilestoned = 0, rolled = 0, progressDropped = 0, depsFixed = 0;
  for (const t of at) {
    const o = byId.get(t.id);
    if (!o) continue;
    if ((o.parentId || null) !== (t.parentId || null)) reparented++;
    if (!!o.isMilestone !== !!t.isMilestone) unmilestoned++;
    if (o.start !== t.start || o.end !== t.end) rolled++;
    if ("progress" in o) progressDropped++;
    if (!Array.isArray(o.deps)) depsFixed++;
  }
  if (reparented) notes.push(`${reparented} task(s) re-parented (dangling/depth-2/cyclic parentId)`);
  if (unmilestoned) notes.push(`${unmilestoned} container(s) un-milestoned`);
  if (rolled) notes.push(`${rolled} parent date(s) rolled up from children`);
  if (progressDropped) notes.push(`${progressDropped} legacy progress field(s) dropped`);
  if (depsFixed) notes.push(`${depsFixed} missing deps array(s) added`);
  return notes;
}
