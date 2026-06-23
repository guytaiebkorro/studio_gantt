// ---------------------------------------------------------------------------
// Theme toggle (dark cyberpunk <-> clean light), remembered in localStorage.
//
// The inline <head> script already applied the saved theme before first paint
// to avoid a flash; here we just sync the button label and handle clicks.
// ---------------------------------------------------------------------------
import { THEME_KEY } from "./config.js";
import { $ } from "./dom.js";

export function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function applyTheme(t) {
  if (t === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  $("theme-btn").textContent = t === "light" ? "☀" : "🌙";
  $("theme-btn").title = t === "light" ? "Switch to dark (hacker) theme" : "Switch to light theme";
  try { localStorage.setItem(THEME_KEY, t); } catch (_) {}
}

// Wire the toggle button and sync to whatever the <head> script set.
export function setupTheme() {
  $("theme-btn").addEventListener("click", () => applyTheme(currentTheme() === "light" ? "dark" : "light"));
  applyTheme(currentTheme());
}
