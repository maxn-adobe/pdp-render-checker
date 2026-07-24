import test from "node:test";
import assert from "node:assert/strict";
import {
  looksLikePrice,
  isNonZeroPrice,
  templateIdFromExpressUrl,
  findPlaceholders,
  isJunkValue,
  verdicts,
  parseUrls,
  rowModel,
} from "../checks.mjs";

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
      mobile: { overflowPx: 0, noOverflow: true, elementsOk: true, missing: [] },
      altText: { total: 7, missing: 0, missingSrcs: [] },
    },
  };
}

test("verdicts: a fully-passing result is all true", () => {
  assert.deepEqual(verdicts(passingResult()), {
    h1: true, hero: true, price: true, buy: true, placeholders: true,
    options: true, noJunk: true, photos: true, blocks: true,
    meta: true, mobile: true, altText: true,
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
  r.checks.mobile = { overflowPx: 40, noOverflow: false, elementsOk: true, missing: [] };
  assert.equal(verdicts(r).mobile, false);
});

test("verdicts: a missing element at mobile width fails mobile", () => {
  const r = passingResult();
  r.checks.mobile = { overflowPx: 0, noOverflow: true, elementsOk: false, missing: ["#pdpx-price-label"] };
  assert.equal(verdicts(r).mobile, false);
});

test("verdicts: a product image without alt fails altText", () => {
  const r = passingResult();
  r.checks.altText = { total: 7, missing: 1, missingSrcs: ["x.png"] };
  assert.equal(verdicts(r).altText, false);
});

test("verdicts: missing checks degrade safely (options skips when absent)", () => {
  const empty = {
    h1: false, hero: false, price: false, buy: false, placeholders: false,
    options: true, noJunk: false, photos: false, blocks: false,
    meta: false, mobile: false, altText: false,
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
test("rowModel: a passing result has 12 ok cells and no notes", () => {
  const r = passingResult();
  r.ok = true;
  const m = rowModel(r);
  assert.equal(m.ok, true);
  assert.equal(m.cells.length, 12);
  assert.ok(m.cells.every((c) => c.ok));
  assert.deepEqual(m.notes, []);
});

test("rowModel: a leaked placeholder yields an un-ok cell and a note", () => {
  const r = passingResult();
  r.ok = false;
  r.checks.noPlaceholders = { clean: false, samples: ["{{title}}"] };
  const m = rowModel(r);
  assert.equal(m.cells.find((c) => c.key === "placeholders").ok, false);
  assert.ok(m.notes.some((n) => n.includes("{{title}}")));
});

test("rowModel: errors pass through to notes", () => {
  const m = rowModel({ url: "u", ok: false, checks: {}, errors: ["url-not-allowed"] });
  assert.ok(m.notes.includes("url-not-allowed"));
  assert.equal(m.url, "u");
});
