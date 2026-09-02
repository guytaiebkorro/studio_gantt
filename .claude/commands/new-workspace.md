---
description: Provision a new Gantt workspace with an admin (runs the admin CLI)
argument-hint: "<Workspace Name>" <admin-email>
allowed-tools: Bash(node tools/admin/bin/gantt-admin.js:*)
---

Provision a new Gantt workspace.

Arguments given: `$ARGUMENTS`

Parse them as a quoted workspace name followed by the workspace admin's Google
email address. If either is missing or the second argument is not an email
address, ask for the missing piece instead of guessing.

Then run, from the repository root:

```
node tools/admin/bin/gantt-admin.js workspace:create --name "<NAME>" --admin <EMAIL>
```

Report back the workspace id, the admin email, and the starter board id.

Notes to pass on if relevant:

- The admin is created as a **protected** member. Clients can never change or
  remove them, which is what guarantees the workspace can't end up with zero
  admins. Only this CLI can.
- The admin does **not** need to have signed in yet. A member document *is* the
  invite — they get access the moment they sign in with Google.
- If the command fails with a credentials error, the fix is:
  `gcloud auth application-default login` then
  `gcloud auth application-default set-quota-project korro-gantt`
- If it reports a missing collection-group index, run
  `firebase deploy --only firestore:indexes` and then
  `node tools/admin/bin/gantt-admin.js doctor`.
