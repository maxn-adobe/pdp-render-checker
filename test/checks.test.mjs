import test from "node:test";
import assert from "node:assert/strict";
import {
  looksLikePrice,
  isNonZeroPrice,
  templateIdFromExpressUrl,
  findPlaceholders,
  isJunkValue,
  verdicts,
  isRetryable,
  parseUrls,
  rowModel,
  selectedColumns,
  CHECK_COLUMNS,
} from "../checks.mjs";
import { config } from "../config.mjs";

test("allowedHostPattern: accepts aem.page/live, stage, and prod express hosts; rejects others", () => {
  const ok = [
    "https://main--da-express-milo--adobecom.aem.page/express/print/business-card/x",
    "https://main--da-express-milo--adobecom.aem.live/express/print/x",
    "https://www.stage.adobe.com/express/print/business-card/x",
    "https://www.adobe.com/express/print/x",
  ];
  const no = [
    "https://www.stage.adobe.com/photoshop/x", // right host, wrong path
    "https://evil.com/express/x",              // wrong host
    "https://www.adobe.com/creativecloud/x",   // wrong path
    "http://www.stage.adobe.com/express/x",    // must be https
  ];
  for (const u of ok) assert.ok(config.allowedHostPattern.test(u), `should allow ${u}`);
  for (const u of no) assert.equal(config.allowedHostPattern.test(u), false, `should reject ${u}`);
});

test("looksLikePrice: accepts real currency strings (any locale)", () => {
  assert.ok(looksLikePrice("$23.15"));
  assert.ok(looksLikePrice("23,15 €"));
  assert.ok(looksLikePrice("$1,000.00"));
  assert.ok(looksLikePrice("$0.00")); // format is valid; isNonZeroPrice handles zero
});

test("looksLikePrice: rejects blanks and non-prices", () => {
  assert.equal(looksLikePrice(""), false);
  assert.equal(looksLikePrice("Free"), false);
  assert.equal(looksLikePrice(null), false);
});

test("isNonZeroPrice: false only when every digit is zero", () => {
  assert.ok(isNonZeroPrice("$23.15"));
  assert.ok(isNonZeroPrice("$0.50"));
  assert.ok(isNonZeroPrice("$1,000.00"));
  assert.equal(isNonZeroPrice("$0.00"), false);
  assert.equal(isNonZeroPrice("0,00 €"), false);
  assert.equal(isNonZeroPrice(""), false);
});

test("templateIdFromExpressUrl: extracts the templateId path segment", () => {
  assert.equal(
    templateIdFromExpressUrl("https://new.express.adobe.com/design/template/abc123?category=templates"),
    "abc123"
  );
  assert.equal(
    templateIdFromExpressUrl("https://new.express.adobe.com/design/template/xyz"),
    "xyz"
  );
  // Deployed route: /design-remix/ with a colon-bearing URN as the id.
  assert.equal(
    templateIdFromExpressUrl(
      "https://new.express.adobe.com/design-remix/template/urn:aaid:sc:VA6C2:71ce7a4d-d693-5dda-99ca-a83c1cc07837"
    ),
    "urn:aaid:sc:VA6C2:71ce7a4d-d693-5dda-99ca-a83c1cc07837"
  );
});

test("templateIdFromExpressUrl: null for unhydrated or non-Express hrefs", () => {
  assert.equal(templateIdFromExpressUrl("#"), null);
  assert.equal(templateIdFromExpressUrl("https://www.zazzle.com/x-256432838073857180"), null);
  assert.equal(templateIdFromExpressUrl(""), null);
  assert.equal(templateIdFromExpressUrl(null), null);
});

test("findPlaceholders: returns unique unresolved tokens from text and attributes", () => {
  assert.deepEqual(findPlaceholders(["hello {{title}} world"]), ["{{title}}"]);
  assert.deepEqual(findPlaceholders(["a {{x}} b", "c {{x}} d", "e {{y}}"]), ["{{x}}", "{{y}}"]);
  assert.deepEqual(findPlaceholders(["https://img/{{path}}.png"]), ["{{path}}"]);
});

test("findPlaceholders: clean content yields an empty array", () => {
  assert.deepEqual(findPlaceholders(["clean text", "also clean", ""]), []);
});

