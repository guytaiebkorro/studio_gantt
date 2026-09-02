# Workspace panel redesign — sliding nav

**Date:** 2026-09-03
**Status:** approved

## Problem

The workspace panel is a centre modal carrying five concerns at once — workspace
identity, people, boards, sharing, and session — plus seven blocks of
explanatory prose (five `.hint` paragraphs, an autosave note, and a signed-in-as
line). Nothing is where you'd look for it, and the prose exists to compensate.

Two specific failures:

- **Workspaces are hidden behind a button.** "Switch workspace…" reopens the
  gate's picker, so seeing what you have access to takes two clicks and lands
  you in a different UI than the one you started in.
- **Boards live somewhere else entirely** — a dropdown in the toolbar. You
  switch workspace in one place and board in another, for what is really one
  navigation task.

## Decisions

| Decision | Choice |
|---|---|
| Surface | 360px `<aside>` sliding from the left over a scrim, not a centre modal |
| Scope | Workspaces **and their boards** — the panel is the app's navigation |
| Toolbar | Loses `#board-select` and `#board-new`; the title button opens the panel |
| Workspace list | Always fully visible; no switch button |
| Gate | Slims to sign-in + the two dead-ends. The panel is the app's **only** workspace list |
| Startup | Lands straight in the last-used workspace — no picker step |
| Invite | Centred dialog: email + segmented role control |
| Cut outright | All five hint paragraphs, `Save now`, the autosave note, `Rename board` as a button |

## Anatomy

Four regions, separated by one hairline each. No boxed sub-panels; two quiet
uppercase captions in place of the current per-field `<label>`s.

```
┌───────────────────────────────┐
│ ●  Guy Taieb                  │   Account: avatar, name, email (passive)
│    guy@korro.ai               │
├───────────────────────────────┤
│ WORKSPACES                    │
│ ▾  Game Dev           admin   │   active row: 3px accent left edge, expanded
│      Main                  ●  │   ● = current board
│      Fine Motor New Game      │   hover: ✎ rename · 🔗 copy link
│      Alfies Friends Plan      │
│      1.58.0 Tasks             │
│      ＋ New board             │   editor+ only
│ ▸  Product            admin   │
├───────────────────────────────┤
│ PEOPLE                        │   scoped to the active workspace
│ Guy Taieb        admin   you  │   role chip; a <select> for admins
│ matan@korro.ai   editor       │   hover: × remove
│ ＋ Invite someone             │
├───────────────────────────────┤
│ 🔗 Copy board link   Sign out │
└───────────────────────────────┘
```

Destructive and rare actions (workspace rename for admins, leave for
non-admins) hang off a `…` menu on the active workspace row, not the main flow.

## Where the prose went

Every hint is deleted and replaced by structure:

- **Role meanings** move into the invite dialog's segmented control, which shows
  one short line for the *selected* role only — not three paragraphs upfront.
- **The share disclaimer** disappears because the affordance changed. A link
  icon on a board row reads as "copy a link to this", and after the Firebase
  migration there is no edit-vs-view link distinction left to explain.
- **Workspace name** becomes click-to-edit on the title. Once the name *is* the
  thing you click, a labelled field plus a paragraph about where the name
  appears is redundant.
- **`Save now` and the autosave note** were load-bearing for each other: the
  note only existed to explain why the button was unnecessary. Both go.

## Invite dialog

A real centred dialog above the scrim — inviting someone is a commitment and
deserves focus rather than an inline row.

```
┌──────────────────────────────────┐
│  Invite to Game Dev              │
│  ┌────────────────────────────┐  │
│  │ name@company.com           │  │
│  └────────────────────────────┘  │
│  ┌────────┬────────┬─────────┐   │
│  │ Viewer │ Editor │  Admin  │   │
│  └────────┴────────┴─────────┘   │
│  Can edit boards and invite      │
│  others.                         │
│         Cancel   Send invite     │
└──────────────────────────────────┘
```

The Admin segment is **removed, not disabled**, unless the caller is an admin. A
disabled control invites devtools tampering and produces a confusing
server-side rejection; absence is honest. Enter submits.

## Motion and visual language

- Panel: `translateX(-100%) → 0`, 220ms `cubic-bezier(.32,.72,0,1)`.
- Scrim: opacity over 160ms. Accordion: 160ms.
- Under `prefers-reduced-motion`, all of the above degrade to a plain opacity
  change with no transform.

Structural moves rather than a palette swap, because a reskin that keeps the
same geometry reads as "no change": 44px rows, pill chips, `--radius-lg` on the
panel edge, real elevation via `--shadow`, generous vertical rhythm instead of
bordered boxes, and one accent colour used **only** to mean "current".

## Behaviour change

**Startup no longer asks which workspace.** Because the panel is the only
workspace list, sign-in opens the last-used workspace (or the first
alphabetically) and the gate handles only sign-in and the two dead-ends. You
switch from the panel afterwards. This differs from current behaviour, where
having two workspaces produces a picker modal before you see anything.

## Code shape

| File | Change |
|---|---|
| `src/ui/panel.js` | **New.** Owns the panel; absorbs `src/ui/members.js` |
| `styles/panel.css` | **New.** Keeps `modals.css` from bloating further |
| `index.html` | `#cloud-overlay` → `#ws-panel`; add `#invite-dialog`; remove `#board-select` and `#board-new` |
| `src/boards.js` | Keeps the logic (`openWorkspace`, `switchBoard`, `newBoard`, `renameBoard`); loses its panel wiring |
| `src/ui/gate.js` | Drop the picker and the denied-state workspace list |
| `src/session.js` | Auto-open on sign-in; no picker path |
| `src/memberships.js` | Unchanged — already returns names and roles |

Inline text inputs replace the two `prompt()` calls behind new/rename board.
`prompt()` is currently the least sleek thing in the app.

## Role gating

| | viewer | editor | admin |
|---|---|---|---|
| See workspaces, boards, roster | ✓ | ✓ | ✓ |
| Switch workspace / board | ✓ | ✓ | ✓ |
| New board, rename board | | ✓ | ✓ |
| Invite | | viewer, editor | all roles |
| Change roles, remove members | | | ✓ |
| Rename workspace | | | ✓ |
| Leave workspace | ✓ | ✓ | (CLI only) |

The UI hides what you cannot do, but `firestore.rules` remains the enforcement;
a `permission-denied` is the rules working, and the panel re-renders from the
server rather than trusting its own optimistic state.

## Verification

- Extend the stubbed-backend browser harness: both workspaces render with their
  boards; the accordion switches; a viewer sees no `＋ New board`, no invite and
  no rename; the invite dialog omits Admin for an editor; Escape closes the
  dialog first and the panel second.
- **Screenshots in both themes.** A visual redesign is not done until it has
  been looked at.
