#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Screenshot tool. Serves the repo with src/main.js swapped for driver.js,
// drives one surface into view, and photographs it in both themes:
//
//     node tools/ui-test/shot.mjs                 # everything, into .tmp-shots/
//     node tools/ui-test/shot.mjs gate            # just the named surfaces
//
// This exists because "it looks good" is not a claim anyone should make from
// reading CSS. The PNGs are the evidence.
//
// THE LOAD-EVENT HOLD. Chrome's --screenshot fires when the page load event
// does, which is long before an async driver has finished building anything.
// Rather than guess at a delay, the served page carries a hidden <img> whose
// response this server holds open until the driver reports /ready. The load
// event therefore cannot fire until the surface is up, and the screenshot
// lands on a finished page. A watchdog releases the hold anyway after
// READY_TIMEOUT so a broken driver produces a wrong picture rather than a hang.
//
// No npm dependencies, same as run.mjs — the app is dependency-free and the
// tooling must not be the thing that changes that.
// ---------------------------------------------------------------------------
import { createServer } from "node:http";
import { readFile, mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname, extname, normalize as normPath } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(ROOT, ".tmp-shots");
const CHROME = process.env.CHROME_PATH
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.SHOT_PORT || 8897);
const WIDTH = Number(process.env.SHOT_WIDTH || 1440);
const HEIGHT = Number(process.env.SHOT_HEIGHT || 900);
const READY_TIMEOUT = 12000;
const SHOT_TIMEOUT = 30000;

// The surfaces driver.js knows how to build.
const SURFACES = ["gate", "gateEmpty", "invite"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : SURFACES;
for (const s of wanted) {
  if (!SURFACES.includes(s)) {
    console.error(`shot.mjs: unknown surface ${JSON.stringify(s)}. Known: ${SURFACES.join(", ")}`);
    process.exit(1);
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml"
};

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

// --- build the page --------------------------------------------------------
const html = await readFile(join(ROOT, "index.html"), "utf8");
const TAG = '<script type="module" src="src/main.js"></script>';
if (!html.includes(TAG)) {
  console.error("shot.mjs: could not find the main.js script tag in index.html");
  process.exit(1);
}

function pageFor(theme) {
  let p = html.replace(TAG,
    '<script type="module" src="tools/ui-test/driver.js"></script>' +
    // The hold. Hidden, and its response is what gates the load event.
    '<img src="/__hold.png" alt="" style="position:fixed;width:1px;height:1px;opacity:0;pointer-events:none">');
  // Stamp the theme straight onto <html>. The inline <head> script only ever
  // ADDS data-theme for a saved "dark", so this survives it untouched.
  if (theme === "dark") p = p.replace("<html lang=\"en\">", "<html lang=\"en\" data-theme=\"dark\">");
  return p;
}

// --- serve -----------------------------------------------------------------
let held = [];            // open responses for /__hold.png
let releaseTimer = null;

function release(why) {
  clearTimeout(releaseTimer);
  const n = held.length;
  for (const res of held) res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }).end(PIXEL);
  held = [];
  if (n && why) console.log(`  ${why}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/__hold.png") {
    held.push(res);
    return;                                   // deliberately left open
  }
  if (url.pathname === "/ready") {
    release("ready");
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" })
       .end(pageFor(url.searchParams.get("theme")));
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

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// --- shoot -----------------------------------------------------------------
let failures = 0;

for (const surface of wanted) {
  for (const theme of ["light", "dark"]) {
    const name = `${surface}-${theme}.png`;
    const out = join(OUT, name);
    const profile = await mkdtemp(join(tmpdir(), "gantt-shot-"));

    releaseTimer = setTimeout(
      () => release(`WARNING: ${name} — driver never reported ready in ${READY_TIMEOUT}ms; shooting anyway`),
      READY_TIMEOUT
    );

    const chrome = spawn(CHROME, [
      "--headless", "--disable-gpu", "--no-sandbox", "--mute-audio",
      "--hide-scrollbars",
      `--window-size=${WIDTH},${HEIGHT}`,
      `--screenshot=${out}`,
      `--user-data-dir=${profile}`,
      `http://localhost:${PORT}/index.html?theme=${theme}&shot=${surface}`
    ], { stdio: "ignore" });

    const code = await Promise.race([
      new Promise((r) => chrome.on("exit", r)).catch(() => -1),
      new Promise((r) => setTimeout(() => { chrome.kill(); r("timeout"); }, SHOT_TIMEOUT))
    ]);

    release();                                 // never leave a socket dangling
    await rm(profile, { recursive: true, force: true }).catch(() => {});

    let ok = false;
    try { ok = (await readFile(out)).length > 1024; } catch { /* missing */ }
    if (ok) console.log(`  ✓ ${name}`);
    else { failures++; console.error(`  ✗ ${name} (chrome exit ${code})`); }
  }
}

server.close();

const made = await readdir(OUT).catch(() => []);
console.log(`\n${made.length} shot(s) in ${OUT}`);
if (failures) { console.error(`${failures} failed`); process.exit(1); }
