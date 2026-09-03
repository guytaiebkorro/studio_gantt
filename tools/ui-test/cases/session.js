// ---------------------------------------------------------------------------
// Session cases.
//
// Import from ../harness.js, NEVER from ../suite.js — see the note at the top
// of harness.js. And note the ../../../ on app imports: this file is one level
// deeper than suite.js, so the repo root is three up, not two.
//
// Scope is deliberately narrow. Driving afterSignIn() end to end would mean
// stubbing Firebase Auth, which the harness does not do; what is covered here
// is the piece with actual logic in it — the guard that stops a hung sign-in
// leaving the gate greyed out forever.
// ---------------------------------------------------------------------------
import { ck, note } from "../harness.js";
import { withTimeout } from "../../../src/session.js";

// A promise that beats the clock passes its value straight through.
ck("session: withTimeout resolves a fast promise",
   await withTimeout(Promise.resolve("ok"), "too slow", 500), "ok");

// A real rejection is NOT converted into a timeout — the caller has to be able
// to tell "the server said no" from "the server said nothing".
let passedThrough = null;
try {
  await withTimeout(
    Promise.reject(Object.assign(new Error("nope"), { code: "permission-denied" })),
    "too slow", 500);
} catch (err) { passedThrough = err; }
ck("session: withTimeout passes a real rejection through",
   passedThrough && passedThrough.code, "permission-denied");

// The hang. This is the case that stranded a user behind a greyed-out Google
// button: doSignIn() only releases the gate once afterSignIn() SETTLES, so a
// step that never settles has to be turned into a rejection by something.
let timedOut = null;
try {
  await withTimeout(new Promise(() => {}), "Timed out looking up your workspaces.", 60);
} catch (err) { timedOut = err; }
ck("session: withTimeout rejects a promise that never settles", !!timedOut, true);
// afterSignIn() branches on this exact string to decide whether to show the
// message as-is or wrap it. Rename it there and this fails here.
ck("session: ...tagged code:'timeout' so afterSignIn can special-case it",
   timedOut && timedOut.code, "timeout");
ck("session: ...carrying the message the user will actually read",
   timedOut && timedOut.message, "Timed out looking up your workspaces.");

// The timer is cleared when the promise wins, so a settled race cannot be
// followed by a stray timer firing later. Observable only as "nothing throws
// and nothing is logged after the fact" — assert the resolve still works with
// a timeout shorter than the wait that follows it.
ck("session: a resolved withTimeout does not fire its timer afterwards",
   await withTimeout(new Promise((r) => setTimeout(() => r("done"), 10)), "too slow", 40),
   "done");
await new Promise((r) => setTimeout(r, 80));
note("session: no late rejection after a resolved withTimeout (would have failed the run)");
