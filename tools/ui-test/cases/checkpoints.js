// ---------------------------------------------------------------------------
// Owner + checkpoint cases.
//
// Import from ../harness.js, NEVER from ../suite.js — see the note at the top
// of harness.js. And note the ../../../ on app imports: this file is one level
// deeper than suite.js, so the repo root is three up, not two.
//
// Scope: the parts with logic in them — what normalize() accepts, where a dot
// lands, and what the editor keeps versus rewrites. How any of it LOOKS is not
// testable here; that is what `node tools/ui-test/shot.mjs board boardHover
// boardTasks editor` is for.
// ---------------------------------------------------------------------------
import { ck, note, $, S, setup } from "../harness.js";
import { normalize } from "../../../src/state.js";
import { today, fmtD, addDays, dateToX, dayWidth } from "../../../src/dates.js";
import { isOutside, hasTip, taskTipHtml } from "../../../src/ui/taskTip.js";
import { render } from "../../../src/render/index.js";
import { openEditor, closeEditor } from "../../../src/ui/editor.js";

const d = (n) => fmtD(addDays(today(), n));

// --- normalize: the one place the invariants are restored -------------------
const messy = normalize({
  tasks: [{
    id: "t1", name: "A", start: "2026-01-05", end: "2026-01-20",
    checkpoints: [
      { date: "2026-01-18", label: "late" },
      { date: "not-a-date", label: "junk" },   // malformed → dropped
      null,                                     // not an object → dropped
      { date: "2026-01-10", label: "  early  " }
    ]
  }]
});
const cps = messy.tasks[0].checkpoints;
ck("checkpoints: entries without a valid YYYY-MM-DD date are dropped", cps.length, 2);
ck("checkpoints: kept sorted by date", cps.map(c => c.date).join(","), "2026-01-10,2026-01-18");
ck("checkpoints: labels trimmed", cps[0].label, "early");
ck("checkpoints: a missing id is minted", cps.every(c => typeof c.id === "string" && c.id.length > 0), true);
ck("checkpoints: distinct ids", cps[0].id === cps[1].id, false);

// An id that IS present must survive — the editor reuses it to keep a row's
// identity across a save, and reminting would churn the document on every edit.
const kept = normalize({ tasks: [{ id: "t1", start: "2026-01-05", end: "2026-01-20",
  checkpoints: [{ id: "keepme", date: "2026-01-06", label: "" }] }] });
ck("checkpoints: an existing id is preserved", kept.tasks[0].checkpoints[0].id, "keepme");

// Pre-feature boards: neither field is there at all.
const bare = normalize({ tasks: [{ id: "t1", start: "2026-01-05" }] }).tasks[0];
ck("checkpoints: absent field normalizes to []", Array.isArray(bare.checkpoints) && bare.checkpoints.length, 0);
ck("owner: absent field normalizes to \"\"", bare.owner, "");
ck("owner: trimmed on load",
   normalize({ tasks: [{ id: "t1", start: "2026-01-05", owner: "  Dana  " }] }).tasks[0].owner, "Dana");
ck("owner: a non-string is ignored rather than coerced",
   normalize({ tasks: [{ id: "t1", start: "2026-01-05", owner: { nope: 1 } }] }).tasks[0].owner, "");

// Export → import is a plain JSON round-trip through normalize (persistence.js).
const round = normalize(JSON.parse(JSON.stringify(messy))).tasks[0];
ck("checkpoints: survive an export/import round-trip",
   JSON.stringify(round.checkpoints), JSON.stringify(cps));

// --- isOutside / hasTip ----------------------------------------------------
const span = { start: "2026-01-05", end: "2026-01-20", isMilestone: false };
ck("isOutside: before the start", isOutside(span, { date: "2026-01-04" }), true);
ck("isOutside: on the start", isOutside(span, { date: "2026-01-05" }), false);
ck("isOutside: on the end", isOutside(span, { date: "2026-01-20" }), false);
ck("isOutside: after the end", isOutside(span, { date: "2026-01-21" }), true);

ck("hasTip: nothing to say about a plain task",
   hasTip({ name: "x", owner: "", checkpoints: [] }), false);
ck("hasTip: an owner alone is enough",
   hasTip({ name: "x", owner: "Dana", checkpoints: [] }), true);
ck("hasTip: a checkpoint alone is enough",
   hasTip({ name: "x", owner: "", checkpoints: [{ date: "2026-01-06" }] }), true);
