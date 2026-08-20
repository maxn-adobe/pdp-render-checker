// Shared validation engine. Imported by both the GitHub Action entrypoint
// (check.mjs) and the local web app (server.mjs) so the two never fork.
import os from "node:os";
import { chromium } from "playwright";
import { config } from "./config.mjs";
import {
  looksLikePrice,
  isNonZeroPrice,
  templateIdFromExpressUrl,
  findPlaceholders,
  isJunkValue,
  verdicts,
  isRetryable,
  CHECK_COLUMNS,
} from "./checks.mjs";

// Optional per-phase profiling, enabled with PDP_PROFILE=1. Zero cost when off.
const PROFILE = process.env.PDP_PROFILE ? new Map() : null;
function recordPhase(label, ms) {
  const a = PROFILE.get(label) || [];
  a.push(ms);
  PROFILE.set(label, a);
}
export function reportProfile() {
  if (!PROFILE || PROFILE.size === 0) return;
  const at = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  console.error("\n[PDP_PROFILE] per-phase ms over n pages (avg / median / p90):");
  for (const [label, arr] of PROFILE) {
    const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    console.error(`  ${label.padEnd(12)} n=${arr.length}  avg=${avg}  med=${Math.round(at(arr, 0.5))}  p90=${Math.round(at(arr, 0.9))}`);
  }
}

