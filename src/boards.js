// ---------------------------------------------------------------------------
// Workspaces and boards: the board registry, the toolbar switcher, board CRUD,
// the workspace switcher, and the Account panel UI.
//
// Two levels of grouping:
//   workspace — one backend account (a credential + its registry bin). The
//               device-local list of them lives in ./workspaces.js.
//   board     — one document inside the active workspace's registry.
//
// All networking goes through the `backend` adapter — this file contains no
// fetch calls, so it works unchanged against any backend.
// ---------------------------------------------------------------------------
import { DEFAULT_WORKSPACE_NAME } from "./config.js";
import { $, esc, toast, chartPane, wireBackdropClose } from "./dom.js";
import { S, clearDirty } from "./state.js";
import { dateToX, today } from "./dates.js";
import { backend } from "./backend/backend.js";
import { render } from "./render/index.js";
import { loadFromCloud, saveToCloud, refreshNow, setSync, setCloudStatus, cloudConnected, startPolling } from "./sync.js";
import {
  initWorkspaces, saveActive, findWorkspace, getActiveId,
  forgetWorkspace, forgetAllWorkspaces, workspacesForDisplay
} from "./workspaces.js";

// --- cloud config persistence ({ apiKey, binId, registryId }) ---
// Nothing is embedded: a blank apiKey means "not connected yet" and the gated
// Account popup will demand a Master Key. The config is a view onto the active
// entry in the workspace list, so persisting it writes through to that entry.
export function persistCloud() { saveActive(S.cloud, S.workspaceName); }

// Point the app at a workspace without loading anything yet.
function setActiveCloud(cfg) {
  S.cloud = { apiKey: cfg.apiKey || "", binId: cfg.binId || "", registryId: cfg.registryId || "" };
  backend.apiKey = S.cloud.apiKey || null;
  backend.registryId = S.cloud.registryId || null;
}

// Seed S.cloud + the backend's credentials from the remembered workspaces.
// Called once from main.js bootstrap — NOT at module-eval time, because a
// circular import (state → sync → boards) means this module's body runs before
// state.js has initialized `S`, which would put `S` in the temporal dead zone.
export function initCloudConfig() {
  setActiveCloud(initWorkspaces());
}

// Connect with a candidate Master Key: resolve the account's board registry
// (cached → verify, else discover by listing, else create a fresh workspace),
// load its boards, and lift the gate. Shared by startup, workspace switching,
// share links, and the Account panel.
//
// `target` names the workspace to open — { registryId, binId, name } — and
// REPLACES whatever the app was pointed at, so switching accounts can't inherit
// the previous one's registry or board. Pass null to resume the active
// workspace as remembered (the startup path).
//
// Returns true on success. On failure the gate stays up and an error is shown.
export async function connect(apiKey, target) {
  apiKey = (apiKey || "").trim();
  if (!apiKey) { setCloudStatus("Paste your JSONBin Master Key to connect.", ""); return false; }
  if (target) {
    setActiveCloud({ apiKey, registryId: target.registryId, binId: target.binId });
    // A cached name paints the toolbar now; the registry's copy wins once loaded.
    S.workspaceName = target.name || DEFAULT_WORKSPACE_NAME;
  } else {
    S.cloud.apiKey = apiKey;
    backend.apiKey = apiKey;
  }
  updateAccountButton();
  setSync("syncing"); setCloudStatus("Connecting…", "");
  $("loading").classList.add("show");
  try {
    // 1. Resolve the registry id.
    let regId = S.cloud.registryId || null;
    if (regId) {
      backend.registryId = regId;
      try { await backend.getRegistry(); } catch (_) { regId = null; } // cached id stale/inaccessible
    }
    if (!regId) { setCloudStatus("Finding your boards…", ""); regId = await backend.discoverRegistryId(); }
    if (!regId) {
      // brand-new account → create an isolated workspace: registry + starter board
      setCloudStatus("Setting up a new workspace…", "");
      S.workspaceName = DEFAULT_WORKSPACE_NAME;
      const { id: newReg } = await backend.createRegistry(DEFAULT_WORKSPACE_NAME, []);
      backend.registryId = newReg;
      const empty = { version: 1, settings: { viewMode: S.state.settings.viewMode || "week" }, groups: [], tasks: [] };
      const { id: boardId } = await backend.createBoardData("My Board", empty);
      await backend.putRegistry(DEFAULT_WORKSPACE_NAME, [{ id: boardId, name: "My Board" }]);
      regId = newReg; S.cloud.binId = boardId;
    }
    S.cloud.registryId = regId; backend.registryId = regId; persistCloud();

    // 2. Load the registry — which is where the workspace's real name comes
    //    from — then the remembered (or first) board.
    await loadRegistry();
    if (S.registry.length && !S.registry.some(b => b.id === S.cloud.binId)) {
      S.cloud.binId = S.registry[0].id; renderBoardSelect();
    }
    persistCloud(); // cache the name the registry just gave us alongside the key
    updateAccountButton();
    S.cloudReady = false;
    if (S.cloud.binId) await loadFromCloud(); else render();

    // 3. Lift the gate and center the timeline on today.
    S.cloudGate = false;
    updateCloudUI();
    closeCloud();
    startPolling();
    requestAnimationFrame(() => { chartPane.scrollLeft = Math.max(0, dateToX(today()) - chartPane.clientWidth / 2); });
    return true;
  } catch (err) {
    const auth = /master key|unauthorized|401|403/i.test(err.message || "");
    setSync("err");
    setCloudStatus(auth
      ? "Couldn’t connect — a JSONBin Master Key is required (Access Keys can’t discover boards)."
      : "Connect failed: " + err.message, "err");
    return false;
  } finally {
    $("loading").classList.remove("show");
  }
}

