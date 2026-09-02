// ---------------------------------------------------------------------------
// JSON export / import, and the unified save().
//
// The "Save to HTML file" fallback is GONE, along with buildHtml(),
// saveToFile(), downloadHtml() and the save-mode banner. Three reasons:
//
//   1. It was unreachable. The app now sits behind a sign-in gate, so there is
//      no state in which you are running without a cloud backend.
//   2. It had become actively misleading. buildHtml() cloned the live document,
//      so the "backup" embedded the Firebase import map and config and would
//      then sit at a file:// origin — where ES modules AND Firebase Auth are
//      both blocked. It produced a file that looked like a backup and could
//      never open.
//   3. The header comment already conceded the saved file "must stay alongside
//      those folders to run" once the app moved to external modules.
//
// Export JSON covers the real need — an offline snapshot you can re-import or
// hand to tools/admin (`board:import` takes exactly this shape).
// ---------------------------------------------------------------------------
import { $, toast } from "./dom.js";
import { S, normalize, markDirty } from "./state.js";
import { canEdit, requireEdit } from "./permissions.js";
import { saveToCloud, boardOpen } from "./sync.js";
import { updateViewButtons } from "./ui/toolbar.js";
import { render } from "./render/index.js";

// Unified save. Everything autosaves as you edit; this is the Cmd/Ctrl+S path
// for people who want to force it.
export async function save() {
  if (!canEdit()) return;              // viewer, or the board is locked
  if (!boardOpen()) { toast("No board is open"); return; }
  return saveToCloud();
}

// --- wiring ---
$("save-btn").addEventListener("click", save);

// Export JSON — a read, deliberately available to everyone including viewers.
$("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(S.state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const name = (S.registry.find((b) => b.id === S.ws.boardId) || {}).name || "gantt";
  a.href = url;
  a.download = name.replace(/[^\w.-]+/g, "-").toLowerCase() + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

// Import JSON — replaces the whole board, so it is a write like any other.
// It was previously CSS-hidden only, with no guard behind it.
$("import-btn").addEventListener("click", () => {
  if (!requireEdit()) return;
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "application/json,.json";
  inp.addEventListener("change", () => {
    const f = inp.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.tasks) throw new Error("that file has no tasks array");
        // Re-check: the file picker is async, so the role or lock could have
        // changed between opening it and choosing a file.
        if (!requireEdit()) return;
        S.state = normalize(data);
        markDirty(); updateViewButtons(); render();
        toast("Imported ✓ — autosaving to this board");
      } catch (err) { toast("Import failed: " + err.message); }
    };
    reader.readAsText(f);
  });
  inp.click();
});
