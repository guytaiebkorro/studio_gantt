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

// Autosave timing (ms). THIS IS THE WHOLE COLLABORATION LATENCY — the listener
// in sync.js delivers in well under a second, so whatever is set here is how far
// behind your teammates are. It costs the editor nothing either way: the local
// render already happened.
//
// Not write-quota bound at these values. Every markDirty() call site is a
// completed gesture, never a keystroke, so the edit count is set by how fast a
// person finishes a drag and not by this timer — five editors at ~300 edits each
// is ~1,500 writes/day against a 20,000 quota.
//
// WHAT DOES BIND IS PER-DOCUMENT: every editor writes the same board document,
// and Firestore's sustained limit is ~1 write/sec/document. Do not drop the idle
// below ~1.5s while a board is one document — you would split multi-drag bursts
// into separate writes and contend for no perceptual gain. Per-task documents
// (docs/plans/2026-09-03-live-sync.md §4) are what lifts that ceiling.
//
// SAVE_MAX_MS must stay above SAVE_IDLE_MS: scheduleCloudSave waits
// min(IDLE, MAX - elapsed), so a smaller MAX would always win and kill the knob.
export const SAVE_IDLE_MS = 2000;   // save this long after the last edit
export const SAVE_MAX_MS = 8000;    // ...but at least this often while editing continuously

// A LOST rev RACE AND A REVOKED ROLE ARE THE SAME ERROR CODE. The rules require
// `rev == resource.data.rev + 1`, so a stale write is permission-denied —
// indistinguishable from "you are no longer an editor" without re-reading the
// member document. A race succeeds on the next attempt; a real denial fails
// every time. Small on purpose: the transaction already absorbs the contention
// it can see, so this only covers a stale tab on an older build.
export const SAVE_RETRY_MAX = 3;

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
