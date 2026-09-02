// ---------------------------------------------------------------------------
// Share links.
//
// A link now carries NO SECRET. It names a workspace and a board, nothing more:
//
//   https://…/index.html#ws=<workspaceId>&b=<boardId>
//
// Following it grants nothing. The recipient still has to sign in with Google
// and still has to have been invited to that workspace. Permission travels with
// the PERSON — their member document — not with the URL, so one link works for
// everybody and revoking someone doesn't mean re-issuing links to everyone else.
//
// This replaces a link that base64-encoded a JSONBin Master Key into the
// fragment. That key was account-wide and unscopable, which is why the old
// "view-only" link was, in the previous code's own words, an accident guard
// rather than a permission: anyone could read the key out of the URL and write
// directly to the API. There is no view-only link any more because there is no
// need for one — give someone the viewer role and the SERVER enforces it.
//
// Two consequences of carrying no secret, both deliberate:
//   * The fragment is NOT stripped from the address bar. The old token had to be
//     erased on sight so it couldn't be re-shared or resurrected from history;
//     a plain permalink should stay bookmarkable and reloadable instead.
//   * The link is safe in a Slack channel, a ticket, or an email.
// ---------------------------------------------------------------------------
import { toast } from "./dom.js";
import { S } from "./state.js";

// Absolute link to the active workspace + current board. "" when nothing is open.
export function buildShareLink(boardId) {
  if (!S.ws || !S.ws.id) return "";
  const q = new URLSearchParams({ ws: S.ws.id });
  const b = boardId || S.ws.boardId;
  if (b) q.set("b", b);
  return location.href.split("#")[0] + "#" + q.toString();
}

// Read a target workspace/board out of the URL fragment.
// Returns { wsId, boardId } or null.
export function consumeShareTarget() {
  const hash = (location.hash || "").replace(/^#/, "");
  if (!hash) return null;

  // A link from the JSONBin era carries a LIVE CREDENTIAL in the fragment.
  // Scrub it from the address bar and from session history immediately, then
  // refuse it — we cannot honour it, and it must not linger somewhere it could
  // be copied out and used against the old backend.
  if (hash.startsWith("w1.")) {
    stripHash();
    toast("That link is from the old version — ask for a new one");
    return null;
  }

  const p = new URLSearchParams(hash);
  const wsId = p.get("ws");
  if (!wsId) return null;
  return { wsId, boardId: p.get("b") || "" };
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

export async function copyLinkTo(boardId) {
  // No viewOnly check: a viewer may absolutely share a link, because the link
  // confers nothing. Under the old model handing out a link handed out write
  // access, which is why that guard existed.
  const url = buildShareLink(boardId);
  if (!url) { toast("Open a workspace first"); return; }
  const done = () => toast("Link copied — the recipient needs an invite to open it");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      done();
      return;
    }
  } catch (_) { /* fall through */ }
  if (legacyCopy(url)) { done(); return; }
  prompt("Copy this link:", url);
}

// No module-scope wiring: the panel calls copyLinkTo() through its callbacks.
