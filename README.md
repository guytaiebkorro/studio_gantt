# Gantt — a hosted, live-synced Gantt board for teams

A complete Gantt chart built with **plain HTML, CSS, and native ES modules** — no framework, no
build step, no bundler, no npm install for the app itself. It's hosted on **GitHub Pages**, so the
whole team just opens a URL, signs in with Google, and edits. Changes appear on everyone else's
screen in about a second.

Storage and identity are **Firebase** — Firestore for the boards, Firebase Auth for who you are,
and `firestore.rules` for what you're allowed to do. There is no server of our own and no build
artifact: the browser loads the modules as they are, so deploying is `git push`.

> **Live app:** `https://<user>.github.io/<repo>/`
> (replace with your Pages URL)
>
> **Firebase project:** `korro-gantt`

---

## Features

- **Tasks** with name, group, start/end dates, description, owner, and **dependencies**.
- **Subtasks** — nest a task under a parent with `parentId`. One level deep. A parent's dates are
  **derived** from its children and it always shows the parent's colour.
- **Progress** is **derived from the dates and today's date**, not stored and not editable. A bar
  fills as its span elapses and reads 100% once its end date has passed.
- **Owner** — an optional name on any task. Hover a bar or a list row to see it.
- **Milestones** — zero-duration diamond markers for key dates, each on a row of its own.
- **Checkpoints** — dated dots *inside* a task's own bar, for the key dates within its span
  (design freeze, code cutoff) that don't deserve a row. Filled once the date has passed, hollow
  while it's ahead; hover one for its label. **Not** the same thing as a milestone, which is why
  they have their own name — nothing in the code calls these milestones.
- **Groups** — swimlanes with their own colour; tasks inherit it, or set a per-task colour.
- **Drag to move**, **drag bar edges to stretch/shrink**, **drag milestones**. Multi-select with
  Ctrl/Cmd/Shift-click and drag the whole set together.
- **Dependencies** drawn as smooth arrows from a predecessor's end into the dependent task.
- **Reorder** tasks by dragging rows in the left list; **drag a task onto a group header** to move it.
- **Duplicate** a task from its editor.
- **Day / Week / Month** views — switching keeps the date you're looking at centred.
- **Gantt / Tasks** toggle — the chart, or a full-width task list.
- **Filter** by task or group name.
- **Endless timeline** — scroll freely; the date range extends as you go.
- **Israel work week** — weekend shading on **Friday–Saturday**, weeks start Sunday.
- **Fast edits** — instant delete with an **Undo** toast, no confirm dialogs.
- **Dark / light theme.**
- **Live team sync** — a teammate's change lands on your screen without you asking.
- **Named workspaces** — the active one is the app's title, top-left, with the sync dot beside it.
- **Share links that carry no secret** — one URL per board, safe to paste in Slack.

---

## Identity and access

**You sign in with Google. That's the only way in.** `firestore.rules` pins
`sign_in_provider == 'google.com'`, and every other provider is deliberately disabled in the
Firebase console — an enabled email/password provider would let someone sign up *as* an invited
address and collect the invite.

Access is granted per **workspace** by a **member document**:

```
/workspaces/{ws}                        the workspace: its name and board index
/workspaces/{ws}/members/{emailLower}   the ACL — document id IS the lowercased email
/workspaces/{ws}/boards/{boardId}       one whole board each
```

**The member document *is* the invite.** There is no separate invites collection and no "claim"
step. Because it's keyed by email rather than uid, someone can be added months before they first
sign in and simply *has* access the first time they do. Revoking is one deletion. (With two
collections, revoking would mean deleting two documents, and any stale unconsumed invite would let
a revoked person walk straight back in.)

### Roles

| Role | Can |
|---|---|
| **admin** | Everything in the workspace: edit, create boards, rename the workspace, invite *anyone* including other admins, change roles, remove members. |
| **editor** | Edit boards, create and rename boards, invite editors and viewers — **never** admins. |
| **viewer** | Read only. Can still select and inspect tasks, export JSON, and share links. |

The role comes from the server and the **server enforces it**. `S.role` in the client is a mirror
for the UI only; `firestore.rules` is the actual boundary. The toolbar's "View only" chip is a pure
readout — there is no user-toggleable lock any more.

### Inviting someone