// --- workspace registry (its name + its boards) ---
export async function loadRegistry() {
  if (!cloudConnected()) return;
  try {
    const reg = await backend.getRegistry();
    S.registry = reg.boards;
    // A registry written before workspaces were named has no name. Adopt the
    // default locally and backfill it remotely, once, so every device and every
    // share-link recipient sees the same name from here on.
    if (reg.name) S.workspaceName = reg.name;
    else { S.workspaceName = DEFAULT_WORKSPACE_NAME; try { await saveRegistry(); } catch (_) {} }
  } catch (err) {
    console.warn("registry load failed:", err.message);
  }
  renderBoardSelect();
}
async function saveRegistry() { await backend.putRegistry(S.workspaceName, S.registry); }

export function renderBoardSelect() {
  const sel = $("board-select");
  if (!sel) return;
  sel.innerHTML = S.registry.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  if (S.cloud.binId && !S.registry.some(b => b.id === S.cloud.binId)) {
    const o = document.createElement("option"); o.value = S.cloud.binId; o.textContent = "(current)"; sel.appendChild(o);
  }
  sel.value = S.cloud.binId || "";
  fitBoardSelect();
}

// Size the select to its SELECTED option, not its widest one — a native select
// keeps the width of the longest board name, stranding the chevron far from a
// short selected name.
function fitBoardSelect() {
  const sel = $("board-select");
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  if (!opt) { sel.style.width = ""; return; }
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute; visibility:hidden; white-space:nowrap;";
  probe.style.font = getComputedStyle(sel).font;
  probe.textContent = opt.textContent;
  document.body.appendChild(probe);
  const text = probe.getBoundingClientRect().width;
  probe.remove();
  // left padding 14 + right padding (chevron) 28 + 2px borders
  sel.style.width = Math.ceil(Math.min(200, text + 44)) + "px";
}

export async function switchBoard(id) {
  if (!id || id === S.cloud.binId) return;
  S.cloud.binId = id; persistCloud();
  S.cloudReady = false;
  renderBoardSelect();
  $("loading").classList.add("show");
  await loadFromCloud();
  $("loading").classList.remove("show");
}

