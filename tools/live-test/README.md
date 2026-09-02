# Live backend + rules test

36 assertions run from a real browser against the **real Firebase project**, with
a real Google sign-in. It exercises the Firestore adapter (`src/backend/firestore.js`)
and, more importantly, `firestore.rules` — including the negative cases that are
the whole point of the migration.

## Why this exists and not emulator tests

`firestore.rules` is the entire security model now: read-only vs edit is enforced
there, not by hidden buttons. So it needs tests.

The catch is that the rules pin `sign_in_provider == 'google.com'`, which blocks
every shortcut for getting a test token:

- An Admin-SDK **custom token** signs in with `sign_in_provider == 'custom'` and
  is correctly denied.
- The **email/password** REST API is unusable — that provider is deliberately
  disabled in the project (an enabled one would let someone sign up *as* an
  invited address and collect the invite).

That leaves two options: the **Auth emulator**, which can mint tokens with an
arbitrary provider claim but needs a JRE installed; or a **real browser sign-in**,
which is this. Emulator-based tests are the better long-term answer because they
are repeatable and need no human — see the note at the bottom.

## Running it

The page must be served from an **authorized domain**. `localhost` is authorized
by default, so serve the repo root:

    ./serve.command            # or: python3 -m http.server 8753
    open "http://localhost:8753/tools/live-test/?ws=<workspaceId>"

Then click **Sign in with Google & run tests** and sign in as an **admin** of
that workspace.

### Use a throwaway workspace

Several tests are destructive (they overwrite the board, create a second board,
and rename the workspace). Boards **cannot be deleted** by any client — the rules
forbid it — so running this against a real workspace leaves permanent junk in it.

Provision and dispose of a scratch workspace around each run:

    node tools/admin/bin/gantt-admin.js workspace:create \
        --name "Adapter Test" --admin you@example.com --id adapter-test

    # ... run the page with ?ws=adapter-test ...

    node tools/admin/bin/gantt-admin.js workspace:delete adapter-test --yes

`workspace:delete` uses `recursiveDelete`, which is the only thing that can
remove board documents.

## What it covers

**Positive paths** — membership discovery via the `members.email` collection-group
query; `getRegistry`; a full board save/load round trip including that `null`
fields survive (Firestore rejects `undefined`, so the JSON-string payload matters);
board create, rename and index update; admin-only workspace rename; a member
listing the roster (what the People panel needs).

**Negative paths, as an admin** — cannot create a workspace (provisioning is
CLI-only), cannot delete a board, cannot change your own role, cannot set
`protected`, cannot forge `invitedBy`, cannot write a future `updatedAt` (clock
poisoning), cannot enumerate workspaces, cannot query another person's
memberships, cannot mint a member doc with a wrong key set.

**Cross-workspace isolation** — being a member of one workspace grants nothing in
another: no workspace read, no member read, no roster list, no board read.

## Two bugs this has already caught

1. **`renameBoard` was denied.** The rules require
   `updatedAtServer == request.time` on *every* board update, so a partial write
   that left the old timestamp in place was rejected. Any partial board update
   hits this; every board mutation must re-stamp.
2. **A silent stop.** The runner originally had no `try/catch`, so a throw
   mid-suite ended it quietly after 15 of 36 assertions with zero reported
   failures — which looks exactly like success. It now reports throws.

The second is the more instructive one: a test suite that can stop early without
saying so is worse than no suite.

## Still worth doing

Port these to `@firebase/rules-unit-testing` against the emulator, so they run
with no human and no live project. That needs a JRE (`brew install --cask temurin`).
Keep this page regardless — it is the only thing that tests the real project, the
real rules and the real Google sign-in together.
