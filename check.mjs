import { chromium } from "playwright";
import fs from "node:fs";
import { config } from "./config.mjs";
import {
  looksLikePrice,
  isNonZeroPrice,
  templateIdFromExpressUrl,
  findPlaceholders,
  isJunkValue,
  verdicts,
} from "./checks.mjs";

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
          const price = document.querySelector(sel.price);
          return !!(
            h1 &&
            h1.textContent.trim() &&
            img &&
            img.getAttribute("src") &&
            img.complete &&
            img.naturalWidth > 0 &&
            price &&
            price.textContent.trim()
          );
        },
        config.selectors,
        { timeout: config.timeouts.contentInjectedMs }
      )
      .catch(() => result.errors.push("content-never-injected"));

    // ---- H1 (presence only) ----
    const h1 = page.locator(config.selectors.h1).first();
    const h1Count = await page.locator(config.selectors.h1).count();
    const h1Text = h1Count ? ((await h1.textContent()) || "").trim() : "";
    result.checks.h1 = {
      present: h1Count > 0,
      visible: h1Count ? await h1.isVisible() : false,
      nonEmpty: h1Text.length > 0,
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

    // ---- Price ----
    // A blank/$0.00 price is a real defect on a shopping page. nonZero is false
    // only when every digit is 0 (so "$0.50" passes, "$0.00" fails).
    const priceLoc = page.locator(config.selectors.price).first();
    const priceCount = await priceLoc.count();
    const priceText = priceCount ? ((await priceLoc.textContent()) || "").trim() : "";
    result.checks.price = {
      present: priceCount > 0,
      visible: priceCount ? await priceLoc.isVisible() : false,
      nonEmpty: priceText.length > 0,
      looksLikePrice: looksLikePrice(priceText),
      nonZero: isNonZeroPrice(priceText),
    };

    // ---- Buy link (structural only, no network) ----
    // The CTA points at the Adobe Express editor, not Zazzle, and starts as
    // href="#" until hydration. Give it a short beat to populate, then confirm
    // it is a real Express template URL whose templateId matches the page's.
    const buy = page.locator(config.selectors.buyButton).first();
    const buyCount = await buy.count();
    if (buyCount) {
      await page
        .waitForFunction(
          (sel) => {
            const a = document.querySelector(sel.buyButton);
            const h = a && a.getAttribute("href");
            return !!(h && h !== "#");
          },
          config.selectors,
          { timeout: config.timeouts.buyLinkMs }
        )
        .catch(() => {});
    }
    const href = buyCount ? (await buy.getAttribute("href")) || "" : "";
    const hrefTemplateId = templateIdFromExpressUrl(href);
    const pageTemplateId = await page
      .locator(config.selectors.productContainer)
      .first()
      .getAttribute("data-template-id")
      .catch(() => null);
    result.checks.buyLink = {
      present: buyCount > 0,
      visible: buyCount ? await buy.isVisible() : false,
      hasHref: !!href && href !== "#",
      isExpressUrl: !!hrefTemplateId,
      templateIdMatches: !!(hrefTemplateId && pageTemplateId && hrefTemplateId === pageTemplateId),
    };

    // ---- No {{ }} placeholders (page-wide) ----
    // Unresolved Milo authoring tokens leak from surrounding blocks (FAQ/banner/
    // promo), never the PDP island. Scan visible text plus key attributes.
    const scan = await page.evaluate(() => {
      const attrs = [];
      document.querySelectorAll("[src],[href],[alt],[title],meta[content]").forEach((el) => {
        ["src", "href", "alt", "title", "content"].forEach((a) => {
          const val = el.getAttribute(a);
          if (val) attrs.push(val);
        });
      });
      return { text: document.body ? document.body.innerText : "", attrs };
    });
    const placeholderHits = findPlaceholders([scan.text, ...scan.attrs]);
    result.checks.noPlaceholders = {
      clean: placeholderHits.length === 0,
      samples: placeholderHits.slice(0, 10),
    };

    // ---- Options (skip products that have none) ----
    // Deployed options render as pills with a data-title and a selected marker.
    const options = await page.evaluate((sel) => {
      const c = document.querySelector(sel.optionsContainer);
      if (!c) return { present: false, values: [] };
      const values = [];
      c.querySelectorAll("[data-title]").forEach((el) => {
        const selected =
          el.classList.contains("selected") || el.getAttribute("aria-checked") === "true";
        if (selected) values.push((el.getAttribute("data-title") || "").trim());
      });
      c.querySelectorAll("select").forEach((s) => {
        const opt = s.options[s.selectedIndex];
        if (opt) values.push((opt.textContent || "").trim());
      });
      return { present: true, values };
    }, config.selectors);
    const optionValues = options.values;
    result.checks.options = {
      applicable: options.present && optionValues.length > 0,
      values: optionValues,
      bad: optionValues.filter((val) => !val || isJunkValue(val)),
    };

    // ---- No none/null/undefined/N/A junk in filled-in fields ----
    const junkSamples = [h1Text, priceText, ...optionValues].filter((val) => isJunkValue(val));
    result.checks.noJunk = {
      clean: junkSamples.length === 0,
      samples: [...new Set(junkSamples)].slice(0, 10),
    };

    // ---- Rest of the photos load (every image in the product gallery) ----
    // Thumbnails decode a beat after the hero, so wait (bounded) before judging.
    await page
      .waitForFunction(
        (sel) => {
          const imgs = [...document.querySelectorAll(`${sel.imagesContainer} img`)];
          return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
        },
        config.selectors,
        { timeout: config.timeouts.imagesMs }
      )
      .catch(() => {});
    result.checks.photos = await page.evaluate((sel) => {
      const container = document.querySelector(sel.imagesContainer);
      const imgs = [...document.querySelectorAll(`${sel.imagesContainer} img`)];
      const undecoded = imgs
        .filter((i) => !(i.complete && i.naturalWidth > 0))
        .map((i) => i.getAttribute("alt") || i.getAttribute("src") || "(image)");
      return {
        present: !!container,
        total: imgs.length,
        decoded: imgs.length - undecoded.length,
        undecoded: undecoded.slice(0, 10),
      };
    }, config.selectors);

    // ---- All blocks render (generic: any present block must not be broken) ----
    result.checks.blocks = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return { total: 0, broken: [] };
      const els = [...main.querySelectorAll("[data-block-name]")];
      const broken = [];
      els.forEach((b) => {
        const name = b.getAttribute("data-block-name");
        const status = b.getAttribute("data-block-status");
        const empty = b.childElementCount === 0 && !(b.textContent || "").trim();
        if ((status && status !== "loaded") || empty) {
          broken.push(name + (status && status !== "loaded" ? `(${status})` : "(empty)"));
        }
      });
      return { total: els.length, broken: broken.slice(0, 10) };
    });

    // ---- Verdict ----
    const v = verdicts(result);
    result.ok =
      v.h1 &&
      v.hero &&
      v.price &&
      v.buy &&
      v.placeholders &&
      v.options &&
      v.noJunk &&
      v.photos &&
      v.blocks &&
      result.errors.length === 0;
  } catch (e) {
    result.errors.push(`render-failed: ${e.message}`);
  } finally {
    await page.close();
  }
  return result;
}

