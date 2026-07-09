import { chromium } from "playwright";
import fs from "node:fs";
import { config } from "./config.mjs";

// Build the list of pages to check from the environment.
// Single mode:  CHECK_URL (+ optional EXPECTED_TITLE / EXPECTED_HERO)
// Batch mode:   CHECK_TARGETS = JSON array of { url, expected: { title, heroImageUrl } }
function loadTargets() {
  const raw = process.env.CHECK_TARGETS;
  if (raw && raw !== "null") {
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      throw new Error(`CHECK_TARGETS is not valid JSON: ${e.message}`);
    }
    if (Array.isArray(arr) && arr.length) return arr;
  }
  if (process.env.CHECK_URL) {
    return [
      {
        url: process.env.CHECK_URL,
        expected: {
          title: process.env.EXPECTED_TITLE || "",
          heroImageUrl: process.env.EXPECTED_HERO || "",
        },
      },
    ];
  }
  throw new Error(
    "No input. Set CHECK_URL (single) or send client_payload.targets (batch)."
  );
}

async function checkPage(browser, target) {
  const { url } = target;
  const expected = target.expected || {};
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
            img.getAttribute("src")
          );
        },
        config.selectors,
        { timeout: config.timeouts.contentInjectedMs }
      )
      .catch(() => result.errors.push("content-never-injected"));

    // ---- H1 ----
    const h1 = page.locator(config.selectors.h1).first();
    const h1Count = await page.locator(config.selectors.h1).count();
    const h1Text = h1Count ? ((await h1.textContent()) || "").trim() : "";
    result.checks.h1 = {
      present: h1Count > 0,
      nonEmpty: h1Text.length > 0,
      visible: h1Count ? await h1.isVisible() : false,
      matchesExpected: expected.title
        ? h1Text === String(expected.title).trim()
        : null,
      text: h1Text,
    };

    // ---- Hero image ----
    const hero = page.locator(config.selectors.hero).first();
    const heroCount = await hero.count();
    let src = null;
    let decoded = false;
    let visible = false;
    if (heroCount) {
      src = await hero.getAttribute("src");
      visible = await hero.isVisible();
      // naturalWidth > 0 proves the image actually decoded.
      // Catches 404s and lazy-load failures a presence check would miss.
      decoded = await hero.evaluate((img) => img.complete && img.naturalWidth > 0);
    }
    result.checks.hero = {
      present: heroCount > 0,
      hasSrc: !!src,
      decoded,
      visible,
      matchesExpected:
        expected.heroImageUrl && src ? src.includes(expected.heroImageUrl) : null,
      src,
    };

    // ---- Verdict ----
    const c = result.checks;
    const h1ok =
      c.h1.present && c.h1.nonEmpty && c.h1.visible && c.h1.matchesExpected !== false;
    const heroOk =
      c.hero.present &&
      c.hero.decoded &&
      c.hero.visible &&
      c.hero.matchesExpected !== false;
    result.ok = h1ok && heroOk && result.errors.length === 0;
  } catch (e) {
    result.errors.push(`render-failed: ${e.message}`);
  } finally {
    await page.close();
  }
  return result;
}

const mark = (b) => (b ? "\u2713" : "\u2717"); // check / cross

function writeSummary(results) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const passed = results.filter((r) => r.ok).length;
  const rows = results.map((r) => {
    const h1 = r.checks.h1 || {};
    const hero = r.checks.hero || {};
    const status = r.ok ? "\u2705 PASS" : "\u274C FAIL";
    const h1ok = h1.present && h1.nonEmpty && h1.visible && h1.matchesExpected !== false;
    const heroOk =
      hero.present && hero.decoded && hero.visible && hero.matchesExpected !== false;
    const notes = r.errors.length ? r.errors.join(", ") : "";
    return `| ${status} | ${r.url} | ${mark(h1ok)} | ${mark(heroOk)} | ${notes} |`;
  });
  const md = [
    `## PDP render check \u2014 ${passed}/${results.length} passed`,
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
const targets = loadTargets();
const browser = await chromium.launch();
const results = [];
try {
  for (const t of targets) results.push(await checkPage(browser, t));
} finally {
  await browser.close();
}
writeSummary(results);
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
