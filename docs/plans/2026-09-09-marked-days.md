# Marked days — per-workspace coloured dates on the chart background

**Status: PLAN. Nothing built.**

**The one-line version:** a workspace gets a list of dated entries, each with a colour and a
label; the chart paints a translucent full-height stripe behind those days. Holidays, company
shutdowns, freeze weeks.

Three decisions are already made and are not re-opened below:

1. **Stored on the workspace document**, not the board — one list serves every board in the
   workspace. This is the expensive choice and §2 is honest about what it costs.
2. **Each entry is a range** with an optional end. Passover is one row, not eight.
3. **Each entry carries its own colour.** No reusable categories.

---

## 1. The data

On `/workspaces/{ws}`, a new field beside `name` and `boards`:

```js
dayMarks: [
  { id: "d…", date: "2026-04-02", end: "2026-04-09", label: "Passover",     color: "#f0a12e" },
  { id: "d…", date: "2026-05-14", end: "2026-05-14", label: "Independence", color: "#5c9ded" }
]
```

- `id` — `uid("d")`, so the rows have stable identity across a re-render.
- `date` / `end` — `"YYYY-MM-DD"`, validated against the `DATE_RE` already in `state.js`. `end` is
  always written (coerced up to `date` when blank or earlier), so every reader can treat an entry
  as a range and nothing has to branch on "is this one day".
- `label` — may be empty; readers fall back to the date. Capped at 60 chars.
- `color` — `#rrggbb`. Invalid values fall back to the first palette entry rather than being
  dropped, so a bad colour never costs you the date.

Capped at **200 entries**, matching the existing `boards` cap. Kept sorted by `date` so render
order is deterministic — the same property `normalizeCheckpoints` maintains, for the same reason.

**This is not part of `S.state`.** It never enters the board document, never calls `markDirty()`,
never rides autosave, and never appears in `merge3`. It is workspace-scoped data written directly,
exactly like the workspace name.

---

## 2. What choosing the workspace document costs

The board document rides a large amount of existing machinery: a 3-way merge, a transactional
write with a rev check, a live `onSnapshot` listener, an autosave debounce, and Undo. The
workspace document rides **none** of it. Concretely:

| | board doc | workspace doc |
|---|---|---|
| conflicting edits | 3-way merged, field level | last write wins, whole array |
| a teammate's change reaches you | ~1s, via the listener | on next workspace open (see §6) |
| undo | `snapshot()` / `restoreState()` | none |
| rules change needed | no | **yes, and it must be deployed** |

For a list of public holidays edited a few times a year by one person, every one of those is an
acceptable trade. It would not be for task data. The reason to write it down is that "why doesn't
this merge like everything else?" is a question someone will ask later.

**Last-write-wins is a real, if unlikely, data loss:** two admins editing the list in the same
minute means one of them silently loses their rows. Not worth a transaction at this size; worth
knowing.

---

## 3. Changes, file by file

### 3.1 `firestore.rules` — the only server-side change

The workspace `update` rule currently allows admins `['name', 'boards']` and editors `['boards']`.
Add `dayMarks` to **both**: editing the chart's furniture is an editing act, and an editor who can
move every bar on the board but not mark a holiday would be a strange line to draw.

```
allow update: if (
       ( myRole(ws) == 'admin'  && onlyChanged(['name', 'boards', 'dayMarks']) )
    || ( myRole(ws) == 'editor' && onlyChanged(['boards', 'dayMarks']) )
  )
  && …existing name and boards checks…
  && ( !('dayMarks' in request.resource.data)
       || ( request.resource.data.dayMarks is list
            && request.resource.data.dayMarks.size() <= 200 ) );
```

The `in` guard is load-bearing: every workspace document that exists today has no `dayMarks` field,
and a bare `request.resource.data.dayMarks is list` evaluates false on those — which would break
**renaming a workspace and creating a board** for every existing workspace, not just this feature.

Per-entry shape is **not** validated server-side. Rules cannot iterate a list, so this matches how
`boards` is already trusted: `is list`, a size cap, and every client normalizes on read. Worth
stating plainly rather than leaving it to be discovered.

**This requires `firebase deploy --only firestore:rules`.** Until that lands, every write from
§3.3 fails with `permission-denied`, and — per the note in `src/config.js` — that is
indistinguishable from a revoked role. Deploy the rules *first*.