test("isJunkValue: flags leaked internal tokens in any case", () => {
  assert.ok(isJunkValue("none"));
  assert.ok(isJunkValue("NONE"));
  assert.ok(isJunkValue("null"));
  assert.ok(isJunkValue("undefined"));
  assert.ok(isJunkValue("N/A"));
  assert.ok(isJunkValue("n/a"));
});

test("isJunkValue: allows the allowlisted 'None' label and normal values", () => {
  assert.equal(isJunkValue("None"), false); // legitimate envelopes option label
  assert.equal(isJunkValue("Signature Matte"), false);
  assert.equal(isJunkValue("$23.15"), false);
  assert.equal(isJunkValue(""), false);
  assert.equal(isJunkValue(null), false);
});

// ---- verdicts ----
function passingResult() {
  return {
    errors: [],
    checks: {
      h1: { present: true, visible: true, nonEmpty: true },
      hero: { present: true, hasSrc: true, visible: true, decoded: true },
      price: { present: true, visible: true, nonEmpty: true, looksLikePrice: true, nonZero: true },
      buyLink: { present: true, visible: true, hasHref: true, isExpressUrl: true, templateIdMatches: true },
      noPlaceholders: { clean: true, samples: [] },
      options: { applicable: true, values: ["Squared", "Signature Matte"], bad: [] },
      noJunk: { clean: true, samples: [] },
      photos: { present: true, total: 7, decoded: 7, undecoded: [] },
      blocks: { total: 0, broken: [] },
      meta: { hasDescription: true, descriptionOk: true, hasCanonical: true, hasOgTitle: true, hasOgImage: true },
      mobile: { overflowPx: 0, contentOverflowPx: 0, noOverflow: true, elementsOk: true, missing: [] },
      altText: { total: 7, missing: 0, missingSrcs: [] },
      productDetails: { sectionPresent: true, accordionPresent: true, itemCount: 3 },
    },
  };
}

test("verdicts: a fully-passing result is all true", () => {
  assert.deepEqual(verdicts(passingResult()), {
    h1: true, hero: true, price: true, buy: true, placeholders: true,
    options: true, noJunk: true, photos: true, blocks: true,
    meta: true, mobile: true, altText: true, productDetails: true,
  });
});

test("verdicts: a $0.00 price fails the price verdict", () => {
  const r = passingResult();
  r.checks.price.nonZero = false;
  assert.equal(verdicts(r).price, false);
});

test("verdicts: a mismatched templateId fails the buy verdict", () => {
  const r = passingResult();
  r.checks.buyLink.templateIdMatches = false;
  assert.equal(verdicts(r).buy, false);
});

test("verdicts: a leaked placeholder fails the placeholders verdict", () => {
  const r = passingResult();
  r.checks.noPlaceholders = { clean: false, samples: ["{{title}}"] };
  assert.equal(verdicts(r).placeholders, false);
});

test("verdicts: options skip when not applicable but fail on a bad value", () => {
  const skip = passingResult();
  skip.checks.options = { applicable: false, values: [], bad: [] };
  assert.equal(verdicts(skip).options, true);
  const bad = passingResult();
  bad.checks.options = { applicable: true, values: ["none"], bad: ["none"] };
  assert.equal(verdicts(bad).options, false);
});

test("verdicts: a junk field fails noJunk", () => {
  const r = passingResult();
  r.checks.noJunk = { clean: false, samples: ["null"] };
  assert.equal(verdicts(r).noJunk, false);
});

test("verdicts: an undecoded gallery image fails photos", () => {
  const r = passingResult();
  r.checks.photos = { present: true, total: 7, decoded: 6, undecoded: ["Back"] };
  assert.equal(verdicts(r).photos, false);
});

test("verdicts: a broken block fails blocks", () => {
  const r = passingResult();
  r.checks.blocks = { total: 2, broken: ["faq(loading)"] };
  assert.equal(verdicts(r).blocks, false);
});

test("verdicts: missing canonical fails meta", () => {
  const r = passingResult();
  r.checks.meta.hasCanonical = false;
  assert.equal(verdicts(r).meta, false);
});

test("verdicts: a short/duplicated meta description fails meta", () => {
  const r = passingResult();
  r.checks.meta.descriptionOk = false;
  assert.equal(verdicts(r).meta, false);
});

test("verdicts: horizontal overflow fails mobile", () => {
  const r = passingResult();
  r.checks.mobile = { overflowPx: 40, contentOverflowPx: 40, noOverflow: false, elementsOk: true, missing: [] };
  assert.equal(verdicts(r).mobile, false);
});

