// Output formatters for a results array. Consumed by the local server (and
// usable anywhere). All three reuse rowModel/CHECK_COLUMNS from checks.mjs so
// the columns and failure notes stay identical to the Action's markdown table.
import ExcelJS from "exceljs";
import { CHECK_COLUMNS, rowModel } from "./checks.mjs";

const FILL_GREEN = "FFDDF5DD";
const FILL_RED = "FFF8D7DA";
const FILL_HEAD = "FFEDEDED";

// Color-coded XLSX: a "Summary" sheet (row per URL, pass/fail cells) plus a
// "Details" sheet with every check sub-field flattened. Returns a Buffer.
export async function buildXlsx(results) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "pdp-render-checker";
  wb.created = new Date();

  const ws = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  const headers = ["Result", "URL", ...CHECK_COLUMNS.map((c) => c.label), "Notes"];
  const headRow = ws.addRow(headers);
  headRow.font = { bold: true };
  headRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL_HEAD } };
  });

  const paint = (row, idx, ok) => {
    row.getCell(idx).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: ok ? FILL_GREEN : FILL_RED },
    };
  };
  for (const r of results) {
    const m = rowModel(r);
    const row = ws.addRow([
      m.ok ? "PASS" : "FAIL",
      m.url,
      ...m.cells.map((c) => (c.ok ? "PASS" : "FAIL")),
      m.notes.join("; "),
    ]);
    paint(row, 1, m.ok);
    m.cells.forEach((c, i) => paint(row, 3 + i, c.ok));
  }

  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 72;
  CHECK_COLUMNS.forEach((c, i) => (ws.getColumn(3 + i).width = Math.max(6, c.label.length + 2)));
  ws.getColumn(headers.length).width = 48;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  const ds = wb.addWorksheet("Details");
  ds.addRow(["URL", "Check", "Field", "Value"]).font = { bold: true };
  ds.getColumn(1).width = 72;
  ds.getColumn(4).width = 60;
  for (const r of results) {
    for (const [check, obj] of Object.entries(r.checks || {})) {
      if (obj && typeof obj === "object") {
        for (const [field, val] of Object.entries(obj)) {
          ds.addRow([r.url, check, field, Array.isArray(val) ? val.join(" ") : String(val)]);
        }
      }
    }
    if (r.errors?.length) ds.addRow([r.url, "errors", "", r.errors.join("; ")]);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// Lightweight CSV (no dependency) with the same columns as the XLSX summary.
export function buildCsv(results) {
  const esc = (s) => {
    let v = String(s == null ? "" : s);
    // Neutralize spreadsheet formula injection: a cell starting with =, +, -, @
    // (or a control char) can execute when opened in Excel/Sheets. Prefix "'".
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = [["Result", "URL", ...CHECK_COLUMNS.map((c) => c.label), "Notes"].map(esc).join(",")];
  for (const r of results) {
    const m = rowModel(r);
    lines.push(
      [m.ok ? "PASS" : "FAIL", m.url, ...m.cells.map((c) => (c.ok ? "PASS" : "FAIL")), m.notes.join("; ")]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\n");
}

const REPORT_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; }
header h1 { margin: 0 0 4px; font-size: 20px; }
.stats { margin: 0 0 16px; color: #666; }
.controls { display: flex; gap: 16px; align-items: center; margin-bottom: 12px; }
.controls input[type=search] { padding: 6px 10px; min-width: 280px; border: 1px solid #ccc; border-radius: 6px; }
table.grid { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { border-bottom: 1px solid #e2e2e2; padding: 6px 8px; text-align: left; vertical-align: top; }
th.sortable { cursor: pointer; user-select: none; }
th.chk, td.chk { text-align: center; }
td.status { font-weight: 700; }
tr.fail td.status { color: #b3261e; }
tr.pass td.status { color: #1a7f37; }
td.chk.ok { color: #1a7f37; }
td.chk.no { color: #b3261e; font-weight: 700; }
td.url { max-width: 620px; overflow-wrap: anywhere; }
td.notes { color: #8a5a00; max-width: 360px; overflow-wrap: anywhere; }
tbody tr:not(.detail) { cursor: pointer; }
tbody tr:not(.detail):hover { background: rgba(0,0,0,0.04); }
tr.detail td { background: rgba(0,0,0,0.03); }
.detailwrap { display: flex; gap: 20px; flex-wrap: wrap; padding: 8px 4px; }
.shot { max-width: 420px; max-height: 320px; border: 1px solid #ccc; border-radius: 6px; }
.checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; flex: 1; }
.checkbox { border: 1px solid #e2e2e2; border-radius: 6px; padding: 6px 8px; }
.ck { font-weight: 700; margin-bottom: 4px; }
.kv { font-size: 12px; }
.kk { color: #666; }
.count { color: #666; margin-top: 10px; }
`;

// Self-contained interactive report. The client code below uses only quotes and
// string concatenation (no backticks, no ${...}) so it embeds safely inside this
// template literal, and builds the DOM with textContent (no innerHTML for data).
const REPORT_CLIENT_JS = `
(function () {
  var D = window.__PDP__ || { rows: [] };
  var rows = D.rows;
  for (var i = 0; i < rows.length; i++) rows[i]._i = i;
  var cols = rows.length ? rows[0].cells.map(function (c) { return c.label; }) : [];
  var state = { q: "", failOnly: false, sortKey: "_i", dir: 1, open: {} };
  var app = document.getElementById("app");
  var qInput = document.getElementById("q");
  var failChk = document.getElementById("failOnly");
  qInput.addEventListener("input", function () { state.q = qInput.value; draw(); });
  failChk.addEventListener("change", function () { state.failOnly = failChk.checked; draw(); });

  function cell(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function filteredSorted() {
    var q = state.q.toLowerCase();
    var out = rows.filter(function (r) {
      if (state.failOnly && r.ok) return false;
      if (q && String(r.url).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    out.sort(function (a, b) {
      var av, bv;
      if (state.sortKey === "status") { av = a.ok ? 1 : 0; bv = b.ok ? 1 : 0; }
      else if (state.sortKey === "url") { av = String(a.url); bv = String(b.url); }
      else { av = a._i; bv = b._i; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return 0;
    });
    return out;
  }
  function setSort(key) {
    if (state.sortKey === key) state.dir = -state.dir;
    else { state.sortKey = key; state.dir = 1; }
    draw();
  }
  function toggle(i) { state.open[i] = !state.open[i]; draw(); }
  function detail(r) {
    var wrap = cell("div", "detailwrap");
    if (r.screenshot) {
      var img = document.createElement("img");
      img.className = "shot"; img.src = r.screenshot; img.alt = "page screenshot";
      wrap.appendChild(img);
    }
    var grid = cell("div", "checks");
    var checks = r.checks || {};
    Object.keys(checks).forEach(function (k) {
      var box = cell("div", "checkbox");
      box.appendChild(cell("div", "ck", k));
      var obj = checks[k];
      if (obj && typeof obj === "object") {
        Object.keys(obj).forEach(function (f) {
          var val = obj[f];
          var line = cell("div", "kv");
          line.appendChild(cell("span", "kk", f + ": "));
          line.appendChild(cell("span", "vv", Array.isArray(val) ? val.join(" ") : String(val)));
          box.appendChild(line);
        });
      }
      grid.appendChild(box);
    });
    wrap.appendChild(grid);
    return wrap;
  }
  function draw() {
    while (app.firstChild) app.removeChild(app.firstChild);
    var table = cell("table", "grid");
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    var thS = cell("th", "sortable", "Result"); thS.addEventListener("click", function () { setSort("status"); });
    var thU = cell("th", "sortable", "URL"); thU.addEventListener("click", function () { setSort("url"); });
    htr.appendChild(thS); htr.appendChild(thU);
    cols.forEach(function (label) { htr.appendChild(cell("th", "chk", label)); });
    htr.appendChild(cell("th", null, "Notes"));
    thead.appendChild(htr); table.appendChild(thead);
    var tbody = document.createElement("tbody");
    var list = filteredSorted();
    list.forEach(function (r) {
      var tr = cell("tr", r.ok ? "pass" : "fail");
      tr.appendChild(cell("td", "status", r.ok ? "PASS" : "FAIL"));
      var tdUrl = cell("td", "url");
      var a = cell("a", null, r.url);
      a.href = r.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      tdUrl.appendChild(a);
      tr.appendChild(tdUrl);
      r.cells.forEach(function (c) { tr.appendChild(cell("td", "chk " + (c.ok ? "ok" : "no"), c.ok ? "\\u2713" : "\\u2717")); });
      tr.appendChild(cell("td", "notes", (r.notes || []).join(", ")));
      tr.addEventListener("click", function (ev) { if (ev.target.tagName === "A") return; toggle(r._i); });
      tbody.appendChild(tr);
      if (state.open[r._i]) {
        var dtr = cell("tr", "detail");
        var dtd = document.createElement("td");
        dtd.colSpan = cols.length + 3;
        dtd.appendChild(detail(r));
        dtr.appendChild(dtd);
        tbody.appendChild(dtr);
      }
    });
    table.appendChild(tbody);
    app.appendChild(table);
    app.appendChild(cell("p", "count", list.length + " of " + rows.length + " shown"));
  }
  draw();
})();
`;

// Self-contained interactive HTML report string (embeds results + screenshots).
export function buildHtmlReport(results) {
  const rows = results.map((r) => {
    const m = rowModel(r);
    return { url: m.url, ok: m.ok, cells: m.cells, notes: m.notes, checks: r.checks || {}, screenshot: r.screenshot || null };
  });
  const passed = rows.filter((r) => r.ok).length;
  const total = rows.length;
  const generatedAt = new Date().toISOString();
  // Escape "<" so an embedded "</script>" or "<" in page data can't break out.
  const dataJson = JSON.stringify({ rows }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDP render check report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header>
  <h1>PDP render check</h1>
  <p class="stats"><strong>${passed}/${total}</strong> passed &middot; generated ${generatedAt}</p>
</header>
<div class="controls">
  <input id="q" type="search" placeholder="Filter by URL…" autocomplete="off">
  <label><input id="failOnly" type="checkbox"> Failures only</label>
</div>
<main id="app"></main>
<script>window.__PDP__ = ${dataJson};</script>
<script>${REPORT_CLIENT_JS}</script>
</body>
</html>`;
}