// A milestone has no capsule, so its checkpoints are dormant — a card that
// listed them would be describing dots that are not drawn anywhere.
ck("hasTip: a milestone's dormant checkpoints don't earn a card",
   hasTip({ name: "x", isMilestone: true, owner: "", checkpoints: [{ date: "2026-01-06" }] }), false);
ck("taskTipHtml: a milestone's card lists no checkpoints",
   taskTipHtml({ name: "x", isMilestone: true, start: "2026-01-06", owner: "Dana",
                 checkpoints: [{ date: "2026-01-06", label: "nope" }] }).includes("nope"), false);
ck("taskTipHtml: escapes the owner",
   taskTipHtml({ name: "x", start: "2026-01-06", end: "2026-01-06",
                 owner: "<img>", checkpoints: [] }).includes("&lt;img&gt;"), true);

// --- the dots on the chart -------------------------------------------------
await setup("admin");
S.state = normalize({
  version: 1, settings: { viewMode: "week" },
  groups: [{ id: "g1", name: "G", color: "#5c9ded" }],
  tasks: [
    { id: "t1", name: "Span", groupId: "g1", start: d(-10), end: d(20), owner: "Dana",
      checkpoints: [
        { id: "c1", date: d(-5), label: "passed" },
        { id: "c2", date: d(8), label: "ahead" },
        { id: "c3", date: d(40), label: "outside" }
      ] },
    { id: "t2", name: "Plain", groupId: "g1", start: d(0), end: d(3) },
    { id: "t3", name: "Diamond", groupId: "g1", start: d(5), end: d(5), isMilestone: true,
      checkpoints: [{ id: "c4", date: d(5), label: "dormant" }] }
  ]
});
render();

const dots = document.querySelectorAll('.bar[data-id="t1"] .cp-dot');
ck("chart: one dot per checkpoint", dots.length, 3);
ck("chart: a passed date is filled", dots[0].classList.contains("done"), true);
ck("chart: a date still ahead is hollow", dots[1].classList.contains("done"), false);
ck("chart: a date outside the span is marked", dots[2].classList.contains("out"), true);
ck("chart: a date inside the span is not marked out", dots[0].classList.contains("out"), false);
ck("chart: no dots on a task without any",
   document.querySelectorAll('.bar[data-id="t2"] .cp-dot').length, 0);
ck("chart: a milestone draws no dots (nothing to draw them in)",
   document.querySelectorAll('.milestone[data-id="t3"] .cp-dot').length, 0);

// Position: `left` is the dot's CENTRE (CSS does translateX(-50%)), on its own
// day column, measured from the bar's left edge — the geometry the today line uses.
const bar = document.querySelector('.bar[data-id="t1"]');
const barX = parseFloat(bar.style.left);
const CP_EDGE = 5;
const wantMid = dateToX(addDays(today(), -5)) + dayWidth() / 2 - barX;
ck("chart: an in-range dot sits on its date",
   Math.abs(parseFloat(dots[0].style.left) - wantMid) < 0.51, true);
// ...and one outside pins to the capsule's edge rather than being clipped away
const barW = parseFloat(bar.style.width);
ck("chart: an out-of-range dot pins inside the capsule's right edge",
   parseFloat(dots[2].style.left), barW - CP_EDGE);

// The label hands the bottom band to the dots — that class is what does it.
ck("chart: a bar with dots yields the bottom band to them",
   bar.classList.contains("has-cps"), true);
ck("chart: a bar without dots keeps its label centred",
   document.querySelector('.bar[data-id="t2"]').classList.contains("has-cps"), false);
// The label must not be clipped by the shorter line box it now sits in.
const lbl = bar.querySelector(".label");
ck("chart: the tightened label still fits its own glyphs",
   lbl.scrollHeight <= lbl.clientHeight, true);
// Dragging a bar works by pointerdown bubbling up from whatever is inside it
// (attachBarDrag excludes only .handle), so a dot must NOT opt out of pointer
// events — that would also cost it its own hover card.
ck("chart: a dot still takes pointer events, so grabbing one drags the bar",
   getComputedStyle(dots[0]).pointerEvents === "none", false);

