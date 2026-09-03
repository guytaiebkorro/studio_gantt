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

// Copy any text, reporting whether it worked rather than announcing it — the
// caller owns the wording, because "link copied" and "invite sent, link copied"
// are not the same sentence.
//
// CALL THIS SYNCHRONOUSLY FROM THE EVENT HANDLER. The body runs as far as
// navigator.clipboard.writeText() before it awaits anything, which is what
// keeps the write inside the click's user activation. Safari rejects a
// clipboard write that isn't, so `await something(); copyText(x)` fails there
// and nowhere else.
export async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through */ }
  // The async Clipboard API needs a secure context (https / localhost). Over
  // plain http the app still works, so fall back to the legacy path.
  return legacyCopy(text);
}

export async function copyLinkTo(boardId) {
  // No viewOnly check: a viewer may absolutely share a link, because the link
  // confers nothing. Under the old model handing out a link handed out write
  // access, which is why that guard existed.
  const url = buildShareLink(boardId);
  if (!url) { toast("Open a workspace first"); return; }
  if (await copyText(url)) {
    toast("Link copied — the recipient needs an invite to open it");
    return;
  }
  prompt("Copy this link:", url);
}

// --- inviting someone ------------------------------------------------------
//
// Adding a member document grants access but tells the person NOTHING; there
// is no server-side mail anywhere in this app. So the invite is delivered by
// the inviter, from their own mailbox, with the link in the body — see
// docs/plans/2026-09-03-invite-delivery-options.md for why that beats building
// a mail pipeline for this.
//
// PURE, and exported for that reason: composing the message is the part worth
// asserting on, and it is testable without a mail client or a clipboard.
const ROLE_ARTICLE = { admin: "an", editor: "an", viewer: "a" };

export function buildInviteMailto({ email, role, workspace, link }) {
  const ws = workspace || "a workspace";
  const withRole = role ? ` as ${ROLE_ARTICLE[role] || "a"} ${role}` : "";
  const subject = `You've been added to ${ws} on Korro Gantt`;
  const body = [
    `I've added you to ${ws} on Korro Gantt${withRole}.`,
    "",
    "Open it here:",
    link || "",
    "",
    // The one thing worth saying, because it is the one thing that goes wrong:
    // access is keyed by the exact address, and Gmail dot-aliases make it easy
    // to sign in as an address that was never invited.
    `Sign in with Google using ${email} — access is granted per address, so it has to be that exact one.`
  ].join("\r\n");
  // The address stays raw: it is validated before we get here, and a '+' in a
  // mailto PATH is a literal plus. Percent-encoding it would be harmless but
  // makes the draft's To: field unreadable in some clients.
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Hand off to the OS mail handler.
//
// A real anchor, clicked, rather than `location.href = url`. Both work — mailto
// is not a popup, so no blocker is involved and the page never navigates — but
// a click is OBSERVABLE and CANCELLABLE. That is what lets the test suite
// assert a draft was composed, by catching the click in the capture phase and
// calling preventDefault(), instead of firing a mailto: at whatever machine is
// running the tests.
export function openMail(url) {
  if (!url) return false;
  const a = document.createElement("a");
  a.href = url;
  a.style.display = "none";
  document.body.appendChild(a);
  // Dispatch is synchronous, so any listener has already run by the time this
  // returns and the element is safe to take straight back out.
  a.click();
  a.remove();
  return true;
}

// No module-scope wiring: the panel calls copyLinkTo() through its callbacks.