**＋ Invite someone** in the Workspace panel writes the member document, then **copies the board
link and opens a pre-composed email draft** in your mail client.

That last part matters: **adding a member sends nothing by itself.** There is no server-side mail
anywhere in this app, so the invite is delivered by you, from your own mailbox. The draft says which
workspace, which role, and — the one thing that actually goes wrong — that they must sign in with
*that exact address*, because access is keyed to it and Gmail dot-aliases make it easy to sign in as
an address nobody invited.

See `docs/plans/2026-09-03-invite-delivery-options.md` for why that beats building a mail pipeline,
and for the one piece still unbuilt (an in-app welcome for someone added weeks ago who never found
out).

### Share links

```
https://…/index.html#ws=<workspaceId>&b=<boardId>
```

**The link carries no secret.** It names a workspace and a board, nothing more. Following it grants
nothing — the recipient still has to sign in and still has to have been invited. Permission travels
with the *person*, so one link works for everybody, and revoking someone doesn't mean re-issuing
links to everyone else. The link is safe in a Slack channel, a ticket, or an email, and it stays in
the address bar because a plain permalink should be bookmarkable.

**There is no view-only link, because there's no longer any need for one.** Give someone the viewer
role and the server enforces it. (The old JSONBin-era link base64-encoded an account-wide Master Key
into the fragment, which is why "view-only" back then was an accident guard rather than a
permission. Links in that format are recognised, scrubbed from history on sight, and refused with
"ask for a new one".)

---

## How sync works

The board is one Firestore document per board — the whole board as a JSON string in a `data` field.
Conflict resolution, autosave batching and live updates all sit **above** the storage adapter in
`src/sync.js`, so they apply to any backend.

### Live updates

An **`onSnapshot` listener** on the open board. Firestore bills one read per document actually
delivered, so this is both live and cheaper than the 5s polling it replaced — that poll billed a
read per tick whether or not anything had changed, which is why it shipped switched off and nobody
ever saw a teammate's edit without pressing 🔄.

Remote changes **queue rather than drop**. A listener has no "next tick" to catch what it skipped,
so a snapshot arriving while you're mid-drag or have the editor open is held and applied the moment
it's safe — swapping the board out from under a bar you're holding would yank it off the cursor. The
newest pending version supersedes any earlier one, and a burst of teammate saves collapses into one
re-render.

### Saving

Edits autosave. Saves are **batched**: **2s after your last edit**, and at least every **8s** during
rapid-fire editing. ⌘/Ctrl+S forces one. It also flushes when you switch tabs or minimise, and warns
if you try to close with unsaved changes.

Every edit in the app is a *completed gesture* — a drag that has ended, a dialog being saved, a list
reorder — never a keystroke, so the debounce mostly batches nothing and 2s is the real propagation
latency to your teammates. It costs *you* nothing at any value: your own view re-rendered before the
save. See the long note in `src/config.js` before changing it, and note the floor: every editor
writes the *same* board document, and Firestore's sustained limit is about 1 write/sec/document.

### Conflicts

The read, the merge and the write are **one Firestore transaction**. If the document moved
underneath us, the transaction re-runs and merges again against the winner's result. `firestore.rules`
additionally requires `rev == resource.data.rev + 1`, which catches a writer the transaction can't
see — a stale tab on an older build.

The merge itself is a **3-way merge by task/group id** (`src/merge.js`), against the last server
version your board descends from. So two people editing **different** tasks — or even different
*fields* of the same task, one moving dates while another sets an owner — **both keep their
changes**. Only edits to the same field of the same task within one save window fall back to
last-write-wins.

This replaced a read-then-merge-then-write sequence that was a TOCTOU: two clients could both read
version N, both merge, and both write, and the second silently discarded the first's merge with
nothing surfaced to either person.

### Offline

A transaction needs a server round trip, so a save **fails** when you're offline rather than
queueing. That's deliberate. A queued plain write commits minutes later carrying a merge computed
against a version long since superseded, wiping out everything that landed in between — and having
already reported "Save failed", nobody is watching for it.

Instead: your edits stay, the board stays dirty, the dot goes slate, and the save retries the moment
the listener sees the server answer again (with the `online` event as a belt).

### The sync dot

Beside the workspace name, top-left.

