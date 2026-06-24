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
import { backend } from "./backend/backend.js";
import { render } from "./render/index.js";
import { loadFromCloud, saveToCloud, refreshNow, setSync, setCloudStatus, cloudConnected, startPolling } from "./sync.js";

// --- cloud config persistence ({ apiKey, binId, registryId }) ---
// Nothing is embedded: a blank apiKey means "not connected yet" and the gated
// Cloud popup will demand a Master Key. registryId is cached after discovery so
// repeat visits skip the bin listing.
export function loadCloud() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CLOUD_KEY) || "{}"); } catch (_) {}
  return { apiKey: saved.apiKey || "", binId: saved.binId || "", registryId: saved.registryId || "" };
}
export function persistCloud() { try { localStorage.setItem(CLOUD_KEY, JSON.stringify(S.cloud)); } catch (_) {} }

// Seed S.cloud + the backend's credentials from localStorage. Called once from
// main.js bootstrap — NOT at module-eval time, because a circular import
// (state → sync → boards) means this module's body runs before state.js has
// initialized `S`, which would put `S` in the temporal dead zone.
export function initCloudConfig() {
  S.cloud = loadCloud();
  backend.apiKey = S.cloud.apiKey || null;
  backend.registryId = S.cloud.registryId || null;
}

// Connect with a candidate Master Key: resolve the account's board registry
// (cached → verify, else discover by listing, else create a fresh workspace),
// load its boards, and lift the gate. Shared by startup and the ☁ panel.
// Returns true on success. On failure the gate stays up and an error is shown.
export async function connect(apiKey) {
  apiKey = (apiKey || "").trim();
  if (!apiKey) { setCloudStatus("Paste your JSONBin Master Key to connect.", ""); return false; }
  S.cloud.apiKey = apiKey;
  backend.apiKey = apiKey;
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
      const { id: newReg } = await backend.createRegistry([]);
      backend.registryId = newReg;
      const empty = { version: 1, settings: { viewMode: S.state.settings.viewMode || "week" }, groups: [], tasks: [] };
      const { id: boardId } = await backend.createBoardData("My Board", empty);
      await backend.putRegistry([{ id: boardId, name: "My Board" }]);
      regId = newReg; S.cloud.binId = boardId;
    }
    S.cloud.registryId = regId; backend.registryId = regId; persistCloud();

    // 2. Load the registry + the remembered (or first) board.
    await loadRegistry();
    if (S.registry.length && !S.registry.some(b => b.id === S.cloud.binId)) {
      S.cloud.binId = S.registry[0].id; persistCloud(); renderBoardSelect();
    }
    S.cloudReady = false;
    if (S.cloud.binId) await loadFromCloud(); else render();

    // 3. Lift the gate.
    S.cloudGate = false;
    updateCloudUI();
    closeCloud();
    startPolling();
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
  const conn = cloudConnected() && !S.cloudGate;
  document.body.classList.toggle("cloud-on", conn);
  // While gated, hide the close button and the board-management controls — the
  // only valid action is pasting a key and connecting.
  document.body.classList.toggle("cloud-gated", S.cloudGate);
  $("c-close").style.display = S.cloudGate ? "none" : "";
  if (conn) { setCloudStatus("Connected ✓ · bin " + (S.cloud.binId || "(none)"), "ok"); setSync("ok"); }
  else if (!S.cloudGate) { setSync("idle"); }
  else { setCloudStatus("Paste your JSONBin Master Key to connect.", ""); setSync("idle"); }
}
export function openCloud() {
  $("c-binid").value = S.cloud.binId || "";
  if (!S.cloud.apiKey) $("c-apikey").value = "";
  updateCloudUI();
  $("cloud-overlay").classList.add("show");
}
// Refuse to close while gated (no valid key yet).
export function closeCloud() { if (S.cloudGate) return; $("cloud-overlay").classList.remove("show"); }

// --- wiring ---
$("cloud-btn").addEventListener("click", openCloud);
$("c-close").addEventListener("click", closeCloud);
$("cloud-overlay").addEventListener("click", (e) => { if (e.target === $("cloud-overlay") && !S.cloudGate) closeCloud(); });
$("c-connect").addEventListener("click", () => { connect($("c-apikey").value); });
$("c-apikey").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); connect($("c-apikey").value); } });
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
