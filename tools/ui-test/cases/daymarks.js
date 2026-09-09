// ---------------------------------------------------------------------------
// Marked-day cases: workspace-scoped coloured spans painted behind the chart.
//
// Import from ../harness.js, NEVER from ../suite.js — see the note at the top
// of harness.js.
//
// Scope: what normalizeDayMarks accepts, where a stripe lands at each zoom, and
// that none of this touches the board document. How it LOOKS is not testable
// here.
// ---------------------------------------------------------------------------
import { ck, note, $, S, calls, setup } from "../harness.js";
import { normalizeDayMarks } from "../../../src/state.js";
import { parseD, fmtD, addDays, dateToX, dayWidth } from "../../../src/dates.js";
import { dayMarkTipHtml } from "../../../src/ui/taskTip.js";
import { render } from "../../../src/render/index.js";
import { HOLIDAYS_IL, HOLIDAY_COLOR } from "../../admin/src/holidays-il.js";

// --- normalizeDayMarks: the only place the invariants are restored ----------
const messy = normalizeDayMarks([
  { date: "2026-05-10", end: "2026-05-12", label: "  Offsite  ", color: "#123abc" },
  { date: "nonsense", label: "junk" },                      // malformed date → dropped
  null,                                                      // not an object → dropped
  { date: "2026-01-02", end: "2025-12-30", label: "Back" },  // end before start → coerced up
  { date: "2026-03-01", color: "not-a-colour" },             // bad colour → palette fallback
  { date: "2026-02-01" }                                     // no end → single day
]);

ck("dayMarks: entries without a valid YYYY-MM-DD date are dropped", messy.length, 4);
ck("dayMarks: kept sorted by date",
   messy.map(m => m.date).join(","), "2026-01-02,2026-02-01,2026-03-01,2026-05-10");
ck("dayMarks: labels trimmed", messy.find(m => m.date === "2026-05-10").label, "Offsite");
ck("dayMarks: a backwards end is coerced up to the start",
   messy.find(m => m.date === "2026-01-02").end, "2026-01-02");
ck("dayMarks: a missing end becomes the start, so every entry is a range",
   messy.find(m => m.date === "2026-02-01").end, "2026-02-01");