| Colour | State | Means |
|---|---|---|
| Grey | `idle` | No workspace open. |
| **Orange** | `pending` / `syncing` | You have unsaved edits queued, **or** a read/write is in flight. The two share a colour — hover the button for the exact word. |
| **Green** | `ok` | Your board matches the server. With a listener attached, this now genuinely means current, not just "the last thing I did worked". |
| Red | `err` | A load or save failed, or the live listener stopped. |
| Slate | `offline` | A write failed on a network error. Nothing is lost; it will send itself. |

Note it tracks **your** writes. A teammate's change arriving while you're clean sets green — so
incoming updates are not currently visible as a distinct state.

### 🔄 Refresh

Still there, and still a real one-shot read. It's the "did I really get everything" affordance, and
the fallback if the live listener has stopped. Refresh-on-activate (tab focus) also stays, for a
reason independent of sync: it re-renders for the current wall clock, since a day may have passed
while the tab sat in the background and that moves the today marker and every derived progress bar.

---

## Workspaces and boards

The workspace name **is** the app's title, top-left. Click it for the **Workspace panel**:

- **Your account** — name, email, avatar.
- **Workspaces** — every one you're a member of; one click switches. Pending edits flush first.
- **People** — the roster, with roles. Admins and editors can invite, change roles and remove people
  (subject to the rules); viewers see the list read-only.
- **＋ Invite someone.**
- **Copy board link** — available to everyone, viewers included, because the link confers nothing.
- **Sign out.**

**Workspaces are provisioned by the admin CLI only** — `firestore.rules` denies `create` on
`/workspaces` to every client. There's no "add workspace" button and no key to paste, because access
was never granted client-side: losing access means an admin removes you.

**Boards** live inside a workspace, indexed on the workspace document so the board dropdown is one
read instead of downloading every board's task list:

- **Board dropdown** (toolbar) — switch boards.
- **New board** / **Rename board** — in the panel.
- **Export / Import JSON** — Export is a read and available to viewers; Import replaces the whole
  board and is a write like any other.

**Boards can't be deleted from the app.** Deletion is unrecoverable (there's no version history to
restore from) and a shared board would vanish under your teammates with no undo. The rules deny it
outright. Rename one to retire it, or use the CLI's `archived` flag.

Your last workspace and board are remembered per browser and reopened next time.

---

## Known restrictions ⚠️

1. **Same-field conflicts are last-write-wins.** The 3-way merge protects different tasks and
   different fields; two people editing the exact same field of the same task within one save window
   means one value wins. It's "converges correctly", not a real-time CRDT — and for a Gantt board the
   contended unit is a bar's dates, not a text cursor, so a CRDT would buy very little for a document
   format change plus a client library.
2. **One document per board, with a hard ceiling.** The whole board is a single JSON string capped at
   **900 KB** — roughly 2,000–3,000 tasks. Past that, saves are refused locally with a message telling
   you to split the board. Every save also rewrites and re-downloads the whole board, and every editor
   contends on that one document (~1 sustained write/sec). Per-task documents would fix all three;
   see `docs/plans/2026-09-03-live-sync.md` §4 for the trade-off and the trigger for doing it.
3. **The board's shape is not validated server-side.** Because `data` is a string, the rules can only
   check its size. That's the deliberate cost of avoiding Firestore's auto-indexing, which would
   generate ~20 index entries per task and hit the hard 40,000-entries-per-document cap — at which
   point writes are **rejected**, long before the 1 MiB document limit. The writer is already an
   authenticated editor, so shape validation would only protect us from our own client.
4. **No presence or attribution.** You can't see who's editing what, or who last moved a bar (the
   board records `updatedBy`, but nothing surfaces it per task).
5. **Invites are delivered by you.** Adding a member grants access silently; the app can only compose
   a draft in your mail client. Someone added and never told will not know.
6. **Local preferences don't follow you.** Collapsed groups, theme, and the Gantt/Tasks choice live in
   that browser's `localStorage`. Your *access* follows you everywhere, because it's on the server.

---

## Project structure

