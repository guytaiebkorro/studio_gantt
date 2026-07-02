// ---------------------------------------------------------------------------
// Theme toggle (warm cream light <-> cozy dark), remembered in localStorage.
//
// The inline <head> script already applied the saved theme before first paint
// to avoid a flash; here we just sync the button label and handle clicks.
// ---------------------------------------------------------------------------
import { THEME_KEY } from "./config.js";
import { $ } from "./dom.js";
import { icon } from "./icons.js";

export function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function applyTheme(t) {
  if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  $("theme-btn").innerHTML = icon(t === "dark" ? "moon" : "sun");
  $("theme-btn").title = t === "dark" ? "Switch to light theme" : "Switch to dark (cozy) theme";
  try { localStorage.setItem(THEME_KEY, t); } catch (_) {}
}

// Wire the toggle button and sync to whatever the <head> script set.
export function setupTheme() {
  $("theme-btn").addEventListener("click", () => applyTheme(currentTheme() === "light" ? "dark" : "light"));
  applyTheme(currentTheme());
}
