#!/usr/bin/env node
// ---------------------------------------------------------------------------
// UI test harness.
//
// Builds a copy of index.html with the app's main.js swapped for
// tools/ui-test/suite.js, serves the repo, runs headless Chrome against it, and
// collects the assertions the page reports over HTTP. Exits non-zero on any
// failure, so it works as a real test command:
//
//     node tools/ui-test/run.mjs
//
// The suite stubs the Firestore adapter, so this needs no auth, no network and
// no live project.
//
// Why not `--dump-dom --virtual-time-budget`: virtual time fast-forwards timers
// but does NOT drive Firebase's real async initialization, so anything awaiting
// the auth observer never completes inside the budget and looks like a hang.
// Real time plus HTTP reporting avoids that entirely.
//
// No npm dependencies on purpose — the app itself is dependency-free and this
// must not be the thing that changes that.
// ---------------------------------------------------------------------------
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname, extname, normalize as normPath } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CHROME = process.env.CHROME_PATH
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.UI_TEST_PORT || 8899);
const TIMEOUT_MS = Number(process.env.UI_TEST_TIMEOUT || 30000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml"
};

const lines = [];
let done = false;

// --- build the test page ---------------------------------------------------
const html = await readFile(join(ROOT, "index.html"), "utf8");
const TAG = '<script type="module" src="src/main.js"></script>';
if (!html.includes(TAG)) {
  console.error("run.mjs: could not find the main.js script tag in index.html");
  process.exit(1);
}
const page = html.replace(TAG, '<script type="module" src="tools/ui-test/suite.js"></script>');

// --- serve ----------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/report") {
    const m = url.searchParams.get("m") || "";
    if (m === "__DONE__") done = true;
    else { lines.push(m); console.log(m); }
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" }).end(page);
    return;
  }

  // Serve from the repo, refusing to escape it.
  const rel = normPath(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store"
    }).end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, resolve);
});

// --- run Chrome -----------------------------------------------------------
const profile = await mkdtemp(join(tmpdir(), "gantt-ui-test-"));
const chrome = spawn(CHROME, [
  "--headless", "--disable-gpu", "--no-sandbox", "--mute-audio",
  `--user-data-dir=${profile}`,
  `http://localhost:${PORT}/index.html`
], { stdio: "ignore" });

let spawnFailed = null;
chrome.on("error", (err) => { spawnFailed = err; });

const started = Date.now();
while (!done && !spawnFailed && Date.now() - started < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, 150));
}

// Give Chrome a moment to actually exit before removing its profile. Killing
// and immediately unlinking races its own writes and throws ENOTEMPTY, which
// crashed the runner and buried the report.
chrome.kill();
await Promise.race([
  new Promise((r) => chrome.once("exit", r)),
  new Promise((r) => setTimeout(r, 2000))
]);
server.close();
// Cleanup is a courtesy, never a reason to fail the run.
try {
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
} catch (err) {
  console.log(`(could not remove the temp profile ${profile}: ${err.code || err.message})`);
}

// --- report ---------------------------------------------------------------
if (spawnFailed) {
  console.error(`\nCould not start Chrome at:\n  ${CHROME}\nSet CHROME_PATH to override.\n${spawnFailed.message}`);
  process.exit(1);
}

const pass = lines.filter((l) => l.startsWith("PASS")).length;
const fail = lines.filter((l) => l.startsWith("FAIL")).length;

console.log("---");
if (!done) {
  // A suite that stops early looks identical to success if you only count
  // failures, so an unfinished run is always a failure.
  console.log("TIMED OUT before the suite finished — treating as failure");
}
console.log(`PASSES: ${pass}  FAILURES: ${fail}`);
process.exit(fail === 0 && done ? 0 : 1);