ck("dayMarks: a valid colour is kept", messy.find(m => m.date === "2026-05-10").color, "#123abc");
ck("dayMarks: a bad colour falls back rather than dropping the date",
   /^#[0-9a-f]{6}$/i.test(messy.find(m => m.date === "2026-03-01").color), true);
ck("dayMarks: a missing id is minted", messy.every(m => typeof m.id === "string" && m.id.length > 0), true);
ck("dayMarks: distinct ids", new Set(messy.map(m => m.id)).size, 4);
ck("dayMarks: an explicit id is preserved (seeding depends on it)",
   normalizeDayMarks([{ id: "il-2026-purim", date: "2026-03-03" }])[0].id, "il-2026-purim");
ck("dayMarks: capped at 200",
   normalizeDayMarks(Array.from({ length: 260 }, (_, i) => ({ date: "2026-01-01" }))).length, 200);
ck("dayMarks: a non-array is []", normalizeDayMarks(undefined).length, 0);

// --- the checked-in holiday table -------------------------------------------
//
// It is hand-editable data, so it gets the same treatment as any other input:
// normalizing it must be a no-op, or the table has drifted.
const normalizedTable = normalizeDayMarks(HOLIDAYS_IL.map(h => ({ ...h, color: HOLIDAY_COLOR })));
ck("holidays: every row survives normalization", normalizedTable.length, HOLIDAYS_IL.length);
ck("holidays: already sorted by date",
   normalizedTable.map(m => m.id).join(","), HOLIDAYS_IL.map(m => m.id).join(","));
ck("holidays: ids are unique", new Set(HOLIDAYS_IL.map(h => h.id)).size, HOLIDAYS_IL.length);
ck("holidays: ids are deterministic, so re-seeding is an upsert",
   HOLIDAYS_IL.every(h => h.id.startsWith("il-")), true);
ck("holidays: no entry runs backwards", HOLIDAYS_IL.every(h => h.end >= h.date), true);
// Chol HaMoed is excluded, so Pesach and Sukkot are the chag at either end and
// nothing in the table is longer than the 3-day Rosh Hashana span (erev + 2).
const longest = Math.max(...HOLIDAYS_IL.map(h =>
  Math.round((parseD(h.end) - parseD(h.date)) / 86400000) + 1));
ck("holidays: no span longer than 3 days — chol hamoed is excluded", longest, 3);
ck("holidays: chol hamoed Pesach is not covered",
   HOLIDAYS_IL.some(h => h.date <= "2026-04-05" && h.end >= "2026-04-05"), false);
ck("holidays: chol hamoed Sukkot is not covered",
   HOLIDAYS_IL.some(h => h.date <= "2026-09-29" && h.end >= "2026-09-29"), false);
ck("holidays: Hoshana Raba is not covered",
   HOLIDAYS_IL.some(h => h.date <= "2026-10-02" && h.end >= "2026-10-02"), false);
ck("holidays: but Shmini Atzeret the day after IS",
   HOLIDAYS_IL.some(h => h.date <= "2026-10-03" && h.end >= "2026-10-03"), true);

// --- loading ----------------------------------------------------------------
await setup("admin");
ck("dayMarks: loaded from the workspace document", S.dayMarks.length, 2);
ck("dayMarks: sorted on load, not in fixture order",
   S.dayMarks.map(m => m.date).join(","), "2026-03-03,2026-09-20");
ck("dayMarks: NOT part of the board document", S.state.dayMarks, undefined);

// --- rendering --------------------------------------------------------------
//
// The marks are placed relative to the visible range, so the assertions compute
// the expected x the same way the renderer does rather than hardcoding pixels.
S.dayMarks = normalizeDayMarks([
  { id: "m1", date: fmtD(addDays(new Date(), 3)), end: fmtD(addDays(new Date(), 5)),
    label: "Shutdown", color: "#a78bda" }
]);
render();

let strips = document.querySelectorAll("#chart-body .day-mark");
ck("render: one body stripe per mark", strips.length, 1);
ck("render: one header ribbon per mark", document.querySelectorAll("#chart-header .day-mark").length, 1);
ck("render: a 3-day span is ONE stripe, not three", strips.length, 1);
ck("render: the header ribbon carries the label",
   document.querySelector("#chart-header .day-mark").textContent, "Shutdown");

const from = addDays(new Date(), 3), to = addDays(new Date(), 5);
ck("render: stripe starts at the mark's date", strips[0].style.left, dateToX(from) + "px");
ck("render: stripe spans start..end inclusive",
   strips[0].style.width, (dateToX(to) + dayWidth() - dateToX(from)) + "px");
ck("render: the colour is passed as a custom property, so CSS can tint it",
   strips[0].style.getPropertyValue("--mark-color").trim(), "#a78bda");

// Width is in days, so it must track the zoom level.
const weekWidth = strips[0].style.width;
S.state.settings.viewMode = "day";
render();
strips = document.querySelectorAll("#chart-body .day-mark");
ck("render: the stripe re-measures on zoom", strips[0].style.width === weekWidth, false);
ck("render: 3 days at day zoom is 3 * dayWidth", strips[0].style.width, (3 * dayWidth()) + "px");
S.state.settings.viewMode = "month";
render();
ck("render: month view draws the stripe too — a per-column class could not",
   document.querySelectorAll("#chart-body .day-mark").length, 1);
S.state.settings.viewMode = "week";

// Stacking: a stripe must never sit over a bar. Asserted on the stylesheet
// rather than the element, since that is where the value lives.
render();
const stripZ = getComputedStyle(document.querySelector("#chart-body .day-mark")).zIndex;
ck("render: stripes stack below bars (z 8)", Number(stripZ) < 8, true);
ck("render: stripes stack below the today line (z 6)", Number(stripZ) < 6, true);

// Out of range: the timeline is endless and grows on scroll, so a mark far
// outside it must not draw — and must not widen the scroll area if it did.
const widthBefore = $("chart-body").style.width;
S.dayMarks = normalizeDayMarks([{ id: "m2", date: "2099-01-01", end: "2099-01-02", label: "Far", color: "#a78bda" }]);
render();
ck("render: a mark outside the visible range draws nothing",
   document.querySelectorAll("#chart-body .day-mark").length, 0);
ck("render: ...and does not widen the chart", $("chart-body").style.width, widthBefore);

// --- the hover card ---------------------------------------------------------
ck("tip: a range reads as a range",
   dayMarkTipHtml({ date: "2026-04-01", end: "2026-04-02", label: "Pesach" }).includes("2026-04-01 – 2026-04-02"),
   true);
ck("tip: a single day reads as one date, not a range of one",
   dayMarkTipHtml({ date: "2026-03-03", end: "2026-03-03", label: "Purim" }).includes("–"), false);
ck("tip: an unlabelled mark still says something",
   dayMarkTipHtml({ date: "2026-03-03", end: "2026-03-03", label: "" }).includes("Marked day"), true);

// --- the panel editor -------------------------------------------------------
const panel = await import("../../../src/ui/panel.js");
await setup("admin");

let reported = null;
panel.wirePanel({ onSaveDayMarks: (marks) => { reported = marks; } });
S.dayMarksOpen = false;
panel.renderPanel();

// Collapsed by default — a seeded workspace has ~20 entries at two rows each,
// and People sits below them.
ck("panel: the list starts collapsed", $("wp-days").hidden, true);
ck("panel: ...and builds no rows while collapsed", $("wp-days").innerHTML, "");
ck("panel: the header says how many are in there",
   $("wp-days-caption").querySelector(".wp-days-count").textContent, "2");
ck("panel: the header reports its state to assistive tech",
   $("wp-days-caption").getAttribute("aria-expanded"), "false");

panel.toggleDayMarks();
ck("panel: toggling expands it", $("wp-days").hidden, false);
ck("panel: ...and updates aria-expanded",
   $("wp-days-caption").getAttribute("aria-expanded"), "true");
ck("panel: the open state is remembered for next time",
   localStorage.getItem("gantt_daysopen_v1"), "1");

ck("panel: a row per mark", $("wp-days").querySelectorAll(".wp-day[data-id]").length, 2);
ck("panel: an editor gets the add button", !!$("wp-days").querySelector(".wp-day-add"), true);
ck("panel: a single-day mark shows a blank end, not a duplicate date",
   $("wp-days").querySelector('.wp-day[data-id="il-2026-purim"] .wp-day-end').value, "");
ck("panel: a range shows its end",
   $("wp-days").querySelector('.wp-day[data-id="il-2026-yom-kippur"] .wp-day-end').value, "2026-09-21");

// Editing commits on change — which is blur for these inputs, not per keystroke.
const labelInput = $("wp-days").querySelector('.wp-day[data-id="il-2026-purim"] .wp-day-label');
labelInput.value = "Purim (office closed)";
labelInput.dispatchEvent(new Event("change", { bubbles: true }));
ck("panel: an edit is reported through the handler", !!reported, true);
ck("panel: ...carrying the new label",
   (reported.find(m => m.id === "il-2026-purim") || {}).label, "Purim (office closed)");
ck("panel: ...and the untouched rows with it", reported.length, 2);

reported = null;
$("wp-days").querySelector('.wp-day[data-id="il-2026-purim"] .wp-day-del').click();
ck("panel: removing a row reports the remainder", reported.map(m => m.id).join(","), "il-2026-yom-kippur");

reported = null;
$("wp-days").querySelector(".wp-day-add").click();
ck("panel: adding a row writes nothing until it has a date", reported, null);
const blank = $("wp-days").querySelectorAll(".wp-day[data-id]");
ck("panel: ...but the row is there to type into", blank.length, 2);
ck("panel: a dateless row normalizes away", normalizeDayMarks(
   [{ id: "x", date: "", end: "", label: "", color: "#a78bda" }]).length, 0);

// --- permissions and isolation ----------------------------------------------
await setup("viewer");
panel.wirePanel({});
S.dayMarksOpen = true;
panel.renderPanel();
ck("panel: a viewer sees the marks", $("wp-days").querySelectorAll(".wp-day.ro").length, 2);
ck("panel: ...with nothing to click", $("wp-days").querySelectorAll("input, .wp-day-add").length, 0);

// The load-bearing one. Marked days are workspace data: if this ever starts
// touching the board, they inherit autosave, merge3 and undo — none of which
// they are shaped for. See docs/plans/2026-09-09-marked-days.md §2.
await setup("admin");
const { saveDayMarks } = await import("../../../src/boards.js");
calls.length = 0;
S.dirty = false;
await saveDayMarks([{ id: "n1", date: "2026-12-25", label: "Shutdown", color: "#a78bda" }]);
ck("isolation: saving marks writes the WORKSPACE document",
   calls.some(c => c[0] === "putDayMarks"), true);
ck("isolation: saving marks never writes the board",
   calls.some(c => c[0] === "saveBoard"), false);
ck("isolation: saving marks does not dirty the board", S.dirty, false);
ck("isolation: the local list updates immediately, before the round-trip",
   S.dayMarks.map(m => m.date).join(","), "2026-12-25");

note("marked days: normalize, render at all three zooms, panel editing, board isolation");
