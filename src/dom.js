// ---------------------------------------------------------------------------
// DOM helpers and cached element references.
//
// These run after the document is parsed (modules are deferred), so it's safe
// to look elements up at module-evaluation time.
// ---------------------------------------------------------------------------

export const $ = (id) => document.getElementById(id);

// Frequently-used element refs, captured once.
export const listInner   = $("list-inner");
export const listBody    = $("list-body");
export const chartPane   = $("chart-pane");
export const chartHeader = $("chart-header");
export const chartBody   = $("chart-body");
export const depSvg      = $("dep-svg");
export const todayLine   = $("today-line");

// Escape text for safe insertion into innerHTML.
export function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Transient bottom toast. Pass actionLabel + actionFn to show an inline button
// (e.g. "Undo"); those toasts linger longer.
let toastTimer = null;
export function toast(msg, actionLabel, actionFn) {
  const t = $("toast");
  t.innerHTML = "";
  t.appendChild(document.createTextNode(msg));
  if (actionLabel && actionFn) {
    const b = document.createElement("button");
    b.className = "toast-btn"; b.textContent = actionLabel;
    b.addEventListener("click", () => { actionFn(); t.classList.remove("show"); });
    t.appendChild(b);
  }
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), actionLabel ? 6000 : 2600);
}
