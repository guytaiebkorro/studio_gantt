// ---------------------------------------------------------------------------
// Input validation.
//
// This exists because the Admin SDK bypasses Security Rules. Every constraint
// firestore.rules enforces on clients must be re-enforced here by hand, or the
// CLI becomes the one tool that can write documents the rules consider invalid —
// documents that clients would then be unable to read or repair.
//
// KEEP IN STEP WITH firestore.rules. The specific things mirrored here:
//   - EMAIL_RE is the same regex as isEmail() in the rules. It is deliberately
//     narrower than RFC 5321: a quoted local part may legally contain '/', which
//     is ILLEGAL in a Firestore document id — and the member doc's id IS the
//     email.
//   - MEMBER_KEYS is the exact key set the rules require via hasOnly + hasAll,
//     with nulls explicit rather than fields omitted.
//   - ROLES matches the rules' allowed role values.
// ---------------------------------------------------------------------------

export const ROLES = ["admin", "editor", "viewer"];

// Mirrors isEmail() in firestore.rules.
const EMAIL_RE = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*[.][a-z]{2,}$/;

// Mirrors the hasOnly/hasAll key set on /workspaces/{ws}/members/{email}.
export const MEMBER_KEYS = [
  "email", "role", "uid", "displayName", "invitedBy", "invitedAt", "claimedAt", "protected"
];

// Workspace ids double as URL fragments in share links, so keep them readable.
// The __.*__ exclusion is Firestore's own reserved-id pattern.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function normalizeEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new Error(
      `"${raw}" is not a valid email for this system.\n` +
      "Must be lowercase-able ASCII matching the same pattern firestore.rules enforces:\n" +
      "  " + EMAIL_RE.source
    );
  }
  if (email.length > 320) throw new Error("Email is too long (max 320 chars).");
  return email;
}

export function validateRole(raw) {
  const role = String(raw || "").trim().toLowerCase();
  if (!ROLES.includes(role)) {
    throw new Error(`Invalid role "${raw}". Must be one of: ${ROLES.join(", ")}`);
  }
  return role;
}

export function validateWorkspaceId(raw) {
  const id = String(raw || "").trim();
  if (!SLUG_RE.test(id)) {
    throw new Error(
      `Invalid workspace id "${raw}".\n` +
      "Must be 2-63 chars, lowercase letters/digits/hyphens, starting with a letter or digit."
    );
  }
  if (/^__.*__$/.test(id)) throw new Error("Workspace ids may not match Firestore's reserved __*__ pattern.");
  return id;
}

export function validateWorkspaceName(raw) {
  const name = String(raw || "").trim();
  if (!name) throw new Error("Workspace name cannot be empty.");
  if (name.length > 120) throw new Error("Workspace name is too long (max 120 chars, matching the rules).");
  return name;
}

// Turn a display name into a candidate id: "Korro Studio" -> "korro-studio".
export function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

// The empty board document, byte-identical to what the app builds for a new
// board (see the empty-board literal in src/boards.js).
export function emptyBoard() {
  return { version: 1, settings: { viewMode: "week" }, groups: [], tasks: [] };
}

// Board payloads are stored as a JSON STRING. The rules cap it at 900,000 bytes
// (Firestore's hard document limit is 1 MiB); refuse locally with a message that
// says what to do, rather than letting the write fail opaquely.
export const MAX_BOARD_BYTES = 900000;

export function serializeBoard(board) {
  const json = JSON.stringify(board);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_BOARD_BYTES) {
    throw new Error(
      `Board is ${bytes} bytes, over the ${MAX_BOARD_BYTES} limit. Split it into two boards.`
    );
  }
  return json;
}