async function newBoard() {
  if (!cloudConnected()) { toast("Cloud not configured"); return; }
  const name = (prompt("Name for the new board:", "New board") || "").trim();
  if (!name) return;
  setSync("syncing"); setCloudStatus("Creating board…", "");
  $("loading").classList.add("show");
  try {
    const empty = { version: 1, settings: { viewMode: S.state.settings.viewMode || "week" }, groups: [], tasks: [] };
    const { id } = await backend.createBoardData(name, empty);
    S.registry.push({ id, name });
    await saveRegistry();
    S.cloud.binId = id; persistCloud();
    S.cloudReady = false;
    renderBoardSelect();
    await loadFromCloud(); // pulls the (empty) board and arms autosave
    toast("Board “" + name + "” created ✓");
  } catch (err) {
    setSync("err"); setCloudStatus("Create failed: " + err.message, "err");
    toast("Create board failed: " + err.message);
  } finally {
    $("loading").classList.remove("show");
  }
}

async function renameBoard() {
  if (!S.registry.length) { toast("No boards to rename"); return; }
  const entry = S.registry.find(b => b.id === S.cloud.binId);
  const name = (prompt("Rename board:", entry ? entry.name : "") || "").trim();
  if (!name) return;
  if (entry) entry.name = name; else S.registry.push({ id: S.cloud.binId, name });
  try { await saveRegistry(); renderBoardSelect(); toast("Renamed ✓"); }
  catch (err) { toast("Rename failed: " + err.message); }
}

async function deleteBoard() {
  if (S.registry.length <= 1) { toast("Can't delete the only board"); return; }
  const entry = S.registry.find(b => b.id === S.cloud.binId);
  if (!confirm("Delete board “" + (entry ? entry.name : S.cloud.binId) + "”?\nThis removes it from the list and deletes its data.")) return;
  const delId = S.cloud.binId;
  S.registry = S.registry.filter(b => b.id !== delId);
  try {
    await saveRegistry();
    try { await backend.deleteBoardData(delId); } catch (_) {}
    S.cloud.binId = S.registry[0].id; persistCloud();
    S.cloudReady = false;
    renderBoardSelect();
    $("loading").classList.add("show");
    await loadFromCloud();
    $("loading").classList.remove("show");
    toast("Board deleted");
  } catch (err) { toast("Delete failed: " + err.message); }
}

// --- workspace name + switcher ---

// The Account button doubles as the workspace indicator, so you can always see
// which workspace you're in. Its title also carries the sync state, which
// setSync() refreshes through here.
export function updateAccountButton() {
  const conn = cloudConnected() && !S.cloudGate;
  const name = S.workspaceName || DEFAULT_WORKSPACE_NAME;
  const label = $("cloud-label");
  if (label) label.textContent = conn ? name : "Account";
  $("cloud-btn").title = (conn ? `Workspace: ${name}` : "Account & cloud sync") + ` — sync: ${S.syncState}`;
}

// Mirror the active workspace name into the panel's name field. Skipped while
// the field has focus so a background refresh can't overwrite mid-edit.
function renderWorkspaceName() {
  const inp = $("c-ws-name");
  if (inp && document.activeElement !== inp) inp.value = S.workspaceName || "";
}

// One row per remembered workspace. Hidden entirely when nothing is remembered
// (first run), so the gate stays a single "paste your key" step.
function renderWorkspaceList() {
  const box = $("c-ws-list");
  if (!box) return;
  const list = workspacesForDisplay();
  const section = $("c-ws-section");
  if (section) section.style.display = list.length ? "" : "none";
  const activeIdNow = S.cloud.registryId || getActiveId();
  box.innerHTML = list.map(w => {
    const on = w.id && w.id === activeIdNow;
    return `<div class="ws-row${on ? " active" : ""}" data-id="${esc(w.id)}" role="button" tabindex="0">` +
             `<span class="ws-name">${esc(w.name || DEFAULT_WORKSPACE_NAME)}</span>` +
             (on ? `<span class="ws-badge">current</span>` : "") +
             `<button class="ws-forget" data-forget="${esc(w.id)}" title="Forget this workspace on this device">&times;</button>` +
           `</div>`;
  }).join("");
}