// Zoom: the geometry is dayWidth()-relative, so a dot has to re-land on its own
// date at every zoom level, not just the one it was first laid out in.
S.state.settings.viewMode = "month";
render();
const mDots = document.querySelectorAll('.bar[data-id="t1"] .cp-dot');
const mBar = document.querySelector('.bar[data-id="t1"]');
const mWant = dateToX(addDays(today(), -5)) + dayWidth() / 2 - parseFloat(mBar.style.left);
ck("chart: month view re-lands the dot on its date",
   Math.abs(parseFloat(mDots[0].style.left) - mWant) < 0.51, true);
ck("chart: month view still clamps the out-of-range dot inside the capsule",
   parseFloat(mDots[2].style.left) <= parseFloat(mBar.style.width) - CP_EDGE, true);
S.state.settings.viewMode = "week";
render();

// --- the editor ------------------------------------------------------------
openEditor("t1");
ck("editor: owner populated", $("f-owner").value, "Dana");
ck("editor: one row per checkpoint", $("f-checkpoints").querySelectorAll(".cp-row").length, 3);
ck("editor: rows carry their existing id", $("f-checkpoints").querySelector(".cp-row").dataset.cpId, "c1");
ck("editor: the out-of-range hint names the one that is outside",
   $("f-cp-hint").textContent.startsWith("1 checkpoint falls outside"), true);

// Edit a label, blank one row's date, and save. A blank date is an abandoned
// row, so it must be dropped rather than defaulted onto some guessed day.
const rows = $("f-checkpoints").querySelectorAll(".cp-row");
rows[0].querySelector(".cp-label").value = "renamed";
rows[1].querySelector(".cp-date").value = "";
$("f-owner").value = "  Yael  ";
$("f-save").click();
const t1 = S.state.tasks.find(t => t.id === "t1");
ck("editor: owner saved and trimmed", t1.owner, "Yael");
ck("editor: a row with no date is dropped", t1.checkpoints.length, 2);
ck("editor: the edited label is saved", t1.checkpoints[0].label, "renamed");
ck("editor: untouched rows keep their ids", t1.checkpoints.map(c => c.id).join(","), "c1,c3");

// Ticking Milestone hides the section, so its inputs are not the truth — the
// stored checkpoints have to survive being invisible.
openEditor("t1");
$("f-milestone").checked = true;
$("f-milestone").dispatchEvent(new Event("change"));
ck("editor: the checkpoints section hides for a milestone",
   $("checkpoints-wrap").style.display, "none");
$("f-save").click();
const asMs = S.state.tasks.find(t => t.id === "t1");
ck("editor: a milestone keeps its checkpoints (dormant, not deleted)", asMs.checkpoints.length, 2);
ck("editor: ...and is a milestone", asMs.isMilestone, true);

// Untick: they come straight back, like a subtask's colour does.
openEditor("t1");
$("f-milestone").checked = false;
$("f-milestone").dispatchEvent(new Event("change"));
ck("editor: unticking Milestone shows the section again",
   $("checkpoints-wrap").style.display, "");
ck("editor: ...with the rows still there", $("f-checkpoints").querySelectorAll(".cp-row").length, 2);
$("f-save").click();
ck("editor: still two checkpoints after the round trip",
   S.state.tasks.find(t => t.id === "t1").checkpoints.length, 2);

// A new row defaults to the task's start date, which keeps its dot inside the bar.
openEditor("t1");
$("f-cp-add").click();
const added = $("f-checkpoints").querySelectorAll(".cp-row");
ck("editor: ＋ Add checkpoint appends a row", added.length, 3);
ck("editor: a new row starts on the task's start date",
   added[2].querySelector(".cp-date").value, $("f-start").value);
ck("editor: a new row has no id yet (normalize mints it on save)",
   added[2].dataset.cpId, "");
closeEditor();
ck("editor: Cancel commits nothing",
   S.state.tasks.find(t => t.id === "t1").checkpoints.length, 2);

// Duplicate copies the owner and the checkpoints, with fresh checkpoint ids.
openEditor("t1");
$("f-duplicate").click();
const copy = S.state.tasks.find(t => t.name === "Span (copy)");
ck("duplicate: the copy exists", !!copy, true);
ck("duplicate: owner copied", copy.owner, "Yael");
ck("duplicate: checkpoints copied", copy.checkpoints.length, 2);
ck("duplicate: labels copied", copy.checkpoints[0].label, "renamed");
ck("duplicate: checkpoint ids reminted",
   copy.checkpoints.some(c => ["c1", "c3"].includes(c.id)), false);
note("checkpoints: appearance is covered by shot.mjs (board, boardHover, boardTasks, editor)");