```
index.html              markup only — plus the import map that pins the Firebase SDK version
firestore.rules         THE security model — roles, invites, board validation
firestore.indexes.json  index exemptions + the mandatory members.email collection-group index
firebase.json           rules/indexes paths and emulator ports
styles/                 CSS by area (tokens, base, toolbar, list, chart, modals, panel, gate, invite)
src/
  main.js               bootstrap / window-level wiring
  config.js             app constants (geometry, colours, autosave timing)
  state.js              the shared store `S`, plus normalize() and the hierarchy invariants
  dates.js              date math, chart geometry, derived progress
  merge.js              the 3-way merge (pure, backend-agnostic)
  sync.js               autosave, the live listener, the merge policy, refresh, the sync dot
  errors.js             Firestore error codes -> messages a person can act on
  theme.js              dark / light
  auth.js               sign-in / sign-out / the auth-ready promise
  session.js            sign-in -> workspace discovery -> what to open. Owns the loading veil.
  memberships.js        who belongs where; invite / roles / leave; the device-local "last seen" hint
  permissions.js        the single permission gate (canEdit / requireWrite / applyRole)
  boards.js             the active workspace, board switching and CRUD, the panel's callbacks
  share.js              share links, clipboard, the invite mailto draft
  persistence.js        ⌘S, JSON export / import
  icons.js, dom.js      shared helpers
  firebase/
    config.js           the public Firebase project config (see the note in it)
    app.js              the ONLY module that imports the Firebase SDK
  backend/
    backend.js          ← the storage backend swap point + the StorageBackend typedef
    firestore.js        the Firestore adapter (the only file that knows Firestore paths)
  render/               render orchestration + list + chart + the full-width tasks view
  ui/                   interactions, editors, toolbar, panel, gate, hover card
                        (tooltip.js shows one; taskTip.js decides what it says)
tools/
  admin/                the provisioning CLI (Node + firebase-admin) — see below
  ui-test/              headless-Chrome suite, backend stubbed. `node tools/ui-test/run.mjs`
  live-test/            real project + real rules, real Google sign-in. See its README.
docs/plans/             design docs and decision records
```

## Swapping the backend

The app talks to storage only through a small **`StorageBackend`** interface — `loadBoard`,
`saveBoard`, `watchBoard`, `createBoardData`, `renameBoard`, `deleteBoardData`, `getRegistry`,
`putBoards`, `putWorkspaceName`. Firestore is one implementation, living entirely in
`src/backend/firestore.js`. To use another, write a class with those methods and change the one line
in `src/backend/backend.js`.

Autosave batching, the queue that keeps remote changes off your cursor, and *what the merge rule is*
all live above the backend in `src/sync.js`. One qualification: `saveBoard` takes a `reconcile`
callback and calls it **inside** the write, because a read-merge-write done outside a transaction
loses one of two concurrent editors. The policy still lives above; only its execution moved down. A
backend without transactions can ignore the callback and merge before writing, at the cost of that
race.

`putBoards` and `putWorkspaceName` are deliberately separate rather than one `putRegistry`: the rules
let an **editor** change the board index but only an **admin** rename the workspace, so a combined
call would have every editor's board-create rejected.

## Configuration

Behaviour constants live in **`src/config.js`**:

| Constant | Default | Meaning |
|---|---|---|
| `SAVE_IDLE_MS` | `2000` | Save this long after your last edit. |
| `SAVE_MAX_MS` | `8000` | Force a save at least this often during rapid-fire editing. Must stay above `SAVE_IDLE_MS`. |
| `SAVE_RETRY_MAX` | `3` | Retries before believing a `permission-denied` save. A lost `rev` race and a revoked role are the same error code. |
| `DEFAULT_WORKSPACE_NAME` | `"Workspace"` | Shown for a workspace whose record has no name yet. |

Firebase project values are in **`src/firebase/config.js`**. **They are public by design** — the web
`apiKey` identifies the project, it is not a credential, and it ships in the source of every Firebase
page. All access control is in `firestore.rules`. Two things worth doing anyway: restrict the key by
HTTP referrer in the Cloud console, and keep every sign-in provider except Google disabled.

The **SDK version is pinned in exactly one place** — the `<script type="importmap">` block in
`index.html`. It has to be one place: the gstatic auth and firestore bundles import
`firebase-app.js` by absolute, version-pinned URL, so a mismatched map entry loads it twice as two
module instances and `getAuth()` fails with "No Firebase App '[DEFAULT]' has been created". Never pin
`latest` — there's no lockfile, so the import map is the only thing between this app and a breaking
CDN change.

