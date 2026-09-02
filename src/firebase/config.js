// ---------------------------------------------------------------------------
// Firebase project configuration — a leaf module, imported only by ./app.js.
//
// THESE VALUES ARE PUBLIC BY DESIGN. The web "apiKey" is not a secret and not a
// credential: it identifies the project to Google's APIs, and it ships in the
// source of every page that uses Firebase. Committing it is expected. All access
// control lives in firestore.rules — secrecy is not part of the model.
//
// Two things that ARE worth doing because the key is public:
//   1. Restrict the key by HTTP referrer (Cloud console -> Credentials) to this
//      app's origins, so it can't be used to burn quota from elsewhere.
//   2. Keep every sign-in provider except Google disabled. The rules pin
//      sign_in_provider == 'google.com', but an enabled email/password provider
//      would let someone sign up AS an invited address and try to collect the
//      invite. Defense in depth is free here.
// ---------------------------------------------------------------------------

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA1nGWlUc3mngJWZVrIsSbs9gCQQEMcnYY",
  authDomain: "korro-gantt.firebaseapp.com",
  projectId: "korro-gantt",
  storageBucket: "korro-gantt.firebasestorage.app",
  messagingSenderId: "97548522664",
  appId: "1:97548522664:web:6b3f5713ba620f6e8dde9d"
  // measurementId is deliberately omitted: it only matters to Google Analytics,
  // which this app does not load. Add it back with firebase-analytics.js if you
  // ever want it — it is not needed for Auth or Firestore.
};

// The SDK version is DELIBERATELY NOT DEFINED HERE. It lives in exactly one
// place: the <script type="importmap"> block in index.html.
//
// It has to be one place. The gstatic firebase-auth.js and firebase-firestore.js
// bundles import firebase-app.js by ABSOLUTE URL, pinned to their own version:
//
//   from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js"
//
// So if the import map resolved "firebase/app" to a DIFFERENT version than the
// auth/firestore entries, firebase-app.js would load twice as two separate
// module instances — initializeApp() would register on one and getAuth() would
// read the other, failing with "No Firebase App '[DEFAULT]' has been created".
// Keeping all three map entries on one version, in one file, makes that
// mismatch impossible to introduce by editing a second file.
//
// Never pin "latest": there is no build step and no lockfile, so the import map
// is the only thing standing between this app and a breaking CDN change.

// Point at the local emulator suite when serving from localhost, so development
// never touches real data. Requires `firebase emulators:start` (and a JRE).
export const USE_EMULATOR = ["localhost", "127.0.0.1"].includes(location.hostname)
  && new URLSearchParams(location.search).get("emulator") === "1";
