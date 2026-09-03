# Invite Dialog & Login Screen Redesign — Implementation Plan

> **For Claude:** this plan is written to be split across **two parallel agents** after a
> sequential foundation phase. Read *Notes for the implementer* and *Your file lease*
> before touching anything. Do not edit a file you do not own.

**Goal:** three fixes, in one release.

1. **The invite dialog is not modal.** It renders *behind* the workspace panel, and clicking
   outside it dismisses the panel out from under it. It must sit on top, and hold the panel
   open until it is dismissed by sending or cancelling.
2. **The invite email field is ugly.** It is the app's generic `.modal input[type=email]`
   with a placeholder and nothing else. It should be the hero of that dialog.
3. **The login screen is a 420px card.** It should be a full-screen, modern sign-in with a
   big **Korro Gantt** wordmark, a single *Continue with Google* button, and hero art.

**Architecture:** no new JS modules and no framework. Two CSS files are carved out of the
existing ones so the parallel agents have disjoint leases: `styles/invite.css` (from
`styles/panel.css`) and `styles/gate.css` (from `styles/modals.css`). `src/ui/panel.js` and
`src/ui/gate.js` keep their existing shapes and public contracts.

**Tech stack:** vanilla ES modules, no build step, no dependencies. Tests are the existing
stubbed-backend headless-Chrome harness (`node tools/ui-test/run.mjs`).

**Baseline before any work:** `node tools/ui-test/run.mjs` → **154 passes, 0 failures.**
Any task that ends with fewer than 154 passes has broken something.

---

## Design decisions — approved, do not re-litigate

These were chosen by the user before this plan was written.

| Decision | Choice |
|---|---|
| Login layout | **Living Gantt hero** — split layout, brand + button left, animated abstract Gantt right |
| Brand name reach | **Login screen only.** `<title>Gantt</title>` stays. The toolbar's `Gantt` fallback stays. Do **not** sweep the name anywhere else |
| Invite field scope | **One beautiful field.** No ghost domain autocomplete. No multi-address chips. `onInvite(email, role)` keeps its signature |
| Invite dismissal | **Send or Cancel only.** No backdrop-click close, no click-outside close |

---

## Notes for the implementer

**Read these first:**

- `docs/plans/2026-09-03-workspace-panel-redesign-design.md` — why the panel looks the way it
  does. The invite dialog inherits that language.
- `styles/tokens.css` — the design system. **Never hardcode a colour.** The app has a light
  and a dark theme and both must look deliberate. The one sanctioned exception is the Google
  button's white surface (brand guidance), and it must be white in *both* themes.
- `src/permissions.js` — `canInvite()`, `canAssignRole()`, `isAdmin()`. Presentation is not a
  boundary; every existing guard stays exactly where it is.

### Five traps specific to this codebase

1. **`uiBusy()` in `src/sync.js:183` matches `.overlay.show`.** Both `#invite-dialog` and
   `#auth-overlay` are `.overlay` on purpose — an open modal should pause polling and
   refresh-on-activate. **Keep the `.overlay` class and the `.show` toggle on both.** If
   `hideGate()` stops removing `.show`, every future sync is silently suppressed forever;
   there is already a comment in `gate.js:61` warning about exactly this.

2. **Import cycles are load-bearing.** `state.js → sync.js → boards.js → state.js` exists.
   `ui/panel.js` and `ui/gate.js` are **pure views**: they receive callbacks through
   `wirePanel()` / `wireGate()` and must never import `boards.js` or `session.js` at module
   scope. Use `await import()` inside a function body if you truly need one.

3. **`gate.js` grabs its elements at module-evaluation time** — `$("auth-overlay")` and
   `overlay.querySelector(".gate")` on lines 21-22. If the markup loses the `.gate` element,
   `modal` is `null` and every gate function silently no-ops. There is a `if (!modal) return;`
   guard, so **this fails quietly, not loudly.** Assert on it in tests.

4. **`.modal input[type=email]` in `styles/modals.css:24` is a general rule that already
   styles `#invite-email`.** A new rule must out-specify it (`.invite-modal .invite-field
   input[type=email]`) or nothing will appear to change. This is the single most likely way
   to waste an hour on task A2.

5. **The existing 154 assertions encode contracts.** Notably: `$("invite-ws").textContent`
   must equal the workspace name; `#invite-roles .wp-seg` must be the role segments and the
   admin one must be *removed* (not disabled) for non-admins; the dialog must keep the
   `overlay` class; `chip.tagName` must stay `SPAN`. Read `tools/ui-test/suite.js:368-430`
   before editing the invite markup.