### 3.2 `src/state.js` — normalize, and one new field

- `normalizeDayMarks(list)` next to `normalizeCheckpoints`, built the same way: filter to entries
  whose `date` matches `DATE_RE`, assign missing ids, trim and cap the label, validate the colour,
  coerce `end` up to `date` when it is missing or earlier, sort by `date`, slice to 200.
- `S.dayMarks: []` in the workspace-pointer block, beside `S.registry` and `S.workspaceName` — not
  in `S.state`, per §1.

### 3.3 `src/backend/firestore.js` + `src/backend/backend.js` — transport

- `getRegistry()` returns `{ name, boards, dayMarks }`, normalized on the way out.
- New `putDayMarks(marks)` — `updateDoc(this._ws(), { dayMarks })` wrapped in `withTimeout`, like
  the two writers next to it.
- The `StorageBackend` typedef in `backend.js` gets the new method. The existing "why there is no
  `putRegistry`" note already explains why this is a third separate call rather than a field on a
  combined one; it needs one clause, not a rewrite.

### 3.4 `src/boards.js` — load, save, tear down

- `loadRegistry()` sets `S.dayMarks = reg.dayMarks`.
- New exported `saveDayMarks(marks)`, modelled line for line on `renameWorkspace()`: guard on
  `requireWrite()` (workspace management, so the chart lock has no say), apply locally and
  `render()` immediately, then write; on failure restore the previous array, re-render, and toast
  the `friendlyError`.
- `clearLoadedBoard()` adds `S.dayMarks = []`, next to `S.registry = []` — otherwise one
  workspace's holidays paint over the next one's chart during a switch.
- Panel wiring gets `onSaveDayMarks: (marks) => saveDayMarks(marks)`.
- `onOpen` calls `loadRegistry()` before `renderPanel()`. One document read on a panel open, which
  is rare, and it is what makes a teammate's holidays show up without a reload. See §6.

### 3.5 `src/render/chart.js` — a `renderDayMarks()` layer

**Not a class on `.grid-col`, the way `weekend` works.** In month view there is one column per
month, so a per-column class cannot express a single day at all. An absolutely positioned strip
is identical code in all three view modes:

```js
export function renderDayMarks() {
  chartBody.querySelectorAll(".day-mark").forEach(e => e.remove());
  chartHeader.querySelectorAll(".day-mark").forEach(e => e.remove());
  const dw = dayWidth(), max = chartWidth();
  for (const m of S.dayMarks) {
    const from = parseD(m.date), to = parseD(m.end);
    if (to < S.rangeStart || from > S.rangeEnd) continue;
    const left = Math.max(0, dateToX(from));
    const width = Math.min(max, dateToX(to) + dw) - left;
    …one strip into chartBody, one into chartHeader…
  }
}
```

The clamp is not cosmetic: `#chart-body` has an explicit width, but an absolutely positioned child
extending past it still enlarges `#chart-pane`'s scrollable area — an unclamped mark near the
timeline edge would add phantom scroll and fight the endless-timeline extension in
`interactions.js`.

Called from `render()` in `render/index.js` after `renderGrid`. Order matters both ways:
`renderHeader` does `chartHeader.innerHTML = ""` so the header strips must be built after it, and
the body strips must precede nothing — `renderGrid` only removes `.grid-col, .row-line`, so it
would not wipe them, but keeping the call after both makes that irrelevant.

Two strips per mark:

- **Body** — full height, translucent fill, hairline edges. Hover shows the label.
- **Header** — the height of the date axis, carrying the label as text where it fits. This is what
  `.hdr-cell.weekend` already does for weekends and it is why the feature is legible without
  hovering anything.

`dayMarkTipHtml(m)` goes in `src/ui/taskTip.js` beside `checkpointTipHtml`, keeping HTML-building
out of the renderer as the existing split does.

**Stacking, verified against the current z-indexes:** `.grid-col` and `.row-line` are both at the
default `auto`, `#today-line` is 6, `#dep-svg` is 7, `.bar` is 8, `.milestone` is 9. `.day-mark` at
**z-index 1** therefore sits above the grid and above the group rows' background tint, and below
every bar, arrow, diamond and the today line.

**Pointer events stay on**, so the hover card works. This changes no behaviour: a `pointerdown` on
a strip bubbles to the `chartBody` handler at `src/ui/interactions.js:200`, whose
`e.target.closest(".bar, .milestone")` returns null, so it clears the selection — which is exactly
what a click on empty chart space already does. A strip never blocks a bar drag either: bars are
appended later *and* sit at z-index 8.