test("verdicts: overflow from shared global nav only still passes mobile", () => {
  const r = passingResult();
  // Raw page overflow exists (desktop nav overhangs after the resize) but no PDP
  // content overflows, so the check must pass.
  r.checks.mobile = { overflowPx: 44, contentOverflowPx: 0, noOverflow: true, elementsOk: true, missing: [] };
  assert.equal(verdicts(r).mobile, true);
});

test("verdicts: a missing element at mobile width fails mobile", () => {
  const r = passingResult();
  r.checks.mobile = { overflowPx: 0, contentOverflowPx: 0, noOverflow: true, elementsOk: false, missing: ["#pdpx-price-label"] };
  assert.equal(verdicts(r).mobile, false);
});

test("verdicts: a product image without alt fails altText", () => {
  const r = passingResult();
  r.checks.altText = { total: 7, missing: 1, missingSrcs: ["x.png"] };
  assert.equal(verdicts(r).altText, false);
});

test("verdicts: an empty product-details accordion fails productDetails", () => {
  const r = passingResult();
  r.checks.productDetails = { sectionPresent: true, accordionPresent: true, itemCount: 0 };
  assert.equal(verdicts(r).productDetails, false);
});

test("verdicts: a missing product-details section fails productDetails", () => {
  const r = passingResult();
  r.checks.productDetails = { sectionPresent: false, accordionPresent: false, itemCount: 0 };
  assert.equal(verdicts(r).productDetails, false);
});

test("verdicts: missing checks degrade safely (options skips when absent)", () => {
  const empty = {
    h1: false, hero: false, price: false, buy: false, placeholders: false,
    options: true, noJunk: false, photos: false, blocks: false,
    meta: false, mobile: false, altText: false, productDetails: false,
  };
  assert.deepEqual(verdicts({ checks: {} }), empty);
  assert.deepEqual(verdicts({}), empty);
});

// ---- parseUrls ----
test("parseUrls: trims, strips trailing commas, drops comments/blanks, dedupes", () => {
  const input = "https://a.com/1,\nhttps://a.com/2\n# comment\n\n  https://a.com/1  \n";
  assert.deepEqual(parseUrls(input), ["https://a.com/1", "https://a.com/2"]);
});

test("parseUrls: splits on commas and newlines; accepts arrays; empty-safe", () => {
  assert.deepEqual(parseUrls("a,b\nc"), ["a", "b", "c"]);
  assert.deepEqual(parseUrls([" x ", "y", "x"]), ["x", "y"]);
  assert.deepEqual(parseUrls(""), []);
  assert.deepEqual(parseUrls(null), []);
});

// ---- rowModel ----
test("rowModel: a passing result has 13 ok cells and no notes", () => {
  const r = passingResult();
  r.ok = true;
  const m = rowModel(r);
  assert.equal(m.ok, true);
  assert.equal(m.cells.length, 13);
  assert.ok(m.cells.every((c) => c.ok));
  assert.deepEqual(m.notes, []);
});

test("rowModel: mobile overflow yields a plain-language note", () => {
  const r = passingResult();
  r.ok = false;
  r.checks.mobile = { overflowPx: 44, contentOverflowPx: 44, noOverflow: false, elementsOk: true, missing: [] };
  const note = rowModel(r).notes.find((n) => n.startsWith("mobile:"));
  assert.ok(note && note.includes("wider than the phone screen"));
});

test("rowModel: a leaked placeholder yields an un-ok cell and a note", () => {
  const r = passingResult();
  r.ok = false;
  r.checks.noPlaceholders = { clean: false, samples: ["{{title}}"] };
  const m = rowModel(r);
  assert.equal(m.cells.find((c) => c.key === "placeholders").ok, false);
  assert.ok(m.notes.some((n) => n.includes("{{title}}")));
});

test("rowModel: an empty product-details accordion yields an un-ok cell and a note", () => {
  const r = passingResult();
  r.ok = false;
  r.checks.productDetails = { sectionPresent: true, accordionPresent: true, itemCount: 0 };
  const m = rowModel(r);
  assert.equal(m.cells.find((c) => c.key === "productDetails").ok, false);
  assert.ok(m.notes.some((n) => n.startsWith("product details:")));
});

