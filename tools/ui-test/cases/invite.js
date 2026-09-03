// ---------------------------------------------------------------------------
// Invite dialog cases.
//
// Owned by the invite workstream, so two people working in parallel never edit
// the same test file. Imported (and awaited) from the end of suite.js.
//
// Import from ../harness.js, NEVER from ../suite.js: suite.js is suspended on
// the very `await import()` that loads this file, and a static import of a
// module that is mid-evaluation waits on its evaluation promise. That is a
// deadlock, and it presents as the whole run timing out with no failure to
// point at.
// ---------------------------------------------------------------------------
import { note } from "../harness.js";

note("invite cases: none yet");
