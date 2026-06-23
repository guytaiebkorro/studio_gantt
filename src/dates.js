// ---------------------------------------------------------------------------
// Date helpers (local time, date-only) and chart geometry (date <-> x).
//
// The bottom geometry helpers read the shared store (current view mode and the
// visible range); the top helpers are pure.
// ---------------------------------------------------------------------------
import { VIEW, DAY_MS, INITIAL_PAD } from "./config.js";
import { S } from "./state.js";

// --- pure date math ---
export function parseD(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
export function fmtD(dt) {
  const y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, "0"), d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
export function addDays(dt, n) { const r = new Date(dt); r.setDate(r.getDate() + n); return r; }
export function diffDays(a, b) { return Math.round((stripTime(b) - stripTime(a)) / DAY_MS); }
export function stripTime(dt) { return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); }
export function today() { return stripTime(new Date()); }

// --- geometry: date <-> x coordinate (depend on view mode + visible range) ---
export function dayWidth() { return VIEW[S.state.settings.viewMode].dayWidth; }
export function dateToX(dt) { return diffDays(S.rangeStart, dt) * dayWidth(); }
export function xToDate(x) { return addDays(S.rangeStart, Math.round(x / dayWidth())); }
export function totalDays() { return diffDays(S.rangeStart, S.rangeEnd) + 1; }
export function chartWidth() { return totalDays() * dayWidth(); }

// Expand the visible range to fit all tasks + today + padding. Grows only —
// never shrinks an already-extended window, keeping the timeline endless.
export function ensureRange() {
  let min = null, max = null;
  for (const t of S.state.tasks) {
    const s = parseD(t.start), e = parseD(t.isMilestone ? t.start : t.end);
    if (!min || s < min) min = s;
    if (!max || e > max) max = e;
  }
  const t = today();
  if (!min) { min = t; max = t; }
  if (t < min) min = t;
  if (t > max) max = t;
  let desiredStart = addDays(min, -INITIAL_PAD);
  let desiredEnd = addDays(max, INITIAL_PAD);
  // align start to a Sunday for clean week columns (Israeli week starts Sunday)
  desiredStart = addDays(desiredStart, -desiredStart.getDay());
  if (!S.rangeStart || desiredStart < S.rangeStart) S.rangeStart = desiredStart;
  if (!S.rangeEnd || desiredEnd > S.rangeEnd) S.rangeEnd = desiredEnd;
}