### Verification after every task

```sh
node tools/ui-test/run.mjs          # must report >= 154 passes, 0 failures
node --check src/ui/panel.js        # (or whichever JS you changed)
node tools/ui-test/shot.mjs         # visual: writes light + dark PNGs (added in Phase 0)
```

---

# Phase 0 — Foundation (sequential, main agent, no parallelism)

**Purpose:** make the shared files safe to leave alone, so A and B never touch the same
lines. Phase 0 must be a **pure refactor**: the app looks and behaves identically at the end
of it, and the suite still reports 154 / 0.

**Files:** `styles/tokens.css`, `styles/modals.css`, `styles/panel.css`, `index.html`,
`tools/ui-test/suite.js`; new: `styles/invite.css`, `styles/gate.css`,
`tools/ui-test/cases/invite.js`, `tools/ui-test/cases/gate.js`, `tools/ui-test/shot.mjs`.

### 0.1 — A real z-layer scale

The bug in issue #1 exists because three files each invented their own z-index.
Current reality:

| Element | File | z-index |
|---|---|---|
| `#loading` | `base.css:24` | 40 |
| `.overlay` (editor, group, **invite**, gate) | `modals.css:5` | **100** |
| `.panel-scrim` | `panel.css:15` | **150** |
| `.ws-panel` | `panel.css:23` | **151** |
| `.toast` | `modals.css:79` | 200 |

Add to `:root` in `styles/tokens.css`, under the geometry block:

```css
  /* z-layer scale. One place, so a new surface can't guess wrong.
     The invite dialog rendering BEHIND the workspace panel was exactly this:
     .overlay claimed 100 while .ws-panel claimed 151. */
  --z-veil:        40;    /* #loading, inside #main */
  --z-panel-scrim: 150;
  --z-panel:       151;
  --z-modal:       300;   /* every .overlay — must beat the panel */
  --z-toast:       400;   /* must beat everything; it reports on them */
```

Then swap the literals for the tokens in `base.css` (`#loading`), `modals.css` (`.overlay`,
`.toast`) and `panel.css` (`.panel-scrim`, `.ws-panel`). Leave `.wp-menu { z-index: 5 }` —
that one is a local stacking context inside the panel, not a page layer.

**This one change fixes the "invite is below the panel" half of issue #1.** Verify by eye
before continuing.

### 0.2 — Carve out `styles/invite.css`

Move `styles/panel.css:232-255` (the `---------- invite dialog ----------` section:
`.invite-modal`, `.invite-modal .body`, `#invite-email`, `.wp-segs`, `.wp-seg`, `.wp-note`)
**verbatim** into a new `styles/invite.css` with a header comment. Confirmed by grep: nothing
outside `#invite-dialog` uses `.wp-segs`, `.wp-seg` or `.wp-note`.

### 0.3 — Carve out `styles/gate.css`

Move `styles/modals.css:115-130` (the `---------- Startup gate (#auth-overlay) ----------`
section) **verbatim** into a new `styles/gate.css`.

**Leave `.ws-badge.role-*` (lines 132-135) in `modals.css`** — despite sitting next to the
gate block, those chips are shared with the People list.

### 0.4 — Link the new stylesheets

In `index.html`, after the `styles/panel.css` link. **Order matters** — both files override
rules in `modals.css`:

```html
<link rel="stylesheet" href="styles/invite.css">
<link rel="stylesheet" href="styles/gate.css">
```

### 0.5 — Relocate `#auth-overlay` in the markup

Today `#invite-dialog` ends at line 282 and `#auth-overlay` starts at line 288 — six lines
apart. Agents A and B both rewrite their block, and two large adjacent hunks are the one
thing likely to collide on merge.

Move the entire `#auth-overlay` block (lines 284-329, comment included) so it sits
**immediately after `</div>` closing `#app`** (line 130) and before the task/milestone editor
overlay. Purely positional; both elements are `position: fixed` with explicit z-index, and
`gate.js` runs from the module script at the end of `<body>`, so the element exists either
way. Afterwards the two agents' hunks are ~130 lines apart.

### 0.6 — Split the test suite so agents own their own cases

`tools/ui-test/suite.js` is one linear script ending in `rep("__DONE__")`. Two agents
appending before that line is a guaranteed conflict.

