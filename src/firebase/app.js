// ---------------------------------------------------------------------------
// The Firebase SDK singleton — the ONLY module in this app that imports the SDK.
//
// Everything else imports the narrow set of functions re-exported at the bottom,
// so no other file names a CDN URL or a bare "firebase/*" specifier. That keeps
// the SDK swappable and the version pinned in one place (the import map in
// index.html — see ./config.js for why that must be the single source).
//
// The bare specifiers below are resolved by that import map. They are NOT
// resolvable by Node, only by a browser — which is fine, this file only ever
// runs in one.
// ---------------------------------------------------------------------------
import { initializeApp } from "firebase/app";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithCredential, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence, connectAuthEmulator
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  connectFirestoreEmulator,
  doc, collection, collectionGroup, query, where, orderBy, limit,
  getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  runTransaction, writeBatch, onSnapshot, serverTimestamp, deleteField
} from "firebase/firestore";
import { FIREBASE_CONFIG, USE_EMULATOR } from "./config.js";

export const app = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);

// Multi-tab persistence, not the single-tab default: the app explicitly supports
// several workspaces open side by side (updateWorkspaceButton() renames the
// browser tab for exactly that reason), and single-tab persistence throws in the
// second tab.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

export const googleProvider = new GoogleAuthProvider();

// ALWAYS offer the account chooser.
//
// signOut() ends the FIREBASE session; it has no effect on the Google session
// in the browser. Without this parameter Google's OAuth endpoint sees that
// session, silently re-authorizes the same account and hands the popup
// straight back — so signing out and clicking "Continue with Google" logged
// you back in as whoever you just left, with no way to pick anyone else.
//
// This costs a returning user nothing. A persisted Firebase session never
// reaches this code at all (authReady resolves with the user and the gate
// never shows), so the chooser only appears when someone has actually clicked
// the button — which is precisely when they might mean a different account.
//
// Deliberately `select_account` and not `consent`: `consent` would also
// re-prompt for scopes on every single sign-in.
googleProvider.setCustomParameters({ prompt: "select_account" });

if (USE_EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  console.info("Firebase: using local emulators (auth :9099, firestore :8080)");
}

export {
  // auth
  GoogleAuthProvider, signInWithPopup, signInWithCredential, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence,
  // firestore refs & queries
  doc, collection, collectionGroup, query, where, orderBy, limit,
  // firestore reads & writes
  getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  runTransaction, writeBatch, onSnapshot, serverTimestamp, deleteField
};