Nothing secret is stored on the device. What is:

| `localStorage` key | Holds |
|---|---|
| `gantt_last_v1` | `{ wsId, boards: {wsId: boardId}, names: {} }` — the last workspace/board and a cached name so the switcher paints before the network answers. Safe to lose. |
| `gantt_collapsed_v1` | Collapsed groups, per board. |
| `gantt_theme_v1`, `gantt_viewtab_v1` | Theme, and the Gantt/Tasks choice. |

`gantt_workspaces_v1` and `gantt_jsonbin_v1` are **deleted on first run**. Both stored JSONBin Master
Keys in plaintext — account-wide credentials that couldn't be scoped or revoked per person. They're
scrubbed rather than migrated, because leaving them in people's browsers is the exact problem the
Firebase migration removed.

---

## Data format

The board document at `/workspaces/{ws}/boards/{boardId}`:

```
{
  name:             "Main",
  data:             "<the board, JSON.stringify'd>",
  updatedAt:        1757000000000,   // CLIENT ms — sync.js compares it; rules bound it to +5min
  updatedAtServer:  <serverTimestamp>, // rules pin this to request.time
  updatedBy:        "<uid>",
  rev:              7,               // optimistic concurrency; rules require +1 per update
  createdAt:        <serverTimestamp>,
  createdBy:        "<uid>",
  archived:         false
}
```

`data` is a **string, not a nested map** — see restriction 3 above, and the header of
`src/backend/firestore.js`. It parses to:

```json
{
  "version": 1,
  "settings": { "viewMode": "week" },
  "groups": [ { "id": "g1", "name": "Planning", "color": "#5c9ded" } ],
  "tasks":  [ {
    "id": "t1", "name": "Kickoff", "groupId": "g1",
    "start": "2026-06-15", "end": "2026-06-18",
    "isMilestone": false, "deps": [], "color": null,
    "description": "", "owner": "Dana", "parentId": null,
    "checkpoints": [ { "id": "c1", "date": "2026-06-17", "label": "Design freeze" } ]
  } ]
}
```

`normalize()` in `src/state.js` fills in every optional field on load, so boards written before a
feature existed just work. It also **deletes `progress`** if present — a legacy field; progress is
derived from the dates now (`progressOf` in `src/dates.js`). Dates are `YYYY-MM-DD`, which compares
chronologically as a string, and the code relies on that. `checkpoints` is kept sorted by date.

`normalize()` additionally *repairs* the hierarchy: a `parentId` must name a different existing task,
nesting is flattened to one level (a merge can produce a depth-2 chain or even a cycle that neither
client created), a subtask is moved into its parent's group, and a task with children is never a
milestone. Parent dates are then rolled up from the children.

The workspace document:

```
{ name: "Studio", boards: [ { id: "<boardId>", name: "Main" } ], ownerEmail: "…", createdAt: … }
```

A member document — the exact key set the rules require, nulls explicit rather than omitted:

```
{ email, role, uid, displayName, invitedBy, invitedAt, claimedAt, protected }
```

`invitedBy` and `invitedAt` are pinned by the rules to the caller and `request.time`, so they can't
be forged. `uid` / `displayName` / `claimedAt` are written by the client about *itself* and are
purely diagnostic — `role` is excluded from that update, so it isn't an escalation path.

---

## Provisioning: `tools/admin`

A Node CLI (≥ 20) using `firebase-admin`, which **bypasses `firestore.rules` entirely** — it is the
trusted writer, and every guard protecting the data on that path is one the CLI writes itself
(`tools/admin/src/validate.js`).

Credentials come from **Application Default Credentials**, deliberately rather than a downloaded
service-account key — a key file is a permanent, unexpirable, full-database credential sitting on
disk in a git repo, while ADC is short-lived, tied to your own Google identity and IAM role, and
centrally revocable:

```
gcloud auth application-default login
gcloud auth application-default set-quota-project korro-gantt
```

(`GOOGLE_APPLICATION_CREDENTIALS` still works as a fallback; `doctor` reports which path is in use.)
The project id comes from `$GANTT_PROJECT`, falling back to `.firebaserc`.

