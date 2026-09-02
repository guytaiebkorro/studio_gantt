// ---------------------------------------------------------------------------
// Firestore error codes -> messages a person can act on.
//
// A leaf module on purpose. Both sync.js and boards.js need this, and they
// already form a cycle with state.js; putting it in either of them would mean
// the other imports across that cycle for a pure function.
// ---------------------------------------------------------------------------

export function friendlyError(err) {
  const code = (err && err.code) || "";
  switch (code) {
    case "permission-denied":
      return "You don't have permission for that — your access may have changed.";
    case "not-found":
      return "That workspace or board no longer exists, or you were removed from it.";
    case "unauthenticated":
      return "You're signed out. Sign in again to continue.";
    case "unavailable":
      return "Couldn't reach the server. Your changes are kept locally until it's back.";
    case "deadline-exceeded":
      return "The server didn't respond in time — you may be offline. Nothing was lost.";
    case "resource-exhausted":
      return "The project has hit a usage limit. Try again later.";
    case "failed-precondition":
      return (err && err.message) || "The server rejected that request.";
    default:
      return (err && err.message) || "Something went wrong.";
  }
}

// True when a write failed because the server refused it on permission grounds
// — i.e. this user's role changed under them. Callers must NOT clear the dirty
// flag in that case: the edits are still only local and would be silently lost.
export function isPermissionDenied(err) {
  return !!err && err.code === "permission-denied";
}
