// ---------------------------------------------------------------------------
// Session orchestration: sign-in, workspace discovery, and choosing what to open.
//
// This is the outer half of what boards.js connect() used to do. Splitting it
// out matters for the import graph: session.js sits ABOVE boards.js and is
// called from main.js bootstrap, never at module-evaluation time — the same
// discipline the old initCloudConfig() needed, and for the same reason (the
// load-bearing state -> sync -> boards cycle means boards.js's body runs before
// state.js has finished initializing S).
//
// It owns the loading veil. Nothing may read auth.currentUser before the first
// onAuthStateChanged has fired, so the veil stays up until `authReady` resolves.
// ---------------------------------------------------------------------------
import { $, toast } from "./dom.js";
import { S } from "./state.js";
import { authReady, currentUser, onUserChange, signIn, signOutNow } from "./auth.js";
import {
  listMyWorkspaces, bindMyIdentity, forgetLegacyKeys,
  lastWorkspace, rememberWorkspace, cachedName
} from "./memberships.js";
import { wireGate, showGate, hideGate, gateStatus, setBusy } from "./ui/gate.js";
import { openWorkspace, leaveWorkspace, lastOpenError } from "./boards.js";
import { consumeShareTarget } from "./share.js";

let shareTarget = null;   // { wsId, boardId } from the URL, honoured once
let veilTimer = null;

function veil(on) {
  const el = $("loading");
  if (!el) return;
  el.classList.toggle("show", !!on);
}

// ---------------------------------------------------------------------------
// Not getting stuck.
//
// The gate greys itself and disables its buttons for the duration of a sign-in
// (setBusy), and doSignIn()'s setBusy(false) only runs once afterSignIn() has
// SETTLED. So any step in here that never settles leaves a greyed-out Google
// button, no message at all — doSignIn() clears the status line just before
// awaiting — and no way back. Reloading re-enters the same hang, so it doesn't
// help either. That is exactly how this presented in the field: "the login
// screen never went down, even after a refresh".
//
// Note also that veil()/armVeilWatchdog() below CANNOT be the safety net for
// this. #loading sits at --z-veil inside #main, and the gate is at --z-modal,
// so while the gate is up the veil and its "Still connecting…" message are
// painted underneath it and can never be read. Everything the user is told
// during a gated phase has to go through gateStatus().
//
// Two guards, because the two phases are not equally abandonable.
const SLOW_MS = 6000;      // say something is happening
const TIMEOUT_MS = 20000;  // give up / hand control back

// Say "still working" if a phase outlasts SLOW_MS. Returns a cancel function.
function nudge(msg, ms) {
  const t = setTimeout(() => gateStatus(msg, ""), ms || SLOW_MS);
  return () => clearTimeout(t);
}

// For a phase that is safe to abandon. A pure read is: nothing downstream has
// been mutated yet, so losing the answer costs only the answer.
//
// Exported for the suite. `code: "timeout"` is load-bearing — afterSignIn()
// branches on it to show the message as-is instead of wrapping it in
// "Couldn't look up your workspaces:" — so it is asserted rather than assumed.
export function withTimeout(promise, message, ms) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(Object.assign(new Error(message), { code: "timeout" })), ms || TIMEOUT_MS);
    })
  ]);
}

// For a phase that is NOT safe to abandon. openWorkspace() mutates S.ws,
// backend.wsId, S.registry and S.gate as it goes, so cancelling it half-done
// would leave the app lying about which workspace is open. This cancels
// nothing: it just stops the gate CLAIMING to be busy, so the buttons come
// back and the person can retry instead of staring at a dead screen. If the
// slow open then succeeds it hides the gate as usual.
//
// On the signin view .gate-foot is hidden, so what actually comes back is the
// Google button — which is the recovery the one affected user found by
// themselves, by clicking it again.
function unstick(msg, ms) {
  const t = setTimeout(() => { setBusy(false); gateStatus(msg, ""); }, ms || TIMEOUT_MS);
  return () => clearTimeout(t);
}

