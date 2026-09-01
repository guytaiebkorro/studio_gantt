// ---------------------------------------------------------------------------
// Remembered workspaces (device-local).
//
// A workspace is one backend account: a credential plus the registry bin whose
// boards that credential unlocks. This module owns the LIST of workspaces the
// user has connected on this device — which one is active, the credential for
// each, and a cached copy of the name so the toolbar can paint before the
// network answers. The authoritative name lives in the registry bin (see
// boards.js loadRegistry); everything here is a cache of it.
//
// Entries are keyed by registryId — the stable identifier of an account's
// workspace — so re-pasting a key for an account already saved updates that
// entry instead of adding a duplicate.
//
// This is the only file that reads or writes the workspace list in
// localStorage. Nothing here touches the network.
// ---------------------------------------------------------------------------
import { CLOUD_KEY, WORKSPACES_KEY, DEFAULT_WORKSPACE_NAME } from "./config.js";
import { S } from "./state.js";

// registryId of the workspace the app is currently pointed at ("" when none).
let activeId = "";

const BLANK = { apiKey: "", binId: "", registryId: "" };

function persist() {
  try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify({ activeId, list: S.workspaces })); } catch (_) {}
}

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(WORKSPACES_KEY) || "null");
    if (raw && Array.isArray(raw.list)) {
      return { activeId: raw.activeId || "", list: raw.list.filter(w => w && w.apiKey) };
    }
  } catch (_) {}
  return null;
}

// One-time migration off the pre-workspaces single-account config. The legacy
// key is left in place: it costs nothing and keeps the previous version usable
// if the user rolls back.
function migrateLegacy() {
  let old = {};
  try { old = JSON.parse(localStorage.getItem(CLOUD_KEY) || "{}"); } catch (_) {}
  if (!old.apiKey) return { activeId: "", list: [] };
  // registryId may be absent (the key was saved but never resolved a registry);
  // the entry is then keyed by "" and gets rekeyed on the next connect.
  return {
    activeId: old.registryId || "",
    list: [{ id: old.registryId || "", apiKey: old.apiKey, name: DEFAULT_WORKSPACE_NAME, binId: old.binId || "", lastUsed: 0 }]
  };
}

// Seed S.workspaces / S.workspaceName from storage and return the active
// workspace as a cloud config ({ apiKey, binId, registryId }). A blank config
// means "nothing remembered" — the caller gates on a key.
export function initWorkspaces() {
  const store = readStore() || migrateLegacy();
  S.workspaces = store.list;
  const active = store.list.find(w => w.id && w.id === store.activeId) || store.list[0] || null;
  activeId = active ? active.id : "";
  S.workspaceName = (active && active.name) || DEFAULT_WORKSPACE_NAME;
  persist();
  return active
    ? { apiKey: active.apiKey, binId: active.binId || "", registryId: active.id || "" }
    : Object.assign({}, BLANK);
}

// Remember `cloud` (+ the workspace's name) as the active workspace. Called on
// every cloud-config change — connect, board switch, rename — so the list never
// drifts from what the app is actually pointed at.
export function saveActive(cloud, name) {
  if (!cloud || !cloud.apiKey) { activeId = ""; persist(); return null; }
  const id = cloud.registryId || "";
  // Match on the registry, or absorb a pre-discovery entry saved under the same
  // credential before its registry was known.
  let e = (id && S.workspaces.find(w => w.id === id)) || S.workspaces.find(w => !w.id && w.apiKey === cloud.apiKey);
  if (!e) { e = { id, apiKey: cloud.apiKey, name: name || DEFAULT_WORKSPACE_NAME, binId: "", lastUsed: 0 }; S.workspaces.push(e); }
  e.id = id;
  e.apiKey = cloud.apiKey;
  e.binId = cloud.binId || "";
  if (name) e.name = name;
  e.lastUsed = Date.now();
  activeId = id;
  persist();
  return e;
}

export function findWorkspace(id) { return S.workspaces.find(w => w.id === id) || null; }
export function getActiveId() { return activeId; }

// Forget a workspace on this device (the account and its data are untouched).
// Returns the workspace to fall back to — the most recently used survivor — or
// null when nothing is left and the app must re-gate.
export function forgetWorkspace(id) {
  S.workspaces = S.workspaces.filter(w => w.id !== id);
  if (activeId === id) activeId = "";
  persist();
  return S.workspaces.slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0] || null;
}

// Forget everything (used by the full log-out path).
export function forgetAllWorkspaces() {
  S.workspaces = [];
  activeId = "";
  persist();
}

// Workspaces in display order: alphabetical, so rows don't jump around as
// lastUsed changes underneath the user.
export function workspacesForDisplay() {
  return S.workspaces.slice().sort((a, b) =>
    (a.name || DEFAULT_WORKSPACE_NAME).localeCompare(b.name || DEFAULT_WORKSPACE_NAME));
}