Create `tools/ui-test/cases/invite.js` and `tools/ui-test/cases/gate.js`, each a stub:

```js
// Invite dialog cases. Owned by the invite agent.
import { ck, note, sleep, $, setup } from "../suite.js";
note("invite cases: none yet");
```

And immediately before `rep("__DONE__")` in `suite.js`:

```js
// Case modules, each owned by one workstream so two agents never edit the same
// file. Imported LAST and awaited: every const above is initialized by now, so
// the cycle back to this module's exports is safe, and __DONE__ cannot be
// reported before their top-level await has finished.
await import("./cases/invite.js");
await import("./cases/gate.js");
```

### 0.7 — A screenshot tool

Neither agent can claim "it looks good" without evidence. Create
`tools/ui-test/shot.mjs`: reuse `run.mjs`'s static server, launch headless Chrome with
`--screenshot=<out>.png --window-size=1440,900 --hide-scrollbars`, and capture:

- `gate-light.png`, `gate-dark.png` — the signed-out gate in both themes
- `invite-light.png`, `invite-dark.png` — the panel open with the invite dialog on top

Serve a variant page that stubs the backend and drives the app into each state (borrow
`stubBackend()` / `setup()` from `suite.js`); force dark by setting
`localStorage.gantt_theme_v1 = "dark"` before load. Write into `.tmp-shots/` and add that to
`.gitignore`. No npm dependencies — the app is dependency-free and this must not change that.

### Phase 0 exit criteria

- `node tools/ui-test/run.mjs` → **154 passes, 0 failures**
- The invite dialog now visibly paints **above** the panel
- `git diff --stat` shows only moved CSS, the z-tokens, three new files and the relocated
  HTML block — **no behaviour change**
- Commit. Both parallel agents branch from this commit.

---

# Phase 1 — Two agents in parallel

Launch both with `isolation: "worktree"`. They share no files. Merge order does not matter.

## Your file lease

| | **Agent A — Invite** | **Agent B — Login** |
|---|---|---|
| Owns | `src/ui/panel.js` | `src/ui/gate.js` |
| | `styles/invite.css` | `styles/gate.css` |
| | `tools/ui-test/cases/invite.js` | `tools/ui-test/cases/gate.js` |
| | the `#invite-dialog` block in `index.html` | the `#auth-overlay` block in `index.html` |
| | one line of `src/boards.js` (task A1) | — |
| **Never touch** | `gate.js`, `gate.css`, `#auth-overlay`, `tokens.css`, `modals.css`, `panel.css`, `suite.js` | `panel.js`, `panel.css`, `invite.css`, `#invite-dialog`, `tokens.css`, `modals.css`, `suite.js` |

If you believe you need a token that does not exist, **do not add it to `tokens.css`** — both
agents would collide there. Define it locally in your own stylesheet under a comment saying
it is a candidate for promotion, and say so in your report.

---

## Agent A — Invite dialog

### Task A1: make it genuinely modal

Phase 0's z-scale already puts the dialog on top. What remains is behaviour: the panel must
not be releasable while the dialog is up.

**`src/ui/panel.js` — `closePanel()`:**

```js
export function closePanel() {
  // The invite dialog is modal over the panel: sending or cancelling are the
  // only ways out. Guarding HERE rather than on the scrim's click handler
  // catches every route at once — scrim, Escape, and any programmatic close.
  if (isInviteOpen()) return;
  ...
}
```

**`src/boards.js:365`** — the one line you own. `onSignOut` calls `closePanel()` directly,
which the guard would now block. Sign-out lives in the panel footer, which task A1 makes
`inert`, so it is unreachable in practice — but make it correct rather than lucky:

```js
  onSignOut: async () => {
    closeInvite();   // sign-out overrides an in-progress invite
    closePanel();
```

Add `closeInvite` to the existing `wirePanel, renderPanel, openPanel, closePanel, …` import
on `src/boards.js:29`.

**`openInvite()` / `closeInvite()` — block the layer behind:**

- `$("ws-panel").inert = true` on open, `false` on close. `inert` removes the whole subtree
  from hit-testing *and* tab order in one attribute (Chrome 102+, Safari 15.5+, Firefox 112+).
- The focus trap below is what covers older browsers, so `inert` is reinforcement, not the
  mechanism.

**Focus management:**

- On open: remember `document.activeElement`, then focus `#invite-email` (already done).
- On close: restore focus to the remembered element — `#wp-invite-open` in practice. Losing
  focus to `<body>` after closing a modal is the classic keyboard-user dead end.