// Switch to another remembered workspace: drop what's loaded, then connect with
// that workspace's own credential, registry and last board.
export async function switchWorkspace(id) {
  const w = findWorkspace(id);
  if (!w) { toast("That workspace is no longer saved"); return; }
  if (w.id && w.id === (S.cloud.registryId || getActiveId()) && !S.cloudGate) { closeCloud(); return; }
  await leaveActiveWorkspace();
  const ok = await connect(w.apiKey, { registryId: w.id, binId: w.binId, name: w.name });
  if (ok) { toast(`Switched to “${S.workspaceName}” ✓`); return; }
  // Nothing is loaded and the credential didn't work — re-gate rather than leave
  // an empty board looking connected. The switcher stays available behind it.
  S.cloudGate = true;
  openCloud();
}

// Rename the active workspace. The name lives in the registry bin, so every
// device and every share-link recipient sees it; the local list caches it.
async function renameWorkspace(raw) {
  if (!cloudConnected() || S.cloudGate) return;
  const name = (raw || "").trim() || DEFAULT_WORKSPACE_NAME;
  const prev = S.workspaceName;
  if (name === prev) { renderWorkspaceName(); return; }
  S.workspaceName = name;
  persistCloud(); updateAccountButton(); renderWorkspaceList(); renderWorkspaceName();
  try {
    await saveRegistry();
    toast("Workspace renamed ✓");
  } catch (err) {
    S.workspaceName = prev;
    persistCloud(); updateAccountButton(); renderWorkspaceList(); renderWorkspaceName();
    toast("Rename failed: " + err.message);
  }
}

// --- teardown helpers (shared by switching, removing and logging out) ---

function stopSync() {
  clearTimeout(S.autosaveTimer); S.autosaveTimer = null; S.firstDirtyAt = 0;
  if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
}

// Stop syncing and hand back the workspace we're standing on.
//
// The pending save MUST complete before the board is cleared: saveToCloud()
// merges from S.state at write time, so letting it run against the blanked
// state would push an empty board over the user's data.
async function leaveActiveWorkspace() {
  stopSync();
  if (S.dirty && cloudConnected() && S.cloud.binId) await saveToCloud(); // reports its own errors
  clearLoadedBoard();
}

// Drop the loaded account's data so nothing leaks into the next workspace or
// behind the gate.
function clearLoadedBoard() {
  S.registry = []; renderBoardSelect();
  S.cloudReady = false; S.baseState = null; S.loadedAt = 0;
  S.state = { version: 1, settings: { viewMode: (S.state.settings && S.state.settings.viewMode) || "week" }, groups: [], tasks: [] };
  clearDirty(); render();
}
// No workspace to fall back to: re-gate and prompt for a key.
function gateForNewKey() {
  setActiveCloud({});
  S.workspaceName = DEFAULT_WORKSPACE_NAME;
  S.cloudGate = true;
  document.body.classList.remove("ws-adding");
  $("c-apikey").value = "";
  updateCloudUI();
  openCloud();
}

// Forget the ACTIVE workspace on this device and fall back to the most recently
// used survivor; re-gate when it was the last one. The account and its boards
// are untouched — only this browser forgets the key.
export async function removeActiveWorkspace() {
  const id = S.cloud.registryId || getActiveId();
  const name = S.workspaceName || DEFAULT_WORKSPACE_NAME;
  if (!confirm(`Remove “${name}” from this browser?\nThe workspace and its boards stay on the account — you'll need the key again to get back in.`)) return;
  await leaveActiveWorkspace();
  const next = forgetWorkspace(id);
  if (next) {
    await switchWorkspace(next.id);
    toast(`Removed “${name}” — now in “${S.workspaceName}”`);
  } else {
    gateForNewKey();
    toast(`Removed “${name}”`);
  }
}

// Forget every workspace and re-gate.
export async function logoutAll() {
  if (S.workspaces.length > 1 &&
      !confirm(`Log out of all ${S.workspaces.length} workspaces on this browser?`)) return;
  await leaveActiveWorkspace();
  forgetAllWorkspaces();
  gateForNewKey();
}

