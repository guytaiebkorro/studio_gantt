// ---------------------------------------------------------------------------
// Inline SVG icon set (rounded line style, 24px grid). Icons inherit the text
// color via currentColor so they follow both themes automatically.
//
// Static markup in index.html embeds the same SVGs directly; this module is
// for the buttons whose icon JS swaps at runtime (theme, lock).
// ---------------------------------------------------------------------------

const wrap = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  refresh: wrap(`<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>`),
  sun: wrap(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`),
  moon: wrap(`<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`),
  lock: wrap(`<rect x="3" y="11" width="18" height="11" rx="3"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`),
  unlock: wrap(`<rect x="3" y="11" width="18" height="11" rx="3"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>`),
  cloud: wrap(`<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>`),
  plus: wrap(`<path d="M12 5v14M5 12h14"/>`),
  check: wrap(`<path d="M20 6 9 17l-5-5"/>`)
};

export function icon(name) { return ICONS[name] || ""; }