// A proxy blocking gstatic.com or googleapis.com otherwise leaves "Loading…"
// forever with no explanation. Say something after a while.
function armVeilWatchdog() {
  clearTimeout(veilTimer);
  veilTimer = setTimeout(() => {
    const el = $("loading");
    if (el && el.classList.contains("show")) {
      el.innerHTML = "<div style='text-align:center;line-height:1.7'><b>Still connecting…</b><br><br>" +
        "If this doesn't clear, your network may be blocking <code>gstatic.com</code> " +
        "or <code>googleapis.com</code>.</div>";
    }
  }, 9000);
}

export async function startSession() {
  wireGate({ onSignIn: doSignIn, onSignOut: doSignOut, onRefresh: refreshMemberships });

  // Read the URL before anything can navigate. Unlike the old bearer token this
  // is not a secret, so it is deliberately NOT stripped from the address bar —
  // a plain permalink should stay bookmarkable and re-openable.
  shareTarget = consumeShareTarget();

  S.gate = "boot";
  showGate("boot");
  veil(true);
  armVeilWatchdog();

  // The one correct way to learn who is signed in. auth.currentUser is null
  // synchronously at boot even for a valid persisted session.
  const user = await authReady;

  // Also fires on sign-out elsewhere, a revoked token, or a deleted account.
  // That is a teardown trigger, not just a startup signal.
  onUserChange(onAuthChanged);

  if (!user) {
    clearTimeout(veilTimer);
    veil(false);
    S.gate = "signin";
    showGate("signin");
    return;
  }
  await afterSignIn();
}

async function afterSignIn() {
  S.user = currentUser();
  forgetLegacyKeys();   // scrub plaintext JSONBin Master Keys from this browser

  veil(true);
  armVeilWatchdog();
  // The gate is on top of the veil, so this line is the ONLY feedback there is
  // between the popup closing and a board appearing. It used to be blank.
  gateStatus("Checking your access…", "");
  const slow = nudge("Still checking your access — the first connection to the "
    + "database can be slow. Hang on.");
  try {
    // Safe to race: a read that is abandoned has mutated nothing.
    await withTimeout(loadMemberships(),
      "Timed out looking up your workspaces. Check your connection and try again.");
  } catch (err) {
    clearTimeout(veilTimer);
    veil(false);
    // A missing COLLECTION_GROUP index lands here as failed-precondition. Show
    // the real message: presenting it as "you have no workspaces" would tell an
    // invited user they were never invited.
    S.gate = "empty";
    showGate("empty", {
      email: S.user.email,
      error: err.code === "failed-precondition"
        ? "Couldn't look up your workspaces — the server is missing an index. " +
          "Tell an admin to run: firebase deploy --only firestore:indexes"
        // A timeout's message is already the sentence we want to show; don't
        // bury it behind "Couldn't look up your workspaces:".
        : err.code === "timeout"
          ? err.message
          : "Couldn't look up your workspaces: " + (err.message || err.code)
    });
    return;
  } finally {
    slow();
  }

  // A share link wins over whatever was last opened: the recipient asked for
  // THAT workspace.
  const wanted = (shareTarget && shareTarget.wsId) || lastWorkspace() || "";
  const boardId = shareTarget && shareTarget.boardId;
  const hit = wanted && S.memberships.find((m) => m.wsId === wanted);

  clearTimeout(veilTimer);

  if (hit) return open(hit, boardId);

  if (wanted && shareTarget && shareTarget.wsId === wanted) {
    // Asked for a specific workspace and isn't a member. Note the copy in
    // index.html does not claim the workspace exists — the rules deny reads
    // identically for "not a member" and "doesn't exist", so we cannot tell.
    veil(false);
    S.gate = "denied";
    showGate("denied", { email: S.user.email });
    return;
  }

  // No "pick a workspace" step. The panel is the app's only workspace list, so
  // sign-in lands you in your last-used workspace (or the first alphabetically)
  // and you switch from there — rather than being asked before you see anything.
  if (S.memberships.length) return open(S.memberships[0]);

  veil(false);
  S.gate = "empty";
  showGate("empty", { email: S.user.email });
}

async function loadMemberships() {
  S.memberships = await listMyWorkspaces();
}

