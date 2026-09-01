// ---------------------------------------------------------------------------
// Share links.
//
// A share link carries the workspace's credential in the URL fragment, so
// opening it drops the recipient straight into the board with nothing to paste:
//
//   https://…/index.html#w1.<base64url({ k, r, b, n })>
//
//   k = credential   r = registry id   b = board to open   n = workspace name
//
// The FRAGMENT, not a query string: fragments are never sent to the server, so
// the key stays out of hosting logs and Referer headers. It is also stripped
// from the address bar the moment it's read (see consumeShareToken).
//
// Carrying r and b is what makes the link instant — the recipient skips the
// bin-listing discovery pass and lands on the same board the sender was on.
//
// This is a bearer link, and the UI says so plainly: a JSONBin Master Key is
// account-wide and cannot be scoped, so whoever holds the link has full
// read/write/delete on every board in the workspace. base64url is encoding for
// URL safety — NOT encryption.
// ---------------------------------------------------------------------------
import { DEFAULT_WORKSPACE_NAME } from "./config.js";
import { $, toast } from "./dom.js";
import { S } from "./state.js";

const PREFIX = "w1."; // version tag — bump if the payload shape changes

// --- base64url <-> JSON (via UTF-8: keys are ASCII, workspace names aren't) ---
function encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(token) {
  let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Absolute link to the active workspace + current board. "" when there's
// nothing to share yet.
export function buildShareLink() {
  if (!S.cloud || !S.cloud.apiKey) return "";
  const payload = {
    k: S.cloud.apiKey,
    r: S.cloud.registryId || "",
    b: S.cloud.binId || "",
    n: S.workspaceName || DEFAULT_WORKSPACE_NAME
  };
  return location.href.split("#")[0] + "#" + PREFIX + encode(payload);
}

// Read a share token out of the URL and remove it from the address bar in the
// same breath, so it can't be re-shared from the location field or resurrected
// from session history. Returns the target workspace, or null when there's no
// token (or it's damaged, which is reported to the user).
export function consumeShareToken() {
  const hash = (location.hash || "").replace(/^#/, "");
  if (!hash.startsWith(PREFIX)) return null;
  stripHash();
  try {
    const p = decode(hash.slice(PREFIX.length));
    if (!p || typeof p.k !== "string" || !p.k) throw new Error("no credential");
    return { apiKey: p.k, registryId: p.r || "", binId: p.b || "", name: p.n || DEFAULT_WORKSPACE_NAME };
  } catch (_) {
    toast("That share link is damaged — ask for a new one");
    return null;
  }
}

function stripHash() {
  // replaceState leaves no history entry and triggers no reload. It throws on
  // some file:// pages, where clearing the hash directly is the fallback.
  try { history.replaceState(null, "", location.pathname + location.search); }
  catch (_) { try { location.hash = ""; } catch (_) {} }
}

// --- copy to clipboard ---

// The async Clipboard API needs a secure context (https / localhost). Over
// plain http the app still works, so fall back to the legacy path and then to a
// prompt the user can copy out of by hand.
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed; top:-1000px; opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) {}
  ta.remove();
  return ok;
}

async function copyShareLink() {
  if (S.cloudGate) { toast("Connect to a workspace first"); return; }
  const url = buildShareLink();
  if (!url) { toast("Connect to a workspace first"); return; }
  const done = () => toast("Share link copied — it carries the workspace key, so treat it like a password");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      done();
      return;
    }
  } catch (_) { /* fall through */ }
  if (legacyCopy(url)) { done(); return; }
  prompt("Copy this share link (it carries the workspace key):", url);
}

// --- wiring ---
$("c-share").addEventListener("click", () => { copyShareLink(); });