export async function checkPage(context, url, opts = {}) {
  const { captureScreenshotOnFailure = false, enabledChecks } = opts;
  // Which of the 13 checks to run (verdict/column keys). Absent = all — the
  // Action/CLI and the back-compat path. A skipped check is neither run nor its
  // (often slow) wait incurred, and it's left out of the verdict below.
  const enabled = enabledChecks ? new Set(enabledChecks) : new Set(CHECK_COLUMNS.map((c) => c.key));
  const run = (key) => enabled.has(key);
  const result = { url, ok: false, checks: {}, errors: [] };

  if (!config.allowedHostPattern.test(url)) {
    result.errors.push("url-not-allowed");
    return result;
  }

  const t0 = PROFILE ? performance.now() : 0;
  let tLast = t0;
  const mark = (label) => {
    if (!PROFILE) return;
    const now = performance.now();
    recordPhase(label, now - tLast);
    tLast = now;
  };

  const page = await context.newPage();
  mark("newPage");
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.timeouts.navigateMs,
    });
    mark("goto");

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
    mark("contentWait");

    // Shared across checks: hoisted so a dependent check still works — with safe
    // empty defaults — when the check that populates it is deselected (noJunk reads
    // all three; meta reads h1Text).
    let h1Text = "";
    let priceText = "";
    let optionValues = [];

    // ---- Core reads: H1, hero image, price — in ONE page.evaluate ----
    // Playwright locator methods (.count/.getAttribute/.isVisible/.evaluate) each
    // cost several CDP round-trips plus actionability retries; under a shared
    // context at concurrency they serialize on the single CDP channel and balloon
    // to seconds per op (see PERF-AUDIT.md). A single page.evaluate is one
    // round-trip and stays in the low-ms range under load. We always read all
    // three (trivial) but only *record* the enabled ones, so per-check selection
    // and the h1Text/priceText hoist are unchanged.
    if (run("h1") || run("hero") || run("price")) {
      const core = await page.evaluate((sel) => {
        // Mirror Playwright's isVisible(): computed visibility must be "visible"
        // and the element must have a non-empty box. (display:none → 0×0 box.)
        const vis = (el) => {
          if (!el) return false;
          if (getComputedStyle(el).visibility !== "visible") return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const h1 = document.querySelector(sel.h1);
        const hero = document.querySelector(sel.hero);
        const price = document.querySelector(sel.price);
        return {
          h1: { present: !!h1, visible: vis(h1), text: h1 ? h1.textContent : "" },
          hero: {
            present: !!hero,
            visible: vis(hero),
            hasSrc: !!(hero && hero.getAttribute("src")),
            // naturalWidth > 0 proves the image actually decoded — catches 404s
            // and lazy-load failures a presence check would miss.
            decoded: !!(hero && hero.complete && hero.naturalWidth > 0),
          },
          price: { present: !!price, visible: vis(price), text: price ? price.textContent : "" },
        };
      }, config.selectors);

      if (run("h1")) {
        h1Text = (core.h1.text || "").trim();
        result.checks.h1 = { present: core.h1.present, visible: core.h1.visible, nonEmpty: h1Text.length > 0 };
      }
      if (run("hero")) {
        result.checks.hero = { present: core.hero.present, hasSrc: core.hero.hasSrc, visible: core.hero.visible, decoded: core.hero.decoded };
      }
      if (run("price")) {
        // A blank/$0.00 price is a real defect on a shopping page. nonZero is false
        // only when every digit is 0 (so "$0.50" passes, "$0.00" fails).
        priceText = (core.price.text || "").trim();
        result.checks.price = {
          present: core.price.present,
          visible: core.price.visible,
          nonEmpty: priceText.length > 0,
          looksLikePrice: looksLikePrice(priceText),
          nonZero: isNonZeroPrice(priceText),
        };
      }
    }

    if (run("buy")) {
      // ---- Buy link (structural only, no network) ----
      // The CTA points at the Adobe Express editor, not Zazzle, and starts as
      // href="#" until hydration. Give it a short beat to populate, then confirm
      // it is a real Express template URL whose templateId matches the page's.
      // Presence first (cheap), so we only wait for hydration when a button exists.
      const buyPresent = await page.evaluate((sel) => !!document.querySelector(sel.buyButton), config.selectors);
      if (buyPresent) {
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
      // Then read href, visibility, and the page's template id in one evaluate.
      // (Replaces locator reads — including a pageTemplateId getAttribute that
      // formerly inherited Playwright's 30s default timeout when the container was
      // absent; querySelector returns null immediately instead.)
      const buy = await page.evaluate((sel) => {
        const vis = (el) => {
          if (!el) return false;
          if (getComputedStyle(el).visibility !== "visible") return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const a = document.querySelector(sel.buyButton);
        const container = document.querySelector(sel.productContainer);
        return {
          present: !!a,
          visible: vis(a),
          href: a ? a.getAttribute("href") || "" : "",
          pageTemplateId: container ? container.getAttribute("data-template-id") : null,
        };
      }, config.selectors);
      const hrefTemplateId = templateIdFromExpressUrl(buy.href);
      result.checks.buyLink = {
        present: buy.present,
        visible: buy.visible,
        hasHref: !!buy.href && buy.href !== "#",
        isExpressUrl: !!hrefTemplateId,
        templateIdMatches: !!(hrefTemplateId && buy.pageTemplateId && hrefTemplateId === buy.pageTemplateId),
      };
    }

    if (run("placeholders")) {
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
    }

    if (run("options")) {
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
      optionValues = options.values;
      result.checks.options = {
        applicable: options.present && optionValues.length > 0,
        values: optionValues,
        bad: optionValues.filter((val) => !val || isJunkValue(val)),
      };
    }

    if (run("noJunk")) {
      // ---- No none/null/undefined/N/A junk in filled-in fields ----
      const junkSamples = [h1Text, priceText, ...optionValues].filter((val) => isJunkValue(val));
      result.checks.noJunk = {
        clean: junkSamples.length === 0,
        samples: [...new Set(junkSamples)].slice(0, 10),
      };
    }
    mark("domReads");

    if (run("photos")) {
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
    }
    mark("imagesWait");

    if (run("blocks")) {
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
    }

    if (run("meta")) {
      // ---- Meta tags ----
      // The description should be a real sentence, not the short spec title (the
      // known regression). The short title isn't in the DOM, so a length floor is
      // the proxy. Also require canonical + core social tags.
      const metaInfo = await page.evaluate(() => {
        const get = (s, a = "content") => {
          const el = document.querySelector(s);
          return el ? el.getAttribute(a) : null;
        };
        return {
          description: get('meta[name="description"]'),
          canonical: get('link[rel="canonical"]', "href"),
          ogTitle: get('meta[property="og:title"]'),
          ogImage: get('meta[property="og:image"]'),
        };
      });
      const metaDesc = (metaInfo.description || "").trim();
      result.checks.meta = {
        hasDescription: metaDesc.length > 0,
        descriptionOk:
          metaDesc.length >= config.meta.descriptionMinLength &&
          metaDesc !== h1Text &&
          findPlaceholders([metaDesc]).length === 0,
        hasCanonical: !!(metaInfo.canonical && metaInfo.canonical.trim()),
        hasOgTitle: !!(metaInfo.ogTitle && metaInfo.ogTitle.trim()),
        hasOgImage: !!(metaInfo.ogImage && metaInfo.ogImage.trim()),
      };
    }

    if (run("altText")) {
      // ---- Image alt text (meaningful product images only) ----
      result.checks.altText = await page.evaluate((sel) => {
        const imgs = [...document.querySelectorAll(sel.altImages)];
        const missing = imgs.filter((i) => !(i.getAttribute("alt") || "").trim());
        return {
          total: imgs.length,
          missing: missing.length,
          missingSrcs: missing.map((i) => i.getAttribute("src") || "(image)").slice(0, 5),
        };
      }, config.selectors);
    }
    mark("postImage");

    if (run("productDetails")) {
      // ---- Product Details (the section's accordion has at least one item) ----
      // Client-rendered a beat after injection (async decorate + a product API
      // call), so wait (bounded) for the first item before judging — mirrors the
      // photos wait. A genuinely-empty accordion waits out the timeout then reports
      // 0, which correctly fails; a populated one short-circuits immediately.
      await page
        .waitForFunction(
          (sel) => {
            const acc = document.querySelector(sel.productDetailsAccordion);
            return !!(acc && acc.querySelectorAll(sel.accordionItem).length);
          },
          config.selectors,
          { timeout: config.timeouts.productDetailsMs }
        )
        .catch(() => {});
      result.checks.productDetails = await page.evaluate((sel) => {
        const section = document.querySelector(sel.productDetailsSection);
        const accordion = section && section.querySelector(sel.productDetailsAccordion);
        const items = accordion ? accordion.querySelectorAll(sel.accordionItem) : [];
        return { sectionPresent: !!section, accordionPresent: !!accordion, itemCount: items.length };
      }, config.selectors);
    }
    mark("productDetails");

    if (run("mobile")) {
      // ---- Mobile layout (MUST run last — it resizes the viewport) ----
      await page.setViewportSize({ width: config.mobile.width, height: config.mobile.height });
      await page.waitForTimeout(config.timeouts.mobileReflowMs);
      result.checks.mobile = await page.evaluate(
        (cfg) => {
          const de = document.documentElement;
          const clientWidth = de.clientWidth;
          // Raw page overflow, kept for diagnostics. The pass/fail below uses only
          // the overflow attributable to PDP *content*: the shared global nav/footer
          // (Milo chrome) can stay in its desktop layout after the viewport shrinks
          // from desktop to phone width and legitimately overhang — that's not a PDP
          // defect, so it's excluded, along with anything an ancestor clips (clipped
          // content can't create a page-level horizontal scrollbar).
          const overflowPx = de.scrollWidth - clientWidth;
          const clips = (v) => v === "hidden" || v === "clip" || v === "auto" || v === "scroll";
          let contentOverflowPx = 0;
          if (overflowPx > cfg.tol) {
            for (const el of document.querySelectorAll("body *")) {
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              const over = Math.max(r.right - clientWidth, -r.left, 0);
              if (over <= cfg.tol) continue;
              if (cfg.chromeSelectors && el.closest(cfg.chromeSelectors)) continue;
              let clipped = false;
              for (let p = el.parentElement; p; p = p.parentElement) {
                const s = getComputedStyle(p);
                if (clips(s.overflowX) || clips(s.overflowY)) { clipped = true; break; }
              }
              if (clipped) continue;
              if (over > contentOverflowPx) contentOverflowPx = over;
            }
          }
          contentOverflowPx = Math.round(contentOverflowPx);
          const missing = [];
          cfg.core.forEach((s) => {
            const el = document.querySelector(s);
            const r = el && el.getBoundingClientRect();
            if (!(el && r && r.width > 0 && r.height > 0)) missing.push(s);
          });
          return {
            overflowPx,
            contentOverflowPx,
            noOverflow: contentOverflowPx <= cfg.tol,
            elementsOk: missing.length === 0,
            missing,
          };
        },
        {
          tol: config.mobile.overflowTolerancePx,
          core: [config.selectors.h1, config.selectors.hero, config.selectors.price],
          chromeSelectors: config.mobile.chromeSelectors,
        }
      );
    }
    mark("mobile");

    // ---- Verdict (over only the checks that ran) ----
    const v = verdicts(result);
    result.ok = [...enabled].every((k) => v[k]) && result.errors.length === 0;

    // Best-effort desktop screenshot of a failing page, for the HTML report.
    // Only on failure (most pages pass), and never fatal if it errors.
    if (captureScreenshotOnFailure && !result.ok) {
      try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.waitForTimeout(200);
        const buf = await page.screenshot({ type: "jpeg", quality: 60 });
        result.screenshot = "data:image/jpeg;base64," + buf.toString("base64");
      } catch {
        // ignore — screenshot is a nice-to-have
      }
    }
  } catch (e) {
    result.errors.push(`render-failed: ${e.message}`);
  } finally {
    await page.close();
    if (PROFILE) recordPhase("total", performance.now() - t0);
  }
  return result;
}

