// Shared validation engine. Imported by both the GitHub Action entrypoint
// (check.mjs) and the local web app (server.mjs) so the two never fork.
import { chromium } from "playwright";
import { config } from "./config.mjs";
import {
  looksLikePrice,
  isNonZeroPrice,
  templateIdFromExpressUrl,
  findPlaceholders,
  isJunkValue,
  verdicts,
} from "./checks.mjs";

export async function checkPage(browser, url, opts = {}) {
  const { captureScreenshotOnFailure = false } = opts;
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

    // ---- Mobile layout (MUST run last — it resizes the viewport) ----
    await page.setViewportSize({ width: config.mobile.width, height: config.mobile.height });
    await page.waitForTimeout(config.timeouts.mobileReflowMs);
    result.checks.mobile = await page.evaluate(
      (cfg) => {
        const de = document.documentElement;
        const overflowPx = de.scrollWidth - de.clientWidth;
        const missing = [];
        cfg.core.forEach((s) => {
          const el = document.querySelector(s);
          const r = el && el.getBoundingClientRect();
          if (!(el && r && r.width > 0 && r.height > 0)) missing.push(s);
        });
        return {
          overflowPx,
          noOverflow: overflowPx <= cfg.tol,
          elementsOk: missing.length === 0,
          missing,
        };
      },
      {
        tol: config.mobile.overflowTolerancePx,
        core: [config.selectors.h1, config.selectors.hero, config.selectors.price],
      }
    );

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
      v.meta &&
      v.mobile &&
      v.altText &&
      result.errors.length === 0;

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
  }
  return result;
}

// Run a batch with bounded concurrency, reusing one browser and recycling it
// periodically (cheap insurance against handle/memory growth on long batches).
// Reports each result via onResult(result, { done, total }); returns all
// results. Output/exit-code concerns belong to the caller, not here.
export async function runChecks({
  urls,
  concurrency = Number(process.env.CONCURRENCY || 3),
  recycleEvery = Number(process.env.RECYCLE_EVERY || 40),
  browserChannel,
  captureScreenshotOnFailure = false,
  onResult,
} = {}) {
  const launchOpts = browserChannel ? { channel: browserChannel } : {};
  const total = urls.length;
  let done = 0;
  let sinceRecycle = 0;
  let browser = await chromium.launch(launchOpts);
  const results = [];
  try {
    for (let i = 0; i < urls.length; i += concurrency) {
      const chunk = urls.slice(i, i + concurrency);
      const chunkResults = await Promise.all(
        chunk.map((u) =>
          checkPage(browser, u, { captureScreenshotOnFailure }).then((r) => {
            done += 1;
            if (onResult) onResult(r, { done, total });
            return r;
          })
        )
      );
      results.push(...chunkResults);
      sinceRecycle += chunk.length;
      if (sinceRecycle >= recycleEvery && done < total) {
        await browser.close();
        browser = await chromium.launch(launchOpts);
        sinceRecycle = 0;
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}