```
cd tools/admin && npm install

node bin/gantt-admin.js workspace:create --name "Studio" --admin someone@example.com [--id studio]
node bin/gantt-admin.js workspace:list [--json]
node bin/gantt-admin.js workspace:rename <wsId> --name "New name"
node bin/gantt-admin.js workspace:delete <wsId> --yes        # recursive: members + boards too

node bin/gantt-admin.js member:list <wsId> [--json]
node bin/gantt-admin.js member:add <wsId> --email a@b.com --role admin|editor|viewer [--protected]
node bin/gantt-admin.js member:set-role <wsId> --email a@b.com --role …
node bin/gantt-admin.js member:remove <wsId> --email a@b.com

node bin/gantt-admin.js board:list <wsId> [--json]
node bin/gantt-admin.js board:export <wsId> <boardId> [--out board.json]
node bin/gantt-admin.js board:import <wsId> --file board.json [--name "Name"]

node bin/gantt-admin.js import:jsonbin <wsId> --key-env JB_KEY [--registry <binId>] \
                                             [--dry-run] [--keep-starter]
node bin/gantt-admin.js doctor
```

**`doctor` first when anything looks wrong.** It checks credentials, Firestore access, the
`members.email` collection-group index, and per-workspace integrity — that a workspace still has an
admin, that its protected founding member is intact, and that the denormalised board index hasn't
drifted from the actual board documents.

`workspace:create` makes a starter board and a **protected** founding admin. `workspace:delete` uses
`recursiveDelete` and is the only thing that can remove board documents. `board:import` takes exactly
the JSON shape the app's **Export** produces. `import:jsonbin` is the one-time migration off the old
backend — it reuses each bin id as the Firestore document id, so re-running overwrites rather than
duplicates.

---

## Deploying

**The app** is static files. Commit `index.html`, `styles/` and `src/`, and enable GitHub Pages
(Settings → Pages → deploy from branch). Any push updates the live app; there's no build step.

**Rules and indexes** deploy separately, and **order matters**:

```
firebase deploy --only firestore:indexes    # FIRST
firebase deploy --only firestore:rules
```

Two traps, both documented in `firestore.indexes.json`:

1. The **Firestore emulator does not enforce index requirements**, so the `members.email`
   collection-group query works locally and fails in production with `FAILED_PRECONDITION` — which
   surfaces to a real user as "you have no workspaces", i.e. looking exactly like they were never
   invited.
2. `firebase deploy --only firestore:indexes` **deletes** indexes and field overrides absent from
   that file. Anything created by clicking a console error link must be written back into it or it
   vanishes on the next deploy.

`gantt-admin doctor` re-checks both.

---

## Running locally

Serve the folder over `http://localhost` — **required**, because browsers block ES modules on
`file://` pages, and `localhost` is an authorised Firebase Auth domain by default:

```
python3 -m http.server 8753   # then open http://localhost:8753/index.html
```

(`serve.command` does this on macOS with a double-click.)

This talks to the **real Firebase project**. To use the local emulators instead, add `?emulator=1`:

```
firebase emulators:start                      # needs a JRE
open "http://localhost:8753/index.html?emulator=1"
```

## Tests

```
node tools/ui-test/run.mjs
```

Builds a copy of `index.html` with `src/main.js` swapped for the suite, runs headless Chrome, and
collects assertions over HTTP. The Firestore adapter is **stubbed**, so it needs no auth, no network
and no live project. Exits non-zero on any failure. Cases live in `tools/ui-test/cases/`, one file
per workstream so two people never edit the same test file.

`tools/live-test/` is the other half: a real browser, a real Google sign-in, and the **real rules** —
including the negative cases that are the whole point of the security model, which a stub can't
check. It needs a throwaway workspace, because several of its tests are destructive and boards can't
be deleted by any client:

```
node tools/admin/bin/gantt-admin.js workspace:create --name "Adapter Test" \
     --admin you@example.com --id adapter-test
open "http://localhost:8753/tools/live-test/?ws=adapter-test"
# ... run it, then:
node tools/admin/bin/gantt-admin.js workspace:delete adapter-test --yes
```

`tools/ui-test/shot.mjs` takes screenshots for visual review — appearance is not assertable in the
suite, so this is what covers it. Surfaces: `gate`, `gateEmpty`, `invite`, `board`, `boardHover`,
`boardTasks`, `editor`.

```
node tools/ui-test/shot.mjs board boardHover boardTasks editor
```
