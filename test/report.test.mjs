import test from "node:test";
import assert from "node:assert/strict";
import { buildCsv, buildXlsx, buildHtmlReport } from "../report.mjs";
import { config } from "../config.mjs";

function sample() {
  return [
    { url: "https://ex/1", ok: true, checks: { price: { present: true } }, errors: [] },
    {
      url: "https://ex/2",
      ok: false,
      checks: { noPlaceholders: { clean: false, samples: ["{{x}}"] } },
      errors: ["render-failed: <boom>"],
      screenshot: "data:image/jpeg;base64,AAAA",
    },
  ];
}

test("buildCsv: header + one PASS/FAIL row per result", () => {
  const lines = buildCsv(sample()).split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("Result,URL,"));
  assert.ok(lines[1].startsWith("PASS,https://ex/1,"));
  assert.ok(lines[2].startsWith("FAIL,https://ex/2,"));
});

test("buildCsv: honors a column subset (header + rows show only selected checks)", () => {
  const csv = buildCsv(sample(), ["h1", "price"]);
  const header = csv.split("\n")[0];
  assert.equal(header, "Result,URL,H1,Price,Notes"); // only the two selected check columns
  assert.equal(csv.split("\n").length, 3); // header + 2 rows, unchanged
});

test("buildCsv: neutralizes spreadsheet formula-injection prefixes", () => {
  const csv = buildCsv([
    { url: "https://ex/1", ok: false, checks: {}, errors: ["=cmd|calc"] },
  ]);
  const noteField = csv.split("\n")[1];
  assert.ok(noteField.includes("'=cmd|calc")); // leading "=" defused with a quote
  assert.ok(!/,=cmd/.test(noteField)); // never a raw leading "="
});

test("buildHtmlReport: self-contained doc, embeds data + screenshot, escapes '<'", () => {
  const html = buildHtmlReport(sample());
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("window.__PDP__ ="));
  assert.ok(html.includes("<strong>1/2</strong>"));
  assert.ok(html.includes("data:image/jpeg;base64,AAAA"));
  // the "<" inside error text must be escaped in the embedded JSON, not raw
  assert.ok(html.includes("render-failed: \\u003cboom>"));
  assert.ok(!html.includes("render-failed: <boom>"));
});

test("buildHtmlReport: omits inline screenshots above the threshold (large runs)", () => {
  const n = config.report.maxInlineScreenshots + 1;
  const results = Array.from({ length: n }, (_, i) => ({
    url: `https://ex/${i}`,
    ok: false,
    checks: {},
    errors: [],
    screenshot: "data:image/jpeg;base64,ZZZZ",
  }));
  const html = buildHtmlReport(results);
  assert.ok(html.startsWith("<!doctype html>")); // still a valid, self-contained doc
  assert.ok(!html.includes("data:image/jpeg;base64,ZZZZ")); // screenshots dropped
  assert.ok(html.includes("screenshots omitted")); // and the header says so
});

test("buildXlsx: returns a non-empty xlsx (zip) Buffer", async () => {
  const buf = await buildXlsx(sample());
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 0);
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK"); // xlsx = zip
});
