// GitHub Action / CLI entrypoint. The validation logic lives in engine.mjs
// (shared with the local web app); this file only wires the batch to the
// Action's output: an incremental job-summary table, console progress, and an
// exit code. Run: `node check.mjs` (see .github/workflows/pdp-check.yml).
import fs from "node:fs";
import { rowModel, parseUrls } from "./checks.mjs";
import { runChecks } from "./engine.mjs";

// URLs to check, in precedence order:
//   1. CHECK_URLS       (manual run: newline- or comma-separated string)
//   2. CHECK_URLS_JSON  (API run: JSON array of strings from client_payload.urls)
//   3. URLS_FILE        (manual run: named committed file, e.g. "urls_2.txt")
//   4. urls.txt         (default committed list; one URL per line; # = comment)
function loadUrls() {
  let raw = "";
  if (process.env.CHECK_URLS && process.env.CHECK_URLS.trim()) {
    raw = process.env.CHECK_URLS;
  } else if (process.env.CHECK_URLS_JSON && process.env.CHECK_URLS_JSON !== "null") {
    let arr;
    try {
      arr = JSON.parse(process.env.CHECK_URLS_JSON);
    } catch (e) {
      throw new Error(`CHECK_URLS_JSON is not valid JSON: ${e.message}`);
    }
    raw = Array.isArray(arr) ? arr.join("\n") : "";
  } else {
    const file = (process.env.URLS_FILE && process.env.URLS_FILE.trim()) || "urls.txt";
    raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }
  const urls = parseUrls(raw);
  if (!urls.length) {
    throw new Error("No URLs. Provide CHECK_URLS, client_payload.urls, URLS_FILE, or urls.txt.");
  }
  return urls;
}

const mark = (b) => (b ? "✓" : "✗"); // check / cross

function summaryRow(r) {
  const m = rowModel(r);
  const status = m.ok ? "✅ PASS" : "❌ FAIL";
  return `| ${status} | ${m.url} | ${m.cells.map((c) => mark(c.ok)).join(" | ")} | ${m.notes.join(", ")} |`;
}

// Written incrementally (one row per completed URL, flushed synchronously) so
// that a killed/timed-out run still leaves a partial summary instead of none.
function startSummary() {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  fs.appendFileSync(
    path,
    [
      `## PDP render check`,
      ``,
      `| Result | URL | H1 | Hero | Price | Buy | {{ }} | Options | Junk | Images | Blocks | Meta | Mobile | Alt | Notes |`,
      `|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|`,
      ``,
    ].join("\n")
  );
}

function appendSummaryRow(r) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  fs.appendFileSync(path, summaryRow(r) + "\n");
}

function finishSummary(results) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const passed = results.filter((r) => r.ok).length;
  const md = [
    ``,
    `**${passed}/${results.length} passed**`,
    ``,
    `<details><summary>Full JSON</summary>`,
    ``,
    "```json",
    JSON.stringify(results, null, 2),
    "```",
    ``,
    `</details>`,
    ``,
  ].join("\n");
  fs.appendFileSync(path, md);
}

// ---- main ----
const urls = loadUrls();
startSummary();
const results = await runChecks({
  urls,
  onResult: (r, { done, total }) => {
    console.log(`[${done}/${total}] ${mark(r.ok)} ${r.url}`);
    appendSummaryRow(r);
  },
});
finishSummary(results);
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