async function open(m, boardId) {
  shareTarget = null;                       // honoured once; don't re-apply on a later switch
  gateStatus(`Opening “${m.name || m.wsId}”…`, "");
  const slow = nudge(`Still opening “${m.name || m.wsId}” — loading the board.`);
  // NOT a cancellation. See unstick(): openWorkspace() is mutating state as it
  // runs and must be allowed to finish either way.
  const release = unstick("This is taking longer than it should. "
    + "Try again, or reload the page.");
  let ok;
  try {
    ok = await openWorkspace(m.wsId, { name: m.name, role: m.role, boardId });
  } finally {
    slow();
    release();
  }
  clearTimeout(veilTimer);
  veil(false);
  if (ok) {
    // openWorkspace() has already set S.gate = "open" — deliberately not
    // duplicated here, so there is one owner of that transition.
    hideGate();
    rememberWorkspace(m.wsId, S.workspaceName);
    // Best-effort, fire and forget: records uid/displayName on my member doc so
    // an admin can tell who has actually signed in. Grants nothing.
    bindMyIdentity(m.wsId).catch(() => {});
    return true;
  }
  // Failed to open. Don't leave an empty board looking connected — re-gate.
  S.gate = "empty";
  showGate("empty", { email: S.user && S.user.email, error: lastOpenError() });
  return false;
}

// Switch workspaces. Called by the panel, which is now the only place a
// workspace can be chosen.
export async function pickWorkspace(wsId) {
  const m = S.memberships.find((x) => x.wsId === wsId);
  if (!m) { gateStatus("That workspace is no longer available to you", "err"); return; }
  if (wsId === S.ws.id && S.gate === "open") { hideGate(); return; }

  setBusy(true);
  gateStatus("Opening…", "");
  veil(true);
  // Hand back the current workspace first. leaveWorkspace() flushes any pending
  // save BEFORE blanking state — see the ordering note in boards.js.
  if (S.ws.id) await leaveWorkspace();
  const ok = await open(m);
  setBusy(false);
  if (ok) toast(`Opened “${S.workspaceName}”`);
}

// "Check again" — re-query memberships without a reload, which is how a
// just-invited user gets in.
export async function refreshMemberships() {
  if (!currentUser()) { showGate("signin"); return; }
  setBusy(true);
  gateStatus("Checking…", "");
  try {
    await loadMemberships();
    if (!S.memberships.length) {
      gateStatus("Still no workspaces for " + S.user.email, "");
      showGate("empty", { email: S.user.email });
    } else {
      // Just been invited: open it rather than announcing it and making them
      // click again.
      setBusy(false);
      await open(S.memberships[0]);
      return;
    }
  } catch (err) {
    gateStatus("Check failed: " + (err.message || err.code), "err");
  }
  setBusy(false);
}

export async function doSignIn() {
  setBusy(true);
  gateStatus("Opening Google…", "");
  try {
    await signIn();            // auth.js reaches signInWithPopup synchronously
    // afterSignIn() sets its own status immediately, so the line is never
    // blank. It used to be cleared here and left empty for the whole of the
    // membership lookup and the board load — a greyed screen saying nothing.
    await afterSignIn();
  } catch (err) {
    gateStatus(err.message || "Sign-in failed", "err");
  } finally {
    // `finally` rather than a bare line after the try/catch — equivalent today,
    // but it keeps holding if anyone adds an early return above.
    //
    // It is NOT what fixes the hang: a promise that never settles never
    // reaches `finally` either. Releasing a stuck gate is withTimeout()'s and
    // unstick()'s job, inside afterSignIn() and open().
    setBusy(false);
  }
}

export async function doSignOut() {
  setBusy(true);
  try {
    if (S.ws.id) await leaveWorkspace();   // flush before identity disappears
    await signOutNow();                    // onAuthChanged(null) finishes the teardown
  } catch (err) {
    gateStatus("Sign-out failed: " + (err.message || err.code), "err");
  }
  setBusy(false);
}

// Auth state changing under us mid-session.
async function onAuthChanged(user) {
  if (user) { S.user = user; return; }
  // Signed out here or elsewhere, token revoked, account deleted. Reuse the same
  // ordering as an explicit sign-out: flush, then drop everything.
  if (S.ws.id) { try { await leaveWorkspace(); } catch (_) {} }
  S.user = null;
  S.memberships = [];
  S.role = null;
  S.gate = "signin";
  veil(false);
  showGate("signin");
}
