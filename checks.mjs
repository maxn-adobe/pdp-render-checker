// Pure, side-effect-free check helpers. Kept out of check.mjs (which runs the
// whole checker on import) so they can be unit-tested in isolation. See
// test/checks.test.mjs.

import { config } from "./config.mjs";

// A rendered price must look like a currency amount ("$23.15", "23,15 €", ...).
export function looksLikePrice(text) {
  return config.patterns.price.test((text || "").trim());
}

// nonZero is false only when every digit is 0, so "$0.50" passes but "$0.00"
// fails. A blank or $0.00 price is treated as a real defect (MWPW-198738 P0).
export function isNonZeroPrice(text) {
  return /[1-9]/.test(text || "");
}

// The buy CTA points at the Adobe Express editor. Returns the templateId path
// segment (the product identity), or null if the href isn't an Express URL.
export function templateIdFromExpressUrl(href) {
  const m = (href || "").match(config.patterns.expressTemplateUrl);
  return m ? m[1] : null;
}

// Return the unique unresolved {{ }} placeholder tokens found across the given
// strings (page text + key attribute values). Empty array = clean.
export function findPlaceholders(strings, re = config.patterns.placeholder) {
  const g = new RegExp(re.source, "g");
  const hits = [];
  for (const s of strings) {
    if (!s) continue;
    const found = s.match(g);
    if (found) hits.push(...found);
  }
  return [...new Set(hits)];
}

// A filled-in value is "junk" if it's a leaked internal token (none/null/...),
// in any case, unless it exactly matches an allowlisted real label (e.g. the
// legitimate "None" envelopes option). Blank is handled by the caller.
export function isJunkValue(value) {
  const v = (value == null ? "" : String(value)).trim();
  if (!v) return false;
  if (config.junk.allow.includes(v)) return false;
  return config.junk.tokens.includes(v.toLowerCase());
}

// Fold each check's boolean sub-fields into a single pass/fail per check.
// Used by both the verdict in check.mjs and the summary table, so the AND-logic
// lives in exactly one place.
export function verdicts(r) {
  const c = (r && r.checks) || {};
  return {
    h1: !!(c.h1 && c.h1.present && c.h1.visible && c.h1.nonEmpty),
    hero: !!(c.hero && c.hero.present && c.hero.visible && c.hero.decoded),
    price: !!(
      c.price &&
      c.price.present &&
      c.price.visible &&
      c.price.nonEmpty &&
      c.price.looksLikePrice &&
      c.price.nonZero
    ),
    buy: !!(
      c.buyLink &&
      c.buyLink.present &&
      c.buyLink.visible &&
      c.buyLink.hasHref &&
      c.buyLink.isExpressUrl &&
      c.buyLink.templateIdMatches
    ),
    placeholders: !!(c.noPlaceholders && c.noPlaceholders.clean),
    // Options only apply when the product has them; skip (pass) otherwise.
    options: !(c.options && c.options.applicable) || (c.options.bad || []).length === 0,
    noJunk: !!(c.noJunk && c.noJunk.clean),
    photos: !!(c.photos && c.photos.present && c.photos.total > 0 && c.photos.decoded === c.photos.total),
    // Generic no-error: any block present must not be broken (empty/failed).
    blocks: !!(c.blocks && (c.blocks.broken || []).length === 0),
    meta: !!(
      c.meta &&
      c.meta.hasDescription &&
      c.meta.descriptionOk &&
      c.meta.hasCanonical &&
      c.meta.hasOgTitle &&
      c.meta.hasOgImage
    ),
    mobile: !!(c.mobile && c.mobile.noOverflow && c.mobile.elementsOk),
    altText: !!(c.altText && c.altText.total > 0 && c.altText.missing === 0),
    // The Product Details section must render a non-empty accordion (≥1 item).
    productDetails: !!(c.productDetails && c.productDetails.itemCount > 0),
  };
}

// Clean a raw URL blob (newline- or comma-separated) into a deduped list:
// trim, strip trailing commas (a copy/paste artifact), drop blanks and "#"
// comments. Shared by the CLI/Action loader and the server's input box.
export function parseUrls(text) {
  const lines = Array.isArray(text) ? text : String(text || "").split(/[\n,]/);
  const urls = lines
    .map((u) => u.trim().replace(/,+$/, "").trim())
    .filter((u) => u && !u.startsWith("#"));
  return [...new Set(urls)];
}

