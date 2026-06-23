// ---------------------------------------------------------------------------
// Boards: the registry of boards, the toolbar switcher, board CRUD, and the
// ☁ Cloud panel UI. Also owns the cloud-config persistence (which board /
// credentials are active) in localStorage.
//
// All networking goes through the `backend` adapter — this file contains no
// fetch calls, so it works unchanged against any backend.
// ---------------------------------------------------------------------------
import { CLOUD_KEY } from "./config.js";
import { $, esc, toast } from "./dom.js";
import { S } from "./state.js";
import { backend, DEFAULT_KEY, DEFAULT_BOARD_ID } from "./backend/backend.js";
import { loadFromCloud, saveToCloud, refreshNow, setSync, setCloudStatus, cloudConnected } from "./sync.js";

// --- cloud config persistence ({ apiKey, binId }) ---
export function loadCloud() {
  const def = { apiKey: DEFAULT_KEY, binId: DEFAULT_BOARD_ID };
  let merged = def;
  try { merged = Object.assign({}, def, JSON.parse(localStorage.getItem(CLOUD_KEY) || "{}")); } catch (_) {}
  if (!merged.apiKey) merged.apiKey = DEFAULT_KEY;  // fall back to embedded defaults even if a blank was stored
  if (!merged.binId) merged.binId = DEFAULT_BOARD_ID;
  return merged;
}
export function persistCloud() { try { localStorage.setItem(CLOUD_KEY, JSON.stringify(S.cloud)); } catch (_) {} }

// Initialize cloud config and hand the backend its credential. Called once from
// main.js bootstrap — NOT at module-eval time, because a circular import
// (state → sync → boards) means this module's body runs before state.js has
// initialized `S`, which would put `S` in the temporal dead zone.
export function initCloudConfig() {
  S.cloud = loadCloud();
  backend.apiKey = S.cloud.apiKey;
}

// --- board registry ---
export async function loadRegistry() {
  if (!cloudConnected()) return;
  try {
    S.registry = await backend.getRegistry();
  } catch (err) {
    console.warn("registry load failed:", err.message);
  }
  renderBoardSelect();
}
async function saveRegistry() { await backend.putRegistry(S.registry); }

export function renderBoardSelect() {
  const sel = $("board-select");
  if (!sel) return;
  sel.innerHTML = S.registry.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  if (S.cloud.binId && !S.registry.some(b => b.id === S.cloud.binId)) {
    const o = document.createElement("option"); o.value = S.cloud.binId; o.textContent = "(current)"; sel.appendChild(o);
  }
  sel.value = S.cloud.binId || "";
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

// --- cloud panel UI ---
export function updateCloudUI() {
  const conn = cloudConnected();
  document.body.classList.toggle("cloud-on", conn);
  if (conn) { setCloudStatus("Key set · bin " + (S.cloud.binId || "(none)"), "ok"); setSync("ok"); }
  else { setCloudStatus("No key yet — paste a JSONBin access key to sync.", ""); setSync("idle"); }
}
export function openCloud() { $("c-binid").value = S.cloud.binId || ""; updateCloudUI(); $("cloud-overlay").classList.add("show"); }
export function closeCloud() { $("cloud-overlay").classList.remove("show"); }

// --- wiring ---
$("cloud-btn").addEventListener("click", openCloud);
$("c-close").addEventListener("click", closeCloud);
$("cloud-overlay").addEventListener("click", (e) => { if (e.target === $("cloud-overlay")) closeCloud(); });
$("c-binid").addEventListener("change", () => { S.cloud.binId = $("c-binid").value.trim(); persistCloud(); updateCloudUI(); });
$("c-load").addEventListener("click", () => { const id = $("c-binid").value.trim(); if (id === S.cloud.binId) loadFromCloud(); else switchBoard(id); });
$("c-savenow").addEventListener("click", () => { saveToCloud(); });
$("c-create").addEventListener("click", () => { newBoard(); });
$("c-rename").addEventListener("click", () => { renameBoard(); });
$("c-delete").addEventListener("click", () => { deleteBoard(); });
// toolbar board switcher
$("board-select").addEventListener("change", (e) => { switchBoard(e.target.value); });
$("board-new").addEventListener("click", () => { newBoard(); });
$("refresh-btn").addEventListener("click", () => { refreshNow(); });
