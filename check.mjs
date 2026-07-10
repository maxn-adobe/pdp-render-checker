import { chromium } from "playwright";
import fs from "node:fs";
import { config } from "./config.mjs";

// Parallel page checks. Measured locally: concurrency 3 is reliable (0 spurious
// failures, ~2.3x faster than serial); 4-5 caused real content-never-injected
// failures under contention, not just slowness. Re-validate if raising this.
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

// URLs to check, in precedence order:
//   1. CHECK_URLS       (manual run: newline- or comma-separated string)
//   2. CHECK_URLS_JSON  (API run: JSON array of strings from client_payload.urls)
//   3. URLS_FILE        (manual run: named committed file, e.g. "urls_2.txt")
//   4. urls.txt         (default committed list; one URL per line; # = comment)
function loadUrls() {
  const out = [];
  if (process.env.CHECK_URLS && process.env.CHECK_URLS.trim()) {
    out.push(...process.env.CHECK_URLS.split(/[\n,]/));
  } else if (process.env.CHECK_URLS_JSON && process.env.CHECK_URLS_JSON !== "null") {
    let arr;
    try {
      arr = JSON.parse(process.env.CHECK_URLS_JSON);
    } catch (e) {
      throw new Error(`CHECK_URLS_JSON is not valid JSON: ${e.message}`);
    }
    if (Array.isArray(arr)) out.push(...arr);
  } else {
    const file = (process.env.URLS_FILE && process.env.URLS_FILE.trim()) || "urls.txt";
    if (fs.existsSync(file)) out.push(...fs.readFileSync(file, "utf8").split("\n"));
  }
  // Trailing commas are a common copy/paste artifact (e.g. a file with one
  // "url()," per line) — strip them so they don't end up appended to the URL.
  const urls = out
    .map((u) => u.trim().replace(/,+$/, "").trim())
    .filter((u) => u && !u.startsWith("#"));
  if (!urls.length) {
    throw new Error("No URLs. Provide CHECK_URLS, client_payload.urls, URLS_FILE, or urls.txt.");
  }
  return [...new Set(urls)];
}

async function checkPage(browser, url) {
  const result = { url, ok: false, checks: {}, errors: [] };

  if (!config.allowedHostPattern.test(url)) {
    result.errors.push("url-not-allowed");
    return result;
  }

  const page = await browser.newPage();
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigateMs,
    });

    // Wait for the client-side Zazzle call to inject the content we validate.
    // Waits for the image to actually finish decoding (not just get a `src`) —
    // Zazzle's hero image is served from a rendering endpoint that responds a
    // couple seconds after injection, so checking naturalWidth too early is a
    // false failure, not a real pipeline bug.
    // A timeout here is itself a caught pipeline bug (the page never populated).
    await page
      .waitForFunction(
        (sel) => {
          const h1 = document.querySelector(sel.h1);
          const img = document.querySelector(sel.hero);
          return !!(
            h1 &&
            h1.textContent.trim() &&
            img &&
            img.getAttribute("src") &&
            img.complete &&
            img.naturalWidth > 0
          );
        },
        config.selectors,
        { timeout: config.timeouts.contentInjectedMs }
      )
      .catch(() => result.errors.push("content-never-injected"));

    // ---- H1 (presence only) ----
    const h1 = page.locator(config.selectors.h1).first();
    const h1Count = await page.locator(config.selectors.h1).count();
    result.checks.h1 = {
      present: h1Count > 0,
      visible: h1Count ? await h1.isVisible() : false,
      nonEmpty: h1Count ? ((await h1.textContent()) || "").trim().length > 0 : false,
    };

    // ---- Hero image (presence only) ----
    const hero = page.locator(config.selectors.hero).first();
    const heroCount = await hero.count();
    let hasSrc = false;
    let visible = false;
    let decoded = false;
    if (heroCount) {
      hasSrc = !!(await hero.getAttribute("src"));
      visible = await hero.isVisible();
      // naturalWidth > 0 proves the image actually decoded.
      // Catches 404s and lazy-load failures a presence check would miss.
      decoded = await hero.evaluate((img) => img.complete && img.naturalWidth > 0);
    }
    result.checks.hero = { present: heroCount > 0, hasSrc, visible, decoded };

    // ---- Verdict ----
    const c = result.checks;
    const h1ok = c.h1.present && c.h1.visible && c.h1.nonEmpty;
    const heroOk = c.hero.present && c.hero.visible && c.hero.decoded;
    result.ok = h1ok && heroOk && result.errors.length === 0;
  } catch (e) {
    result.errors.push(`render-failed: ${e.message}`);
  } finally {
    await page.close();
  }
  return result;
}

const mark = (b) => (b ? "✓" : "✗"); // check / cross

function summaryRow(r) {
  const h1 = r.checks.h1 || {};
  const hero = r.checks.hero || {};
  const status = r.ok ? "✅ PASS" : "❌ FAIL";
  const h1ok = h1.present && h1.visible && h1.nonEmpty;
  const heroOk = hero.present && hero.visible && hero.decoded;
  const notes = r.errors.length ? r.errors.join(", ") : "";
  return `| ${status} | ${r.url} | ${mark(h1ok)} | ${mark(heroOk)} | ${notes} |`;
}

// Written incrementally (one row per completed URL, flushed synchronously) so
// that a killed/timed-out run still leaves a partial summary instead of none.
function startSummary() {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  fs.appendFileSync(
    path,
    [`## PDP render check`, ``, `| Result | URL | H1 | Hero | Notes |`, `|---|---|:--:|:--:|---|`, ``].join("\n")
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

// Periodically recycle the browser on long batches — cheap insurance against
// unbounded memory/handle growth in a single long-lived Chromium process.
// (Note: a locally-observed failure spike partway through a 298-URL batch
// persisted even with recycling and even at CONCURRENCY=1, so that specific
// pattern was network-environment noise, not something this alone fixes — see
// README "Known limitations of local testing".)
const RECYCLE_EVERY = Number(process.env.RECYCLE_EVERY || 40);

async function runAll(urls) {
  const total = urls.length;
  let done = 0;
  let sinceRecycle = 0;
  let browser = await chromium.launch();
  const results = [];
  try {
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const chunk = urls.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map((u) =>
          checkPage(browser, u).then((r) => {
            done += 1;
            console.log(`[${done}/${total}] ${mark(r.ok)} ${r.url}`);
            appendSummaryRow(r);
            return r;
          })
        )
      );
      results.push(...chunkResults);
      sinceRecycle += chunk.length;
      if (sinceRecycle >= RECYCLE_EVERY && done < total) {
        await browser.close();
        browser = await chromium.launch();
        sinceRecycle = 0;
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

// ---- main ----
const urls = loadUrls();
startSummary();
const results = await runAll(urls);
finishSummary(results);
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
