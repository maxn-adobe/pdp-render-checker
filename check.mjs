import { chromium } from "playwright";
import fs from "node:fs";
import { config } from "./config.mjs";

// Parallel page checks. Tune for runner memory; ~5 is safe on GitHub runners.
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);

// URLs to check, in precedence order:
//   1. CHECK_URLS       (manual run: newline- or comma-separated string)
//   2. CHECK_URLS_JSON  (API run: JSON array of strings from client_payload.urls)
//   3. urls.txt         (committed list; one URL per line; # = comment)
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
  } else if (fs.existsSync("urls.txt")) {
    out.push(...fs.readFileSync("urls.txt", "utf8").split("\n"));
  }
  const urls = out.map((u) => u.trim()).filter((u) => u && !u.startsWith("#"));
  if (!urls.length) {
    throw new Error("No URLs. Provide CHECK_URLS, client_payload.urls, or urls.txt.");
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

async function runAll(browser, urls) {
  const results = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const chunk = urls.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(chunk.map((u) => checkPage(browser, u)))));
  }
  return results;
}

const mark = (b) => (b ? "✓" : "✗"); // check / cross

function writeSummary(results) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const passed = results.filter((r) => r.ok).length;
  const rows = results.map((r) => {
    const h1 = r.checks.h1 || {};
    const hero = r.checks.hero || {};
    const status = r.ok ? "✅ PASS" : "❌ FAIL";
    const h1ok = h1.present && h1.visible && h1.nonEmpty;
    const heroOk = hero.present && hero.visible && hero.decoded;
    const notes = r.errors.length ? r.errors.join(", ") : "";
    return `| ${status} | ${r.url} | ${mark(h1ok)} | ${mark(heroOk)} | ${notes} |`;
  });
  const md = [
    `## PDP render check — ${passed}/${results.length} passed`,
    ``,
    `| Result | URL | H1 | Hero | Notes |`,
    `|---|---|:--:|:--:|---|`,
    ...rows,
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
const browser = await chromium.launch();
let results = [];
try {
  results = await runAll(browser, urls);
} finally {
  await browser.close();
}
writeSummary(results);
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
