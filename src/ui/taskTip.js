// ---------------------------------------------------------------------------
// What a task's hover card says.
//
// Lives apart from tooltip.js (which only knows how to show a card) and from the
// renderers (which each attach it), so the chart bar and the left list row can
// never drift into saying different things about the same task.
//
// Dates stay in ISO, in mono — the same voice as the Tasks view's date line and
// the chart's date axis.
// ---------------------------------------------------------------------------
import { esc } from "../dom.js";
import { icon } from "../icons.js";
import { today, fmtD } from "../dates.js";

// A checkpoint whose date falls outside its task's span: still real data, so it
// is drawn pinned to the capsule's edge and labelled rather than dropped.
export function isOutside(t, cp) {
  if (t.isMilestone) return false;
  return cp.date < t.start || cp.date > t.end;
}

// True when the task has something a hover card would add. Renderers check this
// before attaching, so a board using neither feature gets no hover chrome at all.
export function hasTip(t) {
  return !!(t.owner || (!t.isMilestone && t.checkpoints && t.checkpoints.length));
}

export function taskTipHtml(t) {
  if (!hasTip(t)) return "";
  const now = fmtD(today());
  const dates = t.isMilestone ? esc(t.start) : `${esc(t.start)} – ${esc(t.end)}`;
  const owner = t.owner
    ? `<div class="tip-owner">${icon("user")}${esc(t.owner)}</div>` : "";
  // A milestone task has no capsule to draw dots in, so its checkpoints are
  // dormant (kept, not deleted, so unticking Milestone brings them back) and
  // nothing claims otherwise.
  const cps = (t.isMilestone ? [] : (t.checkpoints || [])).map(c =>
    `<div class="tip-cp">
       <i class="tip-dot${c.date <= now ? " done" : ""}${isOutside(t, c) ? " out" : ""}"></i>
       <span class="tip-cp-date">${esc(c.date)}</span>
       <span class="tip-cp-label">${esc(c.label || "Checkpoint")}</span>
     </div>`).join("");
  return `<div class="tip-name">${esc(t.name)}</div>
          <div class="tip-dates">${dates}</div>
          ${owner}
          ${cps ? `<div class="tip-cps">${cps}</div>` : ""}`;
}

// The card for one dot. Deliberately narrower than the bar's: you pointed at a
// single date, so it answers about that date.
export function checkpointTipHtml(t, cp) {
  const note = isOutside(t, cp)
    ? `<div class="tip-note">Outside this task’s dates — pinned to the bar’s edge.</div>` : "";
  return `<div class="tip-name">${esc(cp.label || "Checkpoint")}</div>
          <div class="tip-dates">${esc(cp.date)}</div>
          ${note}`;
}
