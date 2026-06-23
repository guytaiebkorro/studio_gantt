// ---------------------------------------------------------------------------
// App constants & geometry.
//
// Pure data only — no DOM, no network. Anything specific to a particular
// storage backend (JSONBin keys, URLs, default bin ids) lives in
// src/backend/jsonbin.js instead, NOT here.
// ---------------------------------------------------------------------------

// Row / bar geometry (pixels)
export const ROW_H = 38;
export const BAR_H = 22;
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
export const COLORS = ["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#ec4899","#14b8a6","#f97316"];

// Autosave timing (ms).
export const SAVE_IDLE_MS = 2500;   // save this long after the last edit
export const SAVE_MAX_MS = 15000;   // ...but force a save at least this often during continuous editing

// Live team-sync polling. OFF by default to conserve the JSONBin free tier.
export const POLL_MS = 5000;
export const POLL_ENABLED = false;

// localStorage keys.
export const THEME_KEY = "gantt_theme_v1";
export const COLLAPSE_KEY = "gantt_collapsed_v1";
export const CLOUD_KEY = "gantt_jsonbin_v1";
