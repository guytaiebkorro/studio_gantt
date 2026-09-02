// ---------------------------------------------------------------------------
// Admin SDK initialization.
//
// The Admin SDK BYPASSES Firestore Security Rules entirely — it authorizes
// through IAM, not through the rules engine. That is exactly what makes
// "workspaces are provisioned only by the repo owner" enforceable: the rules say
// `allow create: if false` for /workspaces, and this CLI is the only thing that
// can get around it.
//
// It also means this file has no safety net. Every guard that protects the data
// here is a check WE write — see validate.js.
//
// Credentials come from Application Default Credentials:
//     gcloud auth application-default login
//     gcloud auth application-default set-quota-project korro-gantt
//
// ADC rather than a downloaded service-account key: a key file is a permanent,
// unexpirable, full-database credential sitting on disk in a git repo. ADC is
// short-lived, tied to your own Google identity and IAM role, and centrally
// revocable. GOOGLE_APPLICATION_CREDENTIALS still works as a fallback if you
// ever need one (the SDK picks it up automatically) — `doctor` reports which
// path is actually in use.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

// Project id resolution: $GANTT_PROJECT wins, else the repo's .firebaserc, so
// the CLI works with no environment set up at all.
export function resolveProjectId() {
  if (process.env.GANTT_PROJECT) return process.env.GANTT_PROJECT;
  try {
    const rc = JSON.parse(readFileSync(join(REPO_ROOT, ".firebaserc"), "utf8"));
    const id = rc && rc.projects && rc.projects.default;
    if (id && id !== "REPLACE_ME") return id;
  } catch (_) { /* fall through to the error below */ }
  throw new Error(
    "No project id. Set GANTT_PROJECT=<project-id>, or put it in .firebaserc under projects.default."
  );
}

let _db = null;

export function db() {
  if (_db) return _db;
  const projectId = resolveProjectId();
  try {
    initializeApp({ credential: applicationDefault(), projectId });
  } catch (err) {
    throw new Error(
      "Could not initialize the Admin SDK: " + err.message +
      "\n\nRun:  gcloud auth application-default login" +
      "\n      gcloud auth application-default set-quota-project " + projectId
    );
  }
  _db = getFirestore();
  return _db;
}

export { FieldValue };
export const REPO = REPO_ROOT;