const mark = (b) => (b ? "✓" : "✗"); // check / cross

function summaryRow(r) {
  const status = r.ok ? "✅ PASS" : "❌ FAIL";
  const v = verdicts(r);
  const c = r.checks;
  const notes = [...r.errors];
  if (!v.placeholders && c.noPlaceholders?.samples?.length) {
    notes.push(`placeholders: ${c.noPlaceholders.samples.join(" ")}`);
  }
  if (!v.noJunk && c.noJunk?.samples?.length) {
    notes.push(`junk: ${c.noJunk.samples.join(" ")}`);
  }
  if (!v.options && c.options?.bad?.length) {
    notes.push(`bad options: ${c.options.bad.join(" ")}`);
  }
  if (!v.photos && c.photos) {
    notes.push(`images ${c.photos.decoded}/${c.photos.total} decoded`);
  }
  if (!v.blocks && c.blocks?.broken?.length) {
    notes.push(`blocks: ${c.blocks.broken.join(" ")}`);
  }
  const cells = [v.h1, v.hero, v.price, v.buy, v.placeholders, v.options, v.noJunk, v.photos, v.blocks];
  return `| ${status} | ${r.url} | ${cells.map(mark).join(" | ")} | ${notes.join(", ")} |`;
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
      `| Result | URL | H1 | Hero | Price | Buy | {{ }} | Options | Junk | Images | Blocks | Notes |`,
      `|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|`,
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
