// ---------------------------------------------------------------------------
// App constants & geometry.
//
// Pure data only — no DOM, no network. Anything specific to a particular
// storage backend (collection paths, document field names) lives in
// src/backend/firestore.js instead, NOT here.
// ---------------------------------------------------------------------------

// Row / bar geometry (pixels) — must match --row-h / --bar-h in styles/tokens.css
export const ROW_H = 42;
export const BAR_H = 26;
export const BAR_PAD = (ROW_H - BAR_H) / 2;

// Per-view column width (pixels per day) for the day / week / month zoom levels.
export const VIEW = {
  day:   { dayWidth: 46 },
  week:  { dayWidth: 22 },
  month: { dayWidth: 7  }
};

export const DAY_MS = 86400000;
export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// Timeline padding (days) added on each side at first layout.
export const INITIAL_PAD = 180;
// Start extending the endless timeline when scrolled within this many px of an edge.
export const EDGE_PX = 400;

// Default palette offered in the editor swatches and used for new groups.
export const COLORS = ["#f4795b","#f0a12e","#e9c46a","#7fb069","#4ecdc4","#5c9ded","#a78bda","#ef7fae"];

// Autosave timing (ms).
//
// Raised from 2.5s/15s when moving to Firestore. The Spark plan allows roughly
// 20,000 writes/day; at 2.5s idle, continuous editing is ~4 writes/min, so a
// single editor could spend ~2,000 writes in a working day and three or four
// would brush the ceiling. Each save also costs 2 billed rules reads for the
// role lookup. The 3-way merge makes the longer window safe — a teammate's
// concurrent edits are folded in rather than lost.
export const SAVE_IDLE_MS = 5000;   // save this long after the last edit
export const SAVE_MAX_MS = 30000;   // ...but force a save at least this often during continuous editing

// Live team-sync polling. Still off: on Firestore the right answer is an
// onSnapshot listener, which charges 1 read per CHANGED document instead of 1
// per poll — strictly cheaper than this ever was. That's the planned follow-up;
// polling stays available as the fallback until it lands.
export const POLL_MS = 5000;
export const POLL_ENABLED = false;

// Name shown for a workspace whose registry has none yet (pre-workspace bins).
export const DEFAULT_WORKSPACE_NAME = "Workspace";

// localStorage keys.
export const THEME_KEY = "gantt_theme_v1";
export const COLLAPSE_KEY = "gantt_collapsed_v1";
export const VIEWTAB_KEY = "gantt_viewtab_v1";

// Last-viewed workspace/board plus a cached workspace name, so the switcher can
// paint before the network answers: { wsId, boards: {wsId: boardId}, names: {} }.
// NOTHING SECRET GOES IN HERE. Access lives in Firestore member documents; this
// is only a UI convenience and is safe to lose.
export const LAST_KEY = "gantt_last_v1";

// Pre-Firebase keys, scrubbed on first run (see memberships.forgetLegacyKeys).
// gantt_workspaces_v1 and gantt_jsonbin_v1 both stored JSONBin Master Keys in
// plaintext — account-wide credentials that could not be scoped or revoked
// per person. They are deleted rather than migrated: leaving them in people's
// browsers is the exact problem this migration removes.
export const LEGACY_KEYS = ["gantt_workspaces_v1", "gantt_jsonbin_v1"];