// --- account panel UI ---
export function updateCloudUI() {
  const conn = cloudConnected() && !S.cloudGate;
  document.body.classList.toggle("cloud-on", conn);
  // While gated, hide the close button and the board-management controls — the
  // only valid actions are pasting a key or picking a remembered workspace.
  document.body.classList.toggle("cloud-gated", S.cloudGate);
  $("c-close").style.display = S.cloudGate ? "none" : "";
  if (conn) {
    const n = S.registry.length;
    const boards = n === 1 ? "1 board" : n + " boards";
    setCloudStatus(`Connected to “${S.workspaceName}” ✓ — ${boards} on this account.`, "ok");
    setSync("ok");
  }
  else if (!S.cloudGate) { setSync("idle"); }
  else { setCloudStatus("Paste your JSONBin Master Key to connect.", ""); setSync("idle"); }
  updateAccountButton();
  renderWorkspaceName();
  renderWorkspaceList();
}
export function openCloud() {
  if (!S.cloud.apiKey) $("c-apikey").value = "";
  updateCloudUI();
  $("cloud-overlay").classList.add("show");
}
// Refuse to close while gated (no valid key yet).
export function closeCloud() {
  if (S.cloudGate) return;
  document.body.classList.remove("ws-adding");
  $("cloud-overlay").classList.remove("show");
}

// Manual key entry. A pasted key must never inherit the CURRENT workspace's
// registry or board — but if it belongs to a workspace we already remember,
// reuse that one's cached ids instead of paying for discovery again.
async function connectWithKey(raw) {
  const key = (raw || "").trim();
  const known = S.workspaces.find(w => w.apiKey === key);
  const ok = await connect(key, known ? { registryId: known.id, binId: known.binId, name: known.name } : {});
  if (ok) { document.body.classList.remove("ws-adding"); $("c-apikey").value = ""; }
  return ok;
}

// --- wiring ---
$("cloud-btn").addEventListener("click", openCloud);
$("c-close").addEventListener("click", closeCloud);
wireBackdropClose($("cloud-overlay"), closeCloud, () => !S.cloudGate);
$("c-connect").addEventListener("click", () => { connectWithKey($("c-apikey").value); });
$("c-logout").addEventListener("click", () => { removeActiveWorkspace(); });
$("c-logout-all").addEventListener("click", () => { logoutAll(); });
$("c-apikey").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); connectWithKey($("c-apikey").value); } });
// workspace name: commit on blur or Enter (Escape reverts)
$("c-ws-name").addEventListener("change", (e) => { renameWorkspace(e.target.value); });
$("c-ws-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  if (e.key === "Escape") { e.preventDefault(); renderWorkspaceName(); e.target.blur(); }
});
// workspace switcher: a row switches, its × forgets
$("c-ws-list").addEventListener("click", (e) => {
  const forget = e.target.closest(".ws-forget");
  if (forget) {
    e.stopPropagation();
    const id = forget.dataset.forget;
    if (id === (S.cloud.registryId || getActiveId())) { removeActiveWorkspace(); return; }
    const w = findWorkspace(id);
    if (!w || !confirm(`Remove “${w.name || DEFAULT_WORKSPACE_NAME}” from this browser?`)) return;
    forgetWorkspace(id); renderWorkspaceList();
    return;
  }
  const row = e.target.closest(".ws-row");
  if (row) switchWorkspace(row.dataset.id);
});
$("c-ws-list").addEventListener("keydown", (e) => {
  const row = e.target.closest(".ws-row");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); switchWorkspace(row.dataset.id); }
});
// "Add workspace" reveals the key entry that's otherwise hidden once connected
$("c-ws-add").addEventListener("click", () => {
  const on = document.body.classList.toggle("ws-adding");
  if (on) { $("c-apikey").value = ""; $("c-apikey").focus(); }
});
$("c-savenow").addEventListener("click", () => { saveToCloud(); });
$("c-create").addEventListener("click", () => { newBoard(); });
$("c-rename").addEventListener("click", () => { renameBoard(); });
$("c-delete").addEventListener("click", () => { deleteBoard(); });
// toolbar board switcher
$("board-select").addEventListener("change", (e) => { switchBoard(e.target.value); });
$("board-new").addEventListener("click", () => { newBoard(); });
$("refresh-btn").addEventListener("click", () => { refreshNow(); });
