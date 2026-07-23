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
  };
}