- Trap Tab: on `keydown` in the dialog, collect
  `dlg.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')`,
  and wrap Tab from the last to the first and Shift+Tab from the first to the last.

**Markup (`index.html`, `#invite-dialog` only):**

- `role="dialog" aria-modal="true" aria-labelledby="invite-title"` on `.invite-modal`
- give the `<h3>` `id="invite-title"`
- **`#invite-ws` keeps its id and its plain-text content** — an existing assertion reads
  `$("invite-ws").textContent === "Game Dev"`
- **Do not** wire `wireBackdropClose` (it exists in `dom.js:22` and is used by the two
  editors). Add a comment saying its absence is deliberate — you can lose a typed invite by
  brushing the backdrop, and the requirement is send-or-cancel.

### Task A2: the field

Make `#invite-email` the hero of the dialog rather than a generic form input.

**Structure** — wrap it, don't restyle it in place:

```html
<div class="invite-field" id="invite-field">
  <svg class="invite-field-icon" …><!-- envelope, 18px, currentColor --></svg>
  <input type="email" id="invite-email" autocomplete="off" spellcheck="false"
         placeholder=" " aria-label="Email address"
         aria-describedby="invite-field-msg">
  <label for="invite-email">Email address</label>
  <span class="invite-field-state" aria-hidden="true"><!-- ✓ / ! / spinner --></span>
</div>
<p class="invite-field-msg" id="invite-field-msg"></p>
```

`placeholder=" "` (a single space) is what makes the CSS-only floating label work via
`:placeholder-shown`.

**Styling** (`styles/invite.css`, all tokens, both themes):

- 46px tall, `--radius-md`, `background: var(--input-bg)`, `border: 1px solid var(--border-strong)`
- `font-size: 15px`, `padding: 0 40px 0 40px` — the glyph occupies the left inset, the state
  slot the right
- label floats from centred placeholder position to a small `--muted` caption above the text
  on `:focus-within` or when not `:placeholder-shown`; transition `.14s ease`; guard it with
  `@media (prefers-reduced-motion: reduce)`
- focus: `border-color: var(--accent)`, `box-shadow: var(--glow-accent)`,
  `background: var(--panel)`, and the glyph picks up `--accent`
- invalid: `--danger` border, `--danger-bg` tint, `!` in the state slot, message in
  `--err-text`
- valid: `--ok` border tint and a `✓` in the state slot — a quiet confirmation, not a party
- in-flight: the state slot becomes a 2px spinner and the field goes `pointer-events: none`
- **Specificity:** scope every rule under `.invite-modal .invite-field` so it beats
  `.modal input[type=email]` in `modals.css:24`. See trap #4.

**Behaviour** (`src/ui/panel.js`):

- **Never scold while typing.** Validate on `blur` and on submit only. Any keystroke clears
  an existing error immediately.
- Validation: trim, lowercase, then test `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`. On failure:
  `"That doesn't look like an email address."` Keep the *server*-side message for
  `permission-denied` exactly as it is (`panel.js:423-427`) — it explains a real rule.
- **Roster awareness.** `renderPeople()` already awaits `handlers.loadMembers()`; cache that
  array in a module-level `lastRoster`. On blur, if the address matches a member, show
  `"Already a <role> in this workspace."` as a neutral (not error) message and disable
  `#invite-send` with a `title`. Re-enable on the next edit. This turns a confusing
  server-side rejection into an answer before the click.
- `#invite-status` keeps its id and `c-status` classes (`inviteStatus()` and existing
  assertions depend on both), but restyle it in `invite.css` to sit as a quiet line under the
  footer rather than a coloured block.
- Enter-to-submit stays (`panel.js:78`).

**Also polish, while you are in there:** the `<h3>` reads `Invite to <span id="invite-ws">` —
render the workspace name as a `--chip-bg` pill so the heading has a focal point, and set
the primary button's label to `Send invite` still, but give it the disabled state above.

### Task A3: tests → `tools/ui-test/cases/invite.js`

Write real assertions, not smoke tests. At minimum:

