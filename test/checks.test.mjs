import test from "node:test";
import assert from "node:assert/strict";
import {
  looksLikePrice,
  isNonZeroPrice,
  templateIdFromExpressUrl,
  findPlaceholders,
  verdicts,
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
    },
  };
}

test("verdicts: a fully-passing result is all true", () => {
  assert.deepEqual(verdicts(passingResult()), {
    h1: true, hero: true, price: true, buy: true, placeholders: true,
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

test("verdicts: missing checks degrade to false instead of throwing", () => {
  const allFalse = { h1: false, hero: false, price: false, buy: false, placeholders: false };
  assert.deepEqual(verdicts({ checks: {} }), allFalse);
  assert.deepEqual(verdicts({}), allFalse);
});