Nothing to do in `tasksView.js` — the tasks view has no timeline.

### 3.6 `styles/chart.css` — the stripe

```css
.day-mark {
  position: absolute; top: 0; bottom: 0; z-index: 1;
  background: color-mix(in srgb, var(--mark-color) 22%, transparent);
  border-inline: 1px solid color-mix(in srgb, var(--mark-color) 50%, transparent);
}
```

`color-mix` against `transparent` rather than a fixed backdrop is what makes one stored hex work in
both themes — the stripe tints whatever is behind it instead of replacing it, so the grid lines,
the weekend shading and the group-row tint all still read through. No per-theme token is needed and
none should be added. The header variant is the same colour at a stronger mix, sized to
`var(--header-h)`, with the label centred and clipped.

A holiday landing on a Friday sits on top of the weekend shading, which is correct — both facts are
true and both are visible.

### 3.7 `index.html` + `styles/panel.css` + `src/ui/panel.js` — the editor

A new **Marked days** section in `#ws-panel`, between Boards and People. It belongs there because
the panel is the workspace-scoped surface: a toolbar control would imply the list is per board,
which is the one thing this design is not.

Row shape, reusing the checkpoint-row idiom from the task editor — the repo already has exactly one
convention for "a list of dated rows you can add to", and this is the same interaction:

```
[ 2026-04-02 ] [ → 2026-04-09 ] [ Passover……… ] [🎨] [×]
[ 2026-05-14 ] [ →            ] [ Independence ] [🎨] [×]
＋ Add day
```

- Two `<input type="date">`, a text label, an `<input type="color">`, a remove button.
- A blank end means a single day. `normalizeDayMarks` coerces it, so the UI needs no rule.
- **Commits on `change`** — which fires on blur for text, date and colour inputs — and immediately
  on add/remove. No Save button, matching the app's no-confirm-dialogs temperament. Each commit
  rewrites the whole array; at this size and edit frequency that is the right trade, and a
  half-typed row costs nothing because `normalizeDayMarks` drops entries without a valid date, the
  same way `readCheckpoints()` already does.
- Gated on `canWrite()` like `renderBoards()` is: a viewer sees the dates, labels and swatches as
  static text with no controls.

`panel.js` stays a pure view — it reads `S.dayMarks`, reports the edited array through
`handlers.onSaveDayMarks`, and never touches the backend. Delegated listeners on the section
container, so re-rendering re-attaches nothing.

---

## 4. Tests — `tools/ui-test/cases/daymarks.js`

Modelled on `cases/checkpoints.js`. The harness's `backend.getRegistry` stub
(`tools/ui-test/harness.js:65`) gains a `dayMarks` fixture, and a `putDayMarks` stub pushes to
`calls` like `putBoards` does.

- `normalizeDayMarks`: drops a bad date, keeps a bad colour with a fallback, assigns ids, coerces
  `end` earlier-than-`date` up to `date`, coerces a missing `end`, sorts, caps at 200.
- `renderDayMarks`: one body strip and one header strip per mark; `left`/`width` correct at each of
  the three `dayWidth()` values; a multi-day mark is one strip, not N.
- Clamping: a mark entirely outside the range emits nothing; one straddling the edge is clipped and
  does not grow `chartWidth()`.
- Stacking: a strip's computed `z-index` is below a `.bar`'s.
- Panel: editing a row reports the array through `onSaveDayMarks`; a row with no date does not; a
  viewer gets no controls.
- **The board is untouched** — a mark edit must not set `S.dirty` or call `saveBoard`. This is the
  assertion that catches someone later "simplifying" this onto `S.state`.

The seed table in §8 also gets a shape test — it is plain checked-in data, so
`normalizeDayMarks(HOLIDAYS_IL)` must be a no-op on it (every date valid, every `end >= date`,
already sorted, ids unique). That test fails the moment someone hand-edits the table badly.

## 5. README

A Features bullet, a `dayMarks` line in the workspace-document shape under **Data format**
(README.md:406), the new `workspace:seed-holidays` command in the `tools/admin` section
(README.md:421), and a note under **Known restrictions** for the two limitations in §2 and §6.

---

## 6. Known limitations, stated up front