```
stacking      #invite-dialog computes a higher z-index than #ws-panel
modality      scrim click with the dialog open leaves body.panel-open TRUE
modality      Escape with the dialog open closes the dialog and leaves the panel open
modality      Escape again then closes the panel
modality      #ws-panel.inert is true while open, false after close
modality      after a successful send, the panel is closable again
focus         focus lands on #invite-email on open
focus         focus returns to #wp-invite-open on close
focus         Tab from the last focusable wraps to the first
field         a malformed address shows an error and does NOT call onInvite
field         the error clears on the next keystroke
field         a known member's address disables #invite-send with a reason
field         a valid unknown address enables it and calls onInvite trimmed + lowercased
regress       the dialog still carries the .overlay class (uiBusy contract)
```

Reuse `setup()`, `ck()` and `peopleHandlers()`-style wiring from `suite.js` (import from
`../suite.js`). For the `inert` assertion, feature-detect (`"inert" in HTMLElement.prototype`)
and `note()` a skip rather than failing on an old Chrome.

---

## Agent B — Full-screen login

### Task B1: keep the contract before you change the paint

`src/ui/gate.js` is 100 lines and is the *only* consumer of this markup. Read it first. The
redesign must preserve, exactly:

| Contract | Where |
|---|---|
| `#auth-overlay` keeps `class="overlay show"`; `.show` is the only visibility switch | `gate.js:56,61`, `sync.js:183` |
| a `.gate` element inside it, carrying `data-view` and the `.busy` class | `gate.js:22,42,77` |
| four sections `data-when="boot|signin|empty|denied"`, exactly one visible per view | `gate.css` (moved in Phase 0) |
| ids `gate-google`, `gate-signout`, `gate-refresh`, `gate-copy-email`, `gate-who`, `gate-status` | `gate.js:28-35,52,68` |
| every `.gate-email` element gets the address | `gate.js:50` |
| `.gate-foot` is hidden for `boot` and `signin`, shown otherwise | `gate.js:46-47` |
| `#gate-google`'s click handler reaches `signInWithPopup` with **no `await` before it** | `gate.js:29-31` — Safari blocks a popup not opened synchronously from the click |
| the gate is **non-dismissable**: no close button, no backdrop close, Escape ignored | `main.js:36` omits it deliberately |

You may restructure freely inside those. If a restructure is cleaner with a small `gate.js`
change (e.g. `.gate-foot` toggled by a class instead of inline `style.display`), make it —
but change the test alongside and say so in your report.

### Task B2: the Living Gantt hero

**Layout.** Full viewport, CSS grid:

- `≥ 960px`: two columns, `1fr 1.1fr`. Left rail is the brand + action, right is the hero art.
- `700–959px`: single column; art becomes a ~160px band above the wordmark.
- `< 700px`: single column, art hidden, everything vertically centred, generous padding.
- Height: `100dvh` with a `100vh` fallback — iOS Safari's collapsing URL bar makes `vh`
  overflow. Content must never need to scroll to reach the button.

**Left rail, top to bottom:**

1. A small mark — reuse `favicon-32.png` at 28px — beside a `Korro` eyebrow in `--muted`,
   uppercase, `letter-spacing: .14em`, 11px.
2. **`Korro Gantt`** in `var(--font-display)` at `clamp(44px, 6.5vw, 84px)`,
   `line-height: 0.98`, stacked on two lines, `letter-spacing: -0.02em`. This is the single
   biggest thing on the screen and it should feel deliberate, not merely large.
3. One line of subcopy in `--muted` at 16px — *"Plan the quarter. See the whole thing."*
4. The Google button (below).
5. The existing invite-only line, demoted to 12.5px `--muted`:
   *"Access is invite-only — an admin has to add your address before you can open anything."*

**The Google button:**

- White surface in **both** themes (`#fff` with `#3c4043` text — Google brand guidance; this
  is the sanctioned hardcoded-colour exception), 52px tall, `--radius-pill`, the existing
  inline Google `<svg>` at 20px, `font-weight: 700`, `font-size: 15.5px`
- `width: min(100%, 360px)`
- Rest `box-shadow: 0 2px 8px rgba(0,0,0,.12)`; hover `translateY(-1px)` and a deeper shadow;
  `:active` back to `translateY(0)`; `:focus-visible` → `var(--glow-accent)`
- All motion inside `@media (prefers-reduced-motion: no-preference)`

**The hero art** — pure CSS/SVG, no images, `aria-hidden="true"`, `pointer-events: none`:

- 12–14 rounded bars on an implied weekly grid, staggered start offsets and widths, in
  `--accent`, `--accent-2` and `--chip-bg` at varying opacity — the app's own visual grammar
