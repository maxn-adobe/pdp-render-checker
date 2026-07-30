// Local web app. Boots a loopback HTTP server, serves the UI, runs the shared
// engine against a pasted/uploaded URL list, streams progress over SSE, and
// writes an XLSX + HTML + CSV report per run. Launched by "PDP Checker.command"
// or `npm start`. Uses the user's installed Google Chrome by default.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";
import { parseUrls, rowModel } from "./checks.mjs";
import { runChecks } from "./engine.mjs";
import { buildXlsx, buildCsv, buildHtmlReport } from "./report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const RUNS = path.join(__dirname, "runs");
// System Chrome by default (no browser download); set PDP_BROWSER_CHANNEL="" to
// force Playwright's bundled Chromium (used as an automatic fallback too).
const CHANNEL = process.env.PDP_BROWSER_CHANNEL ?? "chrome";

const DOWNLOADS = {
  "report.html": "text/html; charset=utf-8",
  "report.csv": "text/csv; charset=utf-8",
  "report.xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const runs = new Map(); // runId -> { results, total, done, error, artifacts, listeners:Set<res> }

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Ready-to-render row for the live UI: pass/fail cells + notes (from rowModel)
// plus the raw checks and screenshot for the drill-down panel.
function toView(r) {
  const m = rowModel(r);
  return { url: m.url, ok: m.ok, cells: m.cells, notes: m.notes, checks: r.checks || {}, screenshot: r.screenshot || null };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) req.destroy(); // ~5MB cap
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function generateArtifacts(runId, results) {
  const dir = path.join(RUNS, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.html"), buildHtmlReport(results));
  fs.writeFileSync(path.join(dir, "report.csv"), buildCsv(results));
  fs.writeFileSync(path.join(dir, "report.xlsx"), await buildXlsx(results));
  return {
    html: `/download/${runId}/report.html`,
    csv: `/download/${runId}/report.csv`,
    xlsx: `/download/${runId}/report.xlsx`,
  };
}

function startRun(urls, concurrency) {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const run = { results: [], total: urls.length, done: false, error: null, artifacts: null, listeners: new Set() };
  runs.set(runId, run);

  (async () => {
    const onResult = (r, { done, total }) => {
      run.results.push(r);
      for (const res of run.listeners) sse(res, "result", { r: toView(r), done, total });
    };
    const opts = { urls, concurrency, captureScreenshotOnFailure: true, onResult };
    let results;
    try {
      results = await runChecks({ ...opts, browserChannel: CHANNEL || undefined });
    } catch (e) {
      // Most likely: Google Chrome isn't installed. Fall back to bundled Chromium.
      if (CHANNEL) {
        try {
          run.results.length = 0; // avoid duplicate replayed rows on fallback
          results = await runChecks({ ...opts, browserChannel: undefined });
        } catch (e2) {
          run.error = `Could not launch a browser (${e2.message}). Install Google Chrome and try again.`;
        }
      } else {
        run.error = `Could not launch a browser: ${e.message}`;
      }
    }

    if (run.error) {
      run.done = true;
      for (const res of run.listeners) {
        sse(res, "error", { message: run.error });
        res.end();
      }
      return;
    }

    run.artifacts = await generateArtifacts(runId, results);
    run.done = true;
    const passed = results.filter((r) => r.ok).length;
    for (const res of run.listeners) {
      sse(res, "done", { passed, total: results.length, artifacts: run.artifacts });
      res.end();
    }
  })();

  return runId;
}

function serveFile(res, filePath, type) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "content-type": type });
    res.end(buf);
  });
}

async function handleRun(req, res) {
  const body = await readBody(req);
  let data;
  try {
    data = JSON.parse(body || "{}");
  } catch {
    data = {};
  }
  const all = parseUrls(data.urls || "");
  const allowed = all.filter((u) => config.allowedHostPattern.test(u));
  const skipped = all.filter((u) => !config.allowedHostPattern.test(u));
  if (!allowed.length) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "No allowed URLs to check.", skipped }));
  }
  const concurrency = Math.max(1, Math.min(10, Number(data.concurrency) || 3));
  const runId = startRun(allowed, concurrency);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ runId, total: allowed.length, skipped }));
}

function handleProgress(req, res, runId) {
  const run = runs.get(runId);
  if (!run) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Replay anything already collected (client may connect after results start).
  run.results.forEach((r, i) => sse(res, "result", { r: toView(r), done: i + 1, total: run.total }));
  if (run.done) {
    if (run.error) sse(res, "error", { message: run.error });
    else sse(res, "done", { passed: run.results.filter((r) => r.ok).length, total: run.results.length, artifacts: run.artifacts });
    return res.end();
  }
  run.listeners.add(res);
  req.on("close", () => run.listeners.delete(res));
}

function handleDownload(res, pathname) {
  const [, , runId, file] = pathname.split("/"); // /download/<runId>/<file>
  if (!/^[0-9TZ.\-]+$/.test(runId || "") || !DOWNLOADS[file]) {
    res.writeHead(404);
    return res.end();
  }
  const filePath = path.join(RUNS, runId, file);
  if (!filePath.startsWith(RUNS + path.sep) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end();
  }
  // The HTML report should open in the browser; spreadsheets should download.
  const disposition = file === "report.html" ? "inline" : "attachment";
  res.writeHead(200, {
    "content-type": DOWNLOADS[file],
    "content-disposition": `${disposition}; filename="${file}"`,
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && pathname === "/") {
      return serveFile(res, path.join(PUBLIC, "index.html"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && pathname === "/info") {
      // Which build is running: process.arch is arm64 for the Apple Silicon
      // bundle, x64 for the Intel bundle (even under Rosetta).
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ arch: process.arch, platform: process.platform, node: process.version }));
    }
    if (req.method === "POST" && pathname === "/run") return await handleRun(req, res);
    if (req.method === "GET" && pathname.startsWith("/progress/")) {
      return handleProgress(req, res, decodeURIComponent(pathname.slice("/progress/".length)));
    }
    if (req.method === "GET" && pathname.startsWith("/download/")) return handleDownload(res, pathname);
    res.writeHead(404);
    res.end("Not found");
  } catch (e) {
    res.writeHead(500);
    res.end(`Error: ${e.message}`);
  }
});

// Bind to loopback only (never expose the checker on the network). Port 0 asks
// the OS for a free port; the launcher reads the printed URL to open a browser.
const PORT = Number(process.env.PORT) || 0;
server.listen(PORT, "127.0.0.1", () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  console.log(`PDP_CHECKER_URL=${url}`);
  console.log(`PDP render checker is running at ${url}  (press Ctrl-C to stop)`);
});
