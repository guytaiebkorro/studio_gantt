// ---------------------------------------------------------------------------
// Local persistence: the "Save to HTML file" fallback (used only when NOT
// connected to a cloud backend), JSON export/import, and the unified save().
//
// NOTE: buildHtml() writes the current board JSON back into this page's
// #gantt-data block and saves the document. Now that the app's logic lives in
// external modules (src/*.js) and styles (styles/*.css), the saved file is no
// longer fully self-contained — it must stay alongside those folders to run.
// Since the cloud backend is the primary persistence path (and is the default),
// this fallback is rarely reached. The logic is otherwise unchanged.
// ---------------------------------------------------------------------------
import { $, toast } from "./dom.js";
import { S, normalize, clearDirty, markDirty, supportsFS } from "./state.js";
import { saveToCloud, cloudConnected } from "./sync.js";
import { updateViewButtons } from "./ui/toolbar.js";
import { render } from "./render/index.js";

function serialize() { return JSON.stringify(S.state); }

function buildHtml() {
  // Clone the document and strip all runtime-generated DOM so the saved file
  // stays lean (it self-rebuilds on load). Then splice fresh JSON into the
  // data block via plain string replacement.
  const root = document.documentElement.cloneNode(true);
  const q = (sel) => root.querySelector(sel);
  const li = q("#list-inner");      if (li) li.innerHTML = "";
  const ch = q("#chart-header");    if (ch) ch.innerHTML = "";
  const cb = q("#chart-body");
  if (cb) cb.querySelectorAll(".grid-col, .row-line, .bar, .milestone, .ms-label").forEach(e => e.remove());
  const svg = q("#dep-svg");        if (svg) svg.innerHTML = "";
  // collapse open modals/toast so they don't persist as "shown"
  root.querySelectorAll(".overlay").forEach(o => o.classList.remove("show"));
  root.querySelectorAll(".toast").forEach(o => o.classList.remove("show"));
  if (root.querySelector("body")) root.querySelector("body").classList.remove("dirty");

  const html = "<!DOCTYPE html>\n<html lang=\"en\">" + root.innerHTML + "</html>\n";
  const open = '<script type="application/json" id="gantt-data">';
  const close = '<\/script>';
  const i = html.indexOf(open);
  if (i < 0) throw new Error("data block not found");
  const j = html.indexOf(close, i);
  if (j < 0) throw new Error("data block end not found");
  return html.slice(0, i + open.length) + "\n" + serialize() + "\n" + html.slice(j);
}

async function saveToFile() {
  let htmlOut;
  try { htmlOut = buildHtml(); }
  catch (err) { toast("Save failed: " + err.message); return; }

  if (supportsFS) {
    try {
      if (!S.fileHandle) {
        S.fileHandle = await window.showSaveFilePicker({
          suggestedName: "gantt.html",
          types: [{ description: "HTML", accept: { "text/html": [".html"] } }]
        });
      }
      const w = await S.fileHandle.createWritable();
      await w.write(htmlOut);
      await w.close();
      clearDirty();
      toast("Saved ✓");
    } catch (err) {
      if (err && err.name === "AbortError") return; // user cancelled
      toast("Save error: " + err.message);
    }
  } else {
    downloadHtml(htmlOut);
    clearDirty();
    toast("Downloaded gantt.html — move it to your Dropbox folder");
  }
}

function downloadHtml(htmlOut) {
  const blob = new Blob([htmlOut], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "gantt.html";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Unified save: cloud when connected (cloud-only mode), else fall back to file/download.
export async function save() {
  if (S.locked) return; // view-only: nothing to save
  if (cloudConnected() && S.cloud.binId) return saveToCloud();
  return saveToFile();
}

// --- wiring ---
$("save-btn").addEventListener("click", save);

// Export JSON
$("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(S.state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "gantt-data.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// Import JSON
$("import-btn").addEventListener("click", () => {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "application/json,.json";
  inp.addEventListener("change", () => {
    const f = inp.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.tasks) throw new Error("missing tasks");
        S.state = normalize(data);
        markDirty(); updateViewButtons(); render();
        toast("Imported ✓");
      } catch (err) { toast("Import failed: " + err.message); }
    };
    reader.readAsText(f);
  });
  inp.click();
});