// Ordered check columns — the single source of truth for every output format
// (Action markdown table, XLSX, HTML report). Keys match verdicts(); each
// `description` is a plain-language explanation the local web app surfaces when a
// user clicks a column header.
export const CHECK_COLUMNS = [
  { key: "h1", label: "H1", description: "The product title heading is present and not empty." },
  { key: "hero", label: "Hero", description: "The main product image is present and actually renders." },
  { key: "price", label: "Price", description: "A real, non-zero price is shown (fails on a blank or $0.00 price)." },
  { key: "buy", label: "Buy", description: "The buy button links to the correct Adobe Express template for this product." },
  { key: "placeholders", label: "Placeholder", description: "No unfilled template tags (the {{ }} placeholders) leaked onto the page." },
  { key: "options", label: "Options", description: "Product options (size, finish, etc.) show real selected values, not blanks or defaults." },
  { key: "noJunk", label: "Junk", description: "No junk values such as null, undefined, or none appear in the content." },
  { key: "photos", label: "Images", description: "Every gallery photo finished loading — none broken or blank." },
  { key: "blocks", label: "Blocks", description: "All page sections rendered without an error or empty state." },
  { key: "meta", label: "Meta", description: "Required meta tags are present: description, canonical, and social-share (og) tags." },
  { key: "mobile", label: "Mobile", description: "At phone width, the page content fits with no sideways scrolling." },
  { key: "altText", label: "Alt", description: "Every product image has descriptive alt text for accessibility." },
  { key: "productDetails", label: "Product Details", description: "The Product Details section is present and lists at least one item (its accordion isn't empty)." },
];

// Normalize one result into a render-ready row: per-column pass/fail plus the
// human-readable failure notes. Consumed by all three output formatters so the
// column set and notes stay identical across markdown, XLSX, and HTML.
export function rowModel(result) {
  const v = verdicts(result);
  const c = (result && result.checks) || {};
  const cells = CHECK_COLUMNS.map((col) => ({ key: col.key, label: col.label, ok: !!v[col.key] }));
  const notes = [...((result && result.errors) || [])];
  if (!v.placeholders && c.noPlaceholders?.samples?.length) notes.push(`placeholders: ${c.noPlaceholders.samples.join(" ")}`);
  if (!v.noJunk && c.noJunk?.samples?.length) notes.push(`junk: ${c.noJunk.samples.join(" ")}`);
  if (!v.options && c.options?.bad?.length) notes.push(`bad options: ${c.options.bad.join(" ")}`);
  if (!v.photos && c.photos) notes.push(`images ${c.photos.decoded}/${c.photos.total} decoded`);
  if (!v.blocks && c.blocks?.broken?.length) notes.push(`blocks: ${c.blocks.broken.join(" ")}`);
  if (!v.meta && c.meta) {
    const reasons = [];
    if (!c.meta.hasDescription) reasons.push("no-desc");
    else if (!c.meta.descriptionOk) reasons.push("desc-short/dup");
    if (!c.meta.hasCanonical) reasons.push("no-canonical");
    if (!c.meta.hasOgTitle) reasons.push("no-og:title");
    if (!c.meta.hasOgImage) reasons.push("no-og:image");
    notes.push(`meta: ${reasons.join("/")}`);
  }
  if (!v.mobile && c.mobile) {
    const bits = [];
    if (!c.mobile.noOverflow) bits.push("content is wider than the phone screen");
    if (c.mobile.missing?.length) bits.push("some content is missing at phone size");
    notes.push(`mobile: ${bits.join("; ")}`);
  }
  if (!v.altText && c.altText) notes.push(`alt missing: ${c.altText.missing}`);
  if (!v.productDetails && c.productDetails) {
    const why = !c.productDetails.sectionPresent
      ? "no section"
      : !c.productDetails.accordionPresent
        ? "no accordion"
        : "empty (0 items)";
    notes.push(`product details: ${why}`);
  }
  return { url: result?.url, ok: !!(result && result.ok), cells, notes };
}