// Run a batch with bounded concurrency, reusing one browser and recycling it
// periodically (cheap insurance against handle/memory growth on long batches).
// Reports each result via onResult(result, { done, total }); returns all
// results. Output/exit-code concerns belong to the caller, not here.
// Headless Chromium's User-Agent contains "HeadlessChrome", which some CDN edges
// (notably Akamai in front of www.adobe.com) reject at the HTTP/2 layer with
// net::ERR_HTTP2_PROTOCOL_ERROR. Derive the browser's real UA and drop that token
// so pages behind such edges load; harmless for hosts that don't care (aem.live).
async function realChromeUserAgent(browser) {
  const page = await browser.newPage();
  try {
    const ua = await page.evaluate(() => navigator.userAgent);
    return ua.replace(/HeadlessChrome/gi, "Chrome");
  } catch {
    return undefined; // fall back to the default UA
  } finally {
    await page.close();
  }
}

// Default concurrency scales to the machine (CPU cores), capped so we don't
// hammer the origin or exhaust RAM. Explicit CONCURRENCY / param overrides it.
export function autoConcurrency() {
  const cores =
    (typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length) || 4;
  return Math.max(1, Math.min(config.perf.maxConcurrency, cores));
}

// Run a batch with a continuous worker pool (no chunk barriers — one slow URL
// never stalls the others). All pages share one BrowserContext so the HTTP cache
// (Adobe/Milo JS, CSS, fonts) is reused across the batch; the browser + context
// are recycled every `recycleEvery` pages to bound memory on large runs. Reports
// each result via onResult(result, { done, total }); returns results in input order.
export async function runChecks({
  urls,
  concurrency = Number(process.env.CONCURRENCY) || autoConcurrency(),
  recycleEvery = Number(process.env.RECYCLE_EVERY) || config.perf.recycleEvery,
  retries = process.env.RETRIES != null ? Number(process.env.RETRIES) : config.perf.retries,
  retryConcurrency = Number(process.env.RETRY_CONCURRENCY) || config.perf.retryConcurrency,
  browserChannel,
  captureScreenshotOnFailure = false,
  enabledChecks,
  onResult,
} = {}) {
  const launchOpts = browserChannel ? { channel: browserChannel } : {};
  const total = urls.length;
  const results = new Array(total);
  let done = 0;

  let browser = await chromium.launch(launchOpts);
  let ua = await realChromeUserAgent(browser);
  let context = await browser.newContext(ua ? { userAgent: ua } : {});

  // Worker pool over a set of URL indices at the given concurrency. On the first
  // pass it records every result; on retry passes it only upgrades a recovered
  // failure (a still-failing page keeps its original result + diagnostics).
  const runPool = async (indices, poolSize, attempt) => {
    let cursor = 0;
    const worker = async () => {
      for (let k = cursor++; k < indices.length; k = cursor++) {
        const idx = indices[k];
        const r = await checkPage(context, urls[idx], { captureScreenshotOnFailure, enabledChecks });
        if (attempt === 1) {
          results[idx] = r;
          done += 1;
          if (onResult) onResult(r, { index: idx, done, total, attempt });
        } else if (r.ok) {
          results[idx] = r;
          if (onResult) onResult(r, { index: idx, done, total, attempt });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(poolSize, indices.length) }, worker));
  };

  try {
    // First pass in generations of `recycleEvery`, recycling between them so
    // memory stays bounded even over thousands of URLs.
    for (let genStart = 0; genStart < total; genStart += recycleEvery) {
      const genEnd = Math.min(genStart + recycleEvery, total);
      const indices = [];
      for (let i = genStart; i < genEnd; i++) indices.push(i);
      await runPool(indices, concurrency, 1);

      if (genEnd < total) {
        await context.close();
        await browser.close();
        browser = await chromium.launch(launchOpts);
        ua = await realChromeUserAgent(browser);
        context = await browser.newContext(ua ? { userAgent: ua } : {});
      }
    }

    // Retry passes: re-check failures to recover the contention-induced false
    // failures a fast first pass can produce. Only retry failures that could
    // plausibly be transient (isRetryable) — deterministic content defects fail
    // identically on retry, so re-rendering them is wasted work.
    for (let attempt = 2; attempt <= 1 + retries; attempt++) {
      const failed = [];
      for (let i = 0; i < total; i++) if (results[i] && !results[i].ok && isRetryable(results[i])) failed.push(i);
      if (!failed.length) break;
      await runPool(failed, retryConcurrency, attempt);
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  reportProfile();
  return results;
}