1. **A teammate's edit is not pushed live.** The workspace document has no listener — only the
   board does. You see new marks when you open the workspace, switch into it, or open the panel
   (§3.4). Making it live means a second `onSnapshot`; not worth it for holidays, and easy to add
   later if it ever is.
2. **Last write wins** (§2). Two people editing the list at the same time, one loses.
3. **No undo.** Removing a row is immediate and permanent. Every other destructive action in the
   app offers an Undo toast, so this is a genuine inconsistency — it exists because Undo is built
   on `snapshot()`/`restoreState()` of the *board*, which this data is deliberately not part of. A
   row is cheap to re-add; if that turns out to be wrong, the fix is a local pre-edit copy in the
   panel, not extending board undo to cover workspace data.

---

## 7. Order of work

1. `firestore.rules` + **deploy**. Nothing else works until this lands, and getting it wrong breaks
   workspace rename and board creation for everyone (§3.1).
2. `state.js` normalize + `S.dayMarks`; transport in `firestore.js`/`backend.js`.
3. `boards.js` load / save / teardown.
4. `chart.js` + `chart.css` — render, no editor UI yet.
5. **Seed the holidays (§8)** — `--dry-run` first, then for real. Step 4 now has real data to be
   verified against, which is better than a hand-typed fixture.
6. The panel editor.
7. Tests, then README.

Steps 1–5 are a working read-only feature with the holidays already in it. If the panel editor
turns out to want a different shape once it is on screen, nothing above it has to move.

---

## 8. Seeding every existing workspace with the Israeli Jewish holidays, 2026–2027

### 8.1 Why this is a CLI command and not a migration in the app

A signed-in client can only reach workspaces it is a member of, and only as the role it holds
there. "Every workspace we currently have" is not a thing the app can enumerate — but it is
exactly what `tools/admin` is for: the Admin SDK bypasses `firestore.rules` via IAM, which is the
same asymmetry that lets it create workspaces at all.

One constraint it does **not** escape: the document it writes must satisfy the §3.1 rules
afterwards, or the next ordinary client edit — which sends the whole `dayMarks` array — gets
rejected. Practically that means the 200 cap, and it means the seed should run *after* the rules
deploy so the two can't disagree.

### 8.2 The dates

Generated from **Hebcal**, then checked in as plain data. Fetched 2026-09-09, Hebcal 6.9.2:

```
https://www.hebcal.com/hebcal?v=1&cfg=json&year=<YYYY>&month=x
  &maj=on&min=off&mod=on&nx=off&ss=off&mf=off&c=off&geo=none&i=on&lg=s
```

**`i=on` is the load-bearing parameter.** It selects the *Israel* schedule. The Diaspora observes a
second day of each festival, so without it Pesach, Shavuot, Rosh Hashana and Sukkot all come out a
day long and Simchat Torah splits off from Shmini Atzeret. Getting this wrong is the single most
likely way for this table to be quietly incorrect.

Checked in at `tools/admin/src/holidays-il.js` rather than fetched at run time: it is reviewable in
a diff, deterministic, works offline, and refreshing it for 2028 is one curl and a paste. The URL
above goes in the file header so that is a five-minute job and not a research task.

**Twenty entries — the days the country actually stops. Chol HaMoed is excluded: those are
working days here.**

| id | 2026 | 2027 | what it covers | legally a day off? |
|---|---|---|---|---|
| `il-<y>-purim` | Mar 3 | Mar 23 | Purim | no — but schools closed, most offices quiet |
| `il-<y>-pesach` | Apr 1 → Apr 2 | Apr 21 → Apr 22 | Erev Pesach + Pesach I | chag yes; erev a half day |
| `il-<y>-pesach-vii` | Apr 8 | Apr 28 | Pesach VII (last day) | yes |
| `il-<y>-yom-hazikaron-haatzmaut` | Apr 21 → Apr 22 | May 11 → May 12 | Yom HaZikaron → Yom HaAtzma'ut | Atzma'ut yes; Zikaron a half day |
| `il-<y>-shavuot` | May 21 → May 22 | Jun 10 → Jun 11 | Erev Shavuot + Shavuot | chag yes; erev a half day |
| `il-<y>-tisha-bav` | Jul 23 | Aug 12 | Tish'a B'Av | no — a fast day, commonly short hours |
| `il-<y>-rosh-hashana` | Sep 11 → Sep 13 | Oct 1 → Oct 3 | Erev + both days | both days yes; erev a half day |
| `il-<y>-yom-kippur` | Sep 20 → Sep 21 | Oct 10 → Oct 11 | Erev Yom Kippur + Yom Kippur | yes — the country stops completely |
| `il-<y>-sukkot` | Sep 25 → Sep 26 | Oct 15 → Oct 16 | Erev Sukkot + Sukkot I | chag yes; erev a half day |
| `il-<y>-shmini-atzeret` | Oct 3 | Oct 23 | Shmini Atzeret / Simchat Torah | yes |

