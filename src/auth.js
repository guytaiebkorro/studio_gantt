// ---------------------------------------------------------------------------
// Google sign-in.
//
// Deliberately does NOT import state.js: session.js copies the signed-in user
// into S. That keeps this module a thin, testable wrapper over the SDK and keeps
// it out of the load-bearing state -> sync -> boards import cycle.
//
// Two things here are easy to get wrong and expensive to debug:
//
// 1. `auth.currentUser` is null synchronously at boot, even for a user with a
//    valid persisted session. Nothing may read it before the first
//    onAuthStateChanged callback. `authReady` is the only correct way in.
//
// 2. The observer also fires with null MID-SESSION — sign-out in another tab, a
//    revoked token, a deleted account. That is a teardown trigger, not just a
//    startup signal, so onUserChange() consumers must handle it (flush pending
//    saves BEFORE blanking state, exactly as leaveWorkspace() does).
// ---------------------------------------------------------------------------
import {
  auth, googleProvider, signInWithPopup, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence
} from "./firebase/app.js";

// Survive a tab close. This is the SDK default, but stating it means a future
// SDK default change can't silently log the whole team out on every reload.
setPersistence(auth, browserLocalPersistence).catch((err) => {
  // Non-fatal: sign-in still works, it just won't persist. Private-mode Safari
  // and blocked storage land here.
  console.warn("auth: could not enable persistent sessions —", err && err.code);
});

/** @typedef {{uid: string, email: string, displayName: string, photoURL: string}} AppUser */

let _user = null;
let _first = true;
let _resolveReady;

// Resolves once, on the FIRST observer fire, with the user or null. Await this
// before making any decision that depends on who is signed in.
export const authReady = new Promise((resolve) => { _resolveReady = resolve; });

const listeners = new Set();

/** The signed-in user, or null. Safe only after `authReady` has resolved. */
export function currentUser() { return _user; }

/** Subscribe to sign-in AND sign-out. Returns an unsubscribe function. */
export function onUserChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function shape(u) {
  if (!u) return null;
  return {
    uid: u.uid,
    // Lowercased once, here, so nothing downstream has to remember to. Member
    // documents are keyed by lowercased email and the rules compare against
    // request.auth.token.email.lower() — any casing drift is a silent lockout.
    email: (u.email || "").toLowerCase(),
    displayName: u.displayName || "",
    photoURL: u.photoURL || ""
  };
}

onAuthStateChanged(auth, (u) => {
  _user = shape(u);
  if (_first) { _first = false; _resolveReady(_user); }
  for (const fn of listeners) {
    try { fn(_user); } catch (err) { console.error("auth listener failed:", err); }
  }
});

// Sign in with Google.
//
// MUST be reached SYNCHRONOUSLY from the click handler — no `await` before the
// signInWithPopup call, or Safari's popup blocker kills the window. That is why
// this function does no async work of its own first.
//
// Throws an Error whose message is already human-readable.
export async function signIn() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    throw new Error(authErrorMessage(err));
  }
}

export async function signOutNow() {
  await signOut(auth);
}

// Map Firebase's auth/* codes onto something a user can act on. The popup codes
// matter most: this app is served from GitHub Pages while the auth handler lives
// on korro-gantt.firebaseapp.com, so sign-in completes through a cross-origin
// popup — the thing browsers' third-party-storage restrictions squeeze.
export function authErrorMessage(err) {
  const code = (err && err.code) || "";
  switch (code) {
    case "auth/popup-blocked":
      return "Your browser blocked the sign-in popup. Allow popups for this site and try again.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled.";
    case "auth/unauthorized-domain":
      return "This site isn't an authorized domain for the Firebase project. " +
             "Add it under Authentication → Settings → Authorized domains.";
    case "auth/operation-not-allowed":
      return "Google sign-in isn't enabled for this project yet " +
             "(Authentication → Sign-in method → Google).";
    case "auth/network-request-failed":
      return "Couldn't reach Google. Check your connection — a proxy blocking " +
             "gstatic.com or googleapis.com will also do this.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment and try again.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    default:
      return "Sign-in failed" + (code ? ` (${code})` : "") + ".";
  }
}