test("rowModel: errors pass through to notes", () => {
  const m = rowModel({ url: "u", ok: false, checks: {}, errors: ["url-not-allowed"] });
  assert.ok(m.notes.includes("url-not-allowed"));
  assert.equal(m.url, "u");
});

// ---- selectedColumns / per-check subset ----
test("selectedColumns: falsy = all; a subset filters to those keys in canonical order", () => {
  assert.equal(selectedColumns(null), CHECK_COLUMNS);
  assert.equal(selectedColumns().length, CHECK_COLUMNS.length);
  assert.deepEqual(selectedColumns(["price", "h1"]).map((c) => c.key), ["h1", "price"]); // canonical order preserved
  assert.deepEqual(selectedColumns(new Set(["productDetails"])).map((c) => c.key), ["productDetails"]);
});

test("rowModel: an enabled subset yields only those cells (skipped checks omitted)", () => {
  const r = passingResult();
  const m = rowModel(r, ["h1", "price"]);
  assert.deepEqual(m.cells.map((c) => c.key), ["h1", "price"]);
  assert.ok(m.cells.every((c) => c.ok));
});

// ---- isRetryable (retry-pass trimming) ----
// Start from a passing result and break exactly what each case needs.
function withChecks(mutate) {
  const r = passingResult();
  mutate(r.checks);
  return r;
}

test("isRetryable: transient errors retry; a disallowed URL does not", () => {
  assert.equal(isRetryable({ errors: ["content-never-injected"], checks: {} }), true);
  assert.equal(isRetryable({ errors: ["render-failed: net::ERR_FOO"], checks: {} }), true);
  assert.equal(isRetryable({ errors: ["url-not-allowed"], checks: {} }), false);
});

test("isRetryable: timing-sensitive check failures are retried", () => {
  assert.equal(isRetryable(withChecks((c) => { c.h1.present = false; })), true);
  assert.equal(isRetryable(withChecks((c) => { c.hero.decoded = false; })), true);
  assert.equal(isRetryable(withChecks((c) => { c.photos.decoded = 3; c.photos.undecoded = ["x"]; })), true);
  assert.equal(isRetryable(withChecks((c) => { c.blocks.broken = ["hero(empty)"]; })), true);
  assert.equal(isRetryable(withChecks((c) => { c.meta.hasDescription = false; })), true);
  assert.equal(isRetryable(withChecks((c) => { c.mobile.noOverflow = false; })), true);
  assert.equal(isRetryable(withChecks((c) => { c.productDetails.itemCount = 0; })), true);
});

test("isRetryable: price/buy/alt retry on a presence failure, skip on a content defect", () => {
  // presence-style failures → transient → retry
  assert.equal(isRetryable(withChecks((c) => { c.price.present = false; c.price.nonEmpty = false; })), true);
  assert.equal(isRetryable(withChecks((c) => { c.buyLink.hasHref = false; })), true);
  assert.equal(isRetryable(withChecks((c) => { c.altText.total = 0; })), true);
  // rendered-but-wrong values → deterministic → skip
  assert.equal(isRetryable(withChecks((c) => { c.price.nonZero = false; })), false); // $0.00
  assert.equal(isRetryable(withChecks((c) => { c.buyLink.templateIdMatches = false; })), false); // wrong URL
  assert.equal(isRetryable(withChecks((c) => { c.altText.missing = 2; c.altText.missingSrcs = ["a", "b"]; })), false);
});

test("isRetryable: pure deterministic content defects are skipped", () => {
  assert.equal(isRetryable(withChecks((c) => { c.noPlaceholders.clean = false; c.noPlaceholders.samples = ["{{x}}"]; })), false);
  assert.equal(isRetryable(withChecks((c) => { c.noJunk.clean = false; c.noJunk.samples = ["null"]; })), false);
  assert.equal(isRetryable(withChecks((c) => { c.options.bad = ["null"]; })), false);
});

test("isRetryable: a transient defect alongside a deterministic one still retries", () => {
  assert.equal(isRetryable(withChecks((c) => { c.noPlaceholders.clean = false; c.hero.decoded = false; })), true);
});

test("isRetryable: absent checks are not mistaken for transient failures", () => {
  assert.equal(isRetryable({ errors: [], checks: { noPlaceholders: { clean: false, samples: ["{{x}}"] } } }), false);
  assert.equal(isRetryable({ errors: [], checks: {} }), false);
  assert.equal(isRetryable(passingResult()), false); // a passing result is never retried
});