- a dotted vertical `--today-line` with a small cap, exactly as the chart draws it
- two milestone diamonds and one or two faint dependency curves in `--dep`
- entry: each bar `transform: scaleX(0)` → `1` from `transform-origin: left`, staggered via a
  `--i` custom property (`animation-delay: calc(var(--i) * 60ms)`), `cubic-bezier(.32,.72,0,1)`
  to match the panel's easing in `panel.css:31`
- ambient: a very slow (18–24s) vertical drift, 2–3px amplitude, alternating direction
- `@media (prefers-reduced-motion: reduce)` → final state, zero animation
- background: the two `--bg-glow-*` radials from `base.css:13-18`, scaled up, plus a faint
  `--grid` ruling behind the bars

**The other three views.** Same shell — hero and wordmark stay put, only the rail's copy and
actions change. That is what stops the screen flickering between states.

- `boot`: the button slot becomes a shimmer pill of the same size, so `boot → signin` is not
  a layout jump. Replaces the bare `Starting…`.
- `empty` / `denied`: keep the existing copy verbatim — including the deliberate refusal in
  `denied` to claim the workspace exists (`index.html:314-316`; the rules deny reads
  identically for "not a member" and "doesn't exist"). The `.gate-foot` buttons become a
  quiet inline row under the copy, not a modal footer bar.
- `#gate-status` restyled to a line that belongs in the hero, keeping `.c-status`/`.err`/`.ok`.

**Theme.** Check light and dark side by side with `tools/ui-test/shot.mjs`. Dark is
slate-blue with peach accents and needs different glow opacity than light — do not assume one
set of alpha values works for both.

### Task B3: tests → `tools/ui-test/cases/gate.js`

```
views      each of boot|signin|empty|denied shows exactly ONE section
overlay    #auth-overlay keeps .overlay, and showGate/hideGate toggle .show
uiBusy     after hideGate(), document.querySelector(".overlay.show") is null
foot       .gate-foot hidden for boot and signin, visible for empty and denied
busy       setBusy(true) adds .busy and disables all four buttons; false reverses
identity   showGate("empty", {email}) fills EVERY .gate-email and #gate-who
status     gateStatus(msg,"err") sets text + class; gateStatus("") hides it
sealed     Escape does not remove .show from #auth-overlay
sync       #gate-google's click fires onSignIn synchronously (assert the handler
           ran before the next microtask — the Safari popup rule)
```

Import `showGate`, `hideGate`, `gateStatus`, `setBusy`, `wireGate` from
`../../src/ui/gate.js`. Restore the gate to a sane state at the end so later assertions in
`suite.js` are unaffected — note that `cases/gate.js` runs *last*, but do it anyway.

---

# Phase 2 — Merge and review (main agent, sequential)

1. Merge A, then B. Expected conflicts: **none.** Disjoint files; the two `index.html` hunks
   are ~130 lines apart after Phase 0.5.
2. `node tools/ui-test/run.mjs` → expect **154 + A's cases + B's cases**, 0 failures.
3. `node tools/ui-test/shot.mjs` — inspect all four PNGs. Reject anything that reads as a
   recoloured version of what was there before — as the note at the head of `styles/panel.css` puts it,
   a redesign that keeps the same geometry reads as no change at all.
4. Manual pass, both themes:
   - keyboard only, no mouse: sign in → open panel → invite → Tab through → Escape → Tab again
   - 375px wide and 1440px wide
   - `prefers-reduced-motion: reduce` forced on
   - throttled network: the boot shimmer, not a bare "Starting…"
5. `/code-review` on the branch, then one commit per workstream or a squash — the user's call.

---

## Risk register

| Risk | Mitigation |
|---|---|
| `hideGate()` stops removing `.show` → every future sync silently suppressed | Explicit assertion in B3 (`uiBusy` case). The failure mode is invisible in manual testing |
| The new field rules lose to `.modal input[type=email]` | Trap #4; scope under `.invite-modal .invite-field` |
| `.gate` element dropped → `gate.js` no-ops silently behind `if (!modal) return` | Explicit assertion in B3 (`views` case) |
| `inert` unsupported on an older browser | Focus trap is the real mechanism; `inert` reinforces. Feature-detect in the test |
| Hero animation janks on a low-end machine | Animate `transform`/`opacity` only — never width, height or box-shadow |
| Both agents want a new token | Neither may edit `tokens.css`. Define locally, flag for promotion in Phase 2 |
| A worktree merge collides in `index.html` | Phase 0.5 separates the blocks by ~130 lines before either agent starts |