Pesach and Sukkot are therefore **two entries each, not one span**: the chag at each end, with the
intermediate days left unmarked. On the chart that reads as a stripe, a clear working week, then
another stripe — which is the accurate picture.

Note what this does *not* drop. Hoshana Raba (Sukkot VII — Oct 2 2026, Oct 22 2027) is chol
hamoed and is out, even though it directly abuts Shmini Atzeret. Erev days stay in across the
board: they are legally shortened workdays in Israel, not intermediate days.

All twenty at **one colour**, as asked. Default `#a78bda` — from the palette in `config.js`, and
deliberately not amber: at the 22% mix of §3.6 a warm tone sits very close to the existing weekend
shading (`--weekend` is `#f6ecdb` light, `#1c2430` dark), and a holiday needs to be tellable from a
Friday at a glance. Overridable with `--color`.

**One judgement call left, flagged so it is easy to overrule:**

- **Yom HaZikaron and Yom HaAtzma'ut are included**, on the reading that "Jewish only" excludes
   the Muslim, Christian and Druze holidays Israel also recognises — not that it excludes the
   Jewish-Israeli national days. They are also the ones most likely to wreck a sprint. Say the word
   and they come out.

Chanukah is deliberately **absent**: eight ordinary working days. Schools are off, which some teams
will want marked — it is two more rows if so, and note that 2027's Chanukah runs into 2028.

The dates were sanity-checked against the Hebrew calendar's own day-of-week restrictions, which is
a real check and not a formality: Rosh Hashana lands Saturday both years, Yom Kippur Monday, Pesach
I Thursday, Yom HaAtzma'ut Wednesday. All four are legal landings, and Yom HaAtzma'ut on a
Wednesday in both years is Israel's Shabbat-adjacency postponement rule working correctly.

### 8.3 The command

```
workspace:seed-holidays [<wsId>] [--color "#a78bda"] [--replace] [--dry-run]
    Add the Israeli Jewish holidays for 2026-2027 to a workspace's marked days.
    With no wsId, every workspace. Safe to re-run: entries are matched by id,
    so existing ones are left exactly as they are — including any you have
    since recoloured or renamed in the app. --replace overwrites those.
```

- `workspaceSeedHolidays({ wsId, color, replace, dryRun })` in `src/commands.js`, and a `case` in
  `bin/gantt-admin.js` following the `workspace:rename` shape.
- No `wsId` → fan out over `workspaceList()`, which already exists.
- **Idempotent by construction.** Seeded ids are deterministic (`il-2026-pesach`), not `uid("d")`,
  so a re-run is an upsert keyed on id: entries already present are skipped, hand-added marks are
  never touched, and there is no fuzzy matching on labels or dates to get wrong.
- That also means a seeded row someone later edits in the panel — recoloured, relabelled — survives
  every re-run. `--replace` is the deliberate way to stomp it.
- Reads `dayMarks`, merges, writes back with `normalizeDayMarks`'s rules applied (sorted, capped),
  in a single `update` per workspace.
- `--dry-run` prints the per-workspace add/skip counts and writes nothing. Run it first — this
  touches every workspace in the project at once, and it is the only step here that does.

### 8.4 What could go wrong

- **Seeding before the §3.1 rules deploy** leaves documents carrying a field the deployed rules do
  not permit; the next client-side workspace rename or board create fails with `permission-denied`
  for everyone in that workspace. Ordering in §7 avoids this — it is listed because the seed is
  tempting to run early.
- **The 200 cap** is not a concern at 20 entries, but the command should still refuse rather than
  truncate if a workspace is somehow near it.
- **No undo** (§6.3). `--replace` across every workspace would discard hand-edited seed rows with
  nothing to restore from. Hence `--dry-run`, and hence merge being the default.
