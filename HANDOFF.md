# PDP Render Checker — Handoff & Development Guide

> **For the next developer / agent (VSCode or Claude Code):** This repo contains a
> working v1 of a GitHub Actions tool that renders Adobe Express product detail
> pages (PDPs) in a headless browser and checks that key elements appear. Your
> immediate job is the three changes in **§7 (Next tasks)** — reference
> implementations are included there. Read §2 first so you don't undo deliberate
> decisions. The v1 code described in §3 is what's in the repo now; the §7 changes
> are NOT yet applied.

---

## 1. Purpose

Adobe Express is generating a large catalog of **product detail pages (PDPs)** on
AEM Edge Delivery Services (EDS), authored through Document Authoring (DA) in the
`adobecom/da-express-milo` repo. Each PDP's real content (the product title / H1
and the hero product image) is **not** in the page source — the source document
holds only a product ID, and client-side JavaScript calls the **Zazzle partner
API** at page load to fetch the title, hero image URL, etc., then injects them
into the DOM.

This tool exists to **catch client-side pipeline bugs**: cases where the page
fails to render those elements even though the underlying data is fine. It loads
each page in a real headless browser (Playwright + Chromium), waits for the
Zazzle-driven injection to happen, and asserts that the expected elements are
present and rendered.

---

## 2. Background & key decisions (do not undo these without reason)

The design went through several dead ends before landing here. The important
conclusions:

- **Static fetches don't work for these pages.** Fetching the page HTML
  server-side (e.g. `.plain.html` or the DA source) returns only the product ID,
  not the Zazzle-injected title/image. AEM normally server-renders canonical
  content, but these PDPs are the documented exception (content comes from a
  runtime service lookup). **A headless browser is required.**

- **Do not validate by replaying the Zazzle API server-side.** The Zazzle data is
  already fetched and validated *before* page generation, upstream of this tool.
  Re-checking the API would be redundant and, more importantly, would not catch
  render/pipeline failures. The whole point of this tool is to verify the
  *rendered page*, not the data. (This is why §7 Task B removes value-matching.)

- **Wait on the injected content itself, not on network idle or a framework
  flag.** The check waits until the target elements actually appear in the DOM.
  If that wait times out, that timeout *is* a caught bug (the page never
  populated).

- **Why GitHub Actions (and not other hosts):**
  - Adobe I/O Runtime / App Builder **cannot** run headless Chromium — blocking
    web actions are hard-capped at 60s and action memory tops out around 1 GB,
    and there is no supported browser runtime. It can only serve as a thin API
    layer, not the renderer.
  - Cloudflare Browser Rendering was the first choice but a Cloudflare account
    could not be created with the corporate identity, so it was ruled out.
  - Adobe **Ethos** (internal Kubernetes/container PaaS) is the right long-term
    home for a containerized version with a synchronous endpoint, but requires
    team onboarding / a namespace (see §9).
  - **GitHub Actions** was chosen to start: zero new accounts, already sanctioned
    (the org already lives in `adobecom` GitHub), Chromium runs fine on the
    runners, and it's triggerable manually, via CLI, and via API. The Playwright
    logic here ports directly to an Ethos container later (it uses standard
    `playwright`, not the Cloudflare fork).

- **Host allowlist is intentional.** The tool only renders URLs matching an
  allowlist pattern (see `config.mjs`) to prevent it being pointed at arbitrary
  sites. Keep this.

- **`.aem.live` vs `.aem.page`.** v1 targets published `.aem.live` URLs (public,
  no auth). Pre-publish validation of `.aem.page` is possible but needs preview
  auth injected into the browser context — deferred (see §9).

---

## 3. What the tool currently does (v1, in the repo now)

- Input: a single URL via the manual `workflow_dispatch` input, OR a batch via
  `repository_dispatch` `client_payload.targets` (a JSON array of
  `{ url, expected }` objects). (§7 Task A reworks this into a cleaner list-first
  model.)
- For each page: launches Chromium, navigates, waits for the target elements to
  be injected, then asserts.
- **Current assertions (to be simplified in §7 Task B):**
  - H1: present, non-empty, visible, and — if an expected title was supplied — an
    exact text match (`matchesExpected`).
  - Hero image: present, has `src`, decoded (`naturalWidth > 0`), visible, and —
    if an expected hero URL was supplied — a substring match.
- Selectors are currently **generic fallbacks** (`h1`, `.marquee/.hero` image) —
  §7 Task C replaces them with the exact element IDs.
- Output: a pass/fail summary table plus full JSON in the Actions run summary;
  the run exits non-zero (red) if any page fails.

---

## 4. Repository layout

```
pdp-render-checker/
├── .github/workflows/pdp-check.yml   # trigger + CI (checkout, node, playwright, run)
├── check.mjs                         # the engine: load targets, render, assert, summarize
├── config.mjs                        # tunables: host allowlist, selectors, timeouts
├── package.json                      # playwright dependency + `npm run check`
├── urls.txt                          # (ADD in Task A) committed list of URLs to check
├── README.md
├── .gitignore
└── HANDOFF.md                        # this document
```

Roles:
- **`config.mjs`** — the only file you normally tune (selectors, allowlist, timeouts).
- **`check.mjs`** — reads its input from environment variables set by the workflow,
  runs the checks, writes `GITHUB_STEP_SUMMARY`, exits 0/1.
- **`pdp-check.yml`** — defines how the job is triggered and wires inputs into env
  vars for `check.mjs`.

---

## 5. How it runs

Three triggers, one workflow:

1. **Manual (dashboard):** Actions tab → "PDP Render Check" → Run workflow.
2. **CLI:** `gh workflow run pdp-check.yml -f url="https://..."` (v1) — becomes
   `-f urls="..."` after Task A.
3. **API (for the DA tool):** `POST /repos/<owner>/pdp-render-checker/dispatches`
   with `event_type: "pdp-check"` and a `client_payload` (needs a token with
   `repo` scope). Results land in the run summary; Actions is asynchronous, so a
   caller wanting the result must poll the run or the tool must post it back
   (see §9).

---

## 6. Local development

```bash
npm install
npx playwright install --with-deps chromium

# single URL
CHECK_URL="https://main--da-express-milo--adobecom.aem.live/<path>" npm run check

# after Task A (list from urls.txt, or inline):
CHECK_URLS="https://.../a
https://.../b" npm run check
```

Node 20 is used in CI; any recent LTS is fine locally. `check.mjs` is ESM (`.mjs`).

---

## 7. Next tasks (the requested changes)

Apply all three. A consolidated **reference implementation** of `config.mjs`,
`check.mjs`, and the workflow after all three changes is given at the end of this
section — you can apply those directly, then test and tune.

### Task A — Check many URLs at once (list-first, parallel)

**Goal:** the tool should take a list of URLs and check them all in one run.

**Design:**
- Primary input: a committed **`urls.txt`** (one URL per line; lines starting with
  `#` are comments). Authors maintain the list in the repo.
- Also support: a manual `workflow_dispatch` input `urls` (newline- or
  comma-separated string) and an API `client_payload.urls` (JSON array of
  strings). Precedence: manual input → API array → `urls.txt`.
- Since Task B removes value-matching, inputs are now just **URL strings** (no
  more `{ url, expected }` objects).
- **Run pages in parallel with a bounded concurrency** (default ~5) so large
  lists finish quickly without exhausting runner memory. Reuse one browser, one
  page per URL, processed in chunks.
- De-duplicate URLs. Raise the workflow `timeout-minutes` for large lists.

**Files:** `check.mjs` (input loading + concurrency runner), `pdp-check.yml`
(replace the single-URL inputs with `urls` + `client_payload.urls`), add
`urls.txt`.

**Acceptance criteria:** running with a populated `urls.txt` (or a pasted list, or
an API array) checks every URL, prints one summary row per URL, and the run is red
if any fail.

### Task B — Presence-only checks (remove title/URL matching)

**Goal:** do not compare against any specific title or hero URL. Only verify the
elements are actually there and rendered.

**Changes:**
- Remove `expected`, `EXPECTED_TITLE`, `EXPECTED_HERO`, and every `matchesExpected`
  field / branch from `check.mjs` and the workflow.
- Resulting checks per page:
  - **H1:** present + visible + non-empty (has text). (Non-empty is kept because
    an empty H1 is a real pipeline bug; drop it if you want pure DOM-presence.)
  - **Hero image:** present + has `src` + visible + decoded (`naturalWidth > 0`,
    which catches 404s and lazy-load failures).

**Acceptance criteria:** no code path references an expected title or hero URL; a
page passes iff both elements are present, visible, and (image) decoded.

### Task C — Use the exact element IDs

**Goal:** target the real PDP elements instead of generic selectors.

**Changes (in `config.mjs`):**
```js
selectors: {
  h1: "#pdpx-product-title",         // the H1 element carries this id
  hero: "#pdpx-product-hero-image",  // the hero <img> carries this id
},
```
The `waitForFunction` in `check.mjs` already reads `config.selectors`, so it picks
these up automatically. The generic fallback selectors can be removed.

**Acceptance criteria:** the wait and both assertions resolve against
`#pdpx-product-title` and `#pdpx-product-hero-image`.

---

### Reference implementation (after Tasks A + B + C)

**`config.mjs`:**
```js
export const config = {
  // Only render URLs matching this. Adjust if your branch/repo/owner differ.
  allowedHostPattern:
    /^https:\/\/[a-z0-9-]+--da-express-milo--adobecom\.aem\.(live|page)\//i,

  // Exact PDP element IDs.
  selectors: {
    h1: "#pdpx-product-title",
    hero: "#pdpx-product-hero-image",
  },

  timeouts: { navigateMs: 30000, contentInjectedMs: 20000 },
};
```

**`check.mjs`:**
```js
import { chromium } from "playwright";
import fs from "node:fs";
import { config } from "./config.mjs";

// Parallel page checks. Tune for runner memory; ~5 is safe on GitHub runners.
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);

// URLs to check, in precedence order:
//   1. CHECK_URLS       (manual run: newline- or comma-separated string)
//   2. CHECK_URLS_JSON  (API run: JSON array of strings from client_payload.urls)
//   3. urls.txt         (committed list; one URL per line; # = comment)
function loadUrls() {
  const out = [];
  if (process.env.CHECK_URLS && process.env.CHECK_URLS.trim()) {
    out.push(...process.env.CHECK_URLS.split(/[\n,]/));
  } else if (process.env.CHECK_URLS_JSON && process.env.CHECK_URLS_JSON !== "null") {
    let arr;
    try { arr = JSON.parse(process.env.CHECK_URLS_JSON); }
    catch (e) { throw new Error(`CHECK_URLS_JSON invalid: ${e.message}`); }
    if (Array.isArray(arr)) out.push(...arr);
  } else if (fs.existsSync("urls.txt")) {
    out.push(...fs.readFileSync("urls.txt", "utf8").split("\n"));
  }
  const urls = out.map((u) => u.trim()).filter((u) => u && !u.startsWith("#"));
  if (!urls.length) throw new Error("No URLs. Provide CHECK_URLS, client_payload.urls, or urls.txt.");
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigateMs });

    // Wait for the Zazzle-injected elements. Timeout here is itself a caught bug.
    await page
      .waitForFunction(
        (sel) => {
          const h1 = document.querySelector(sel.h1);
          const img = document.querySelector(sel.hero);
          return !!(h1 && h1.textContent.trim() && img && img.getAttribute("src"));
        },
        config.selectors,
        { timeout: config.timeouts.contentInjectedMs }
      )
      .catch(() => result.errors.push("content-never-injected"));

    // ---- H1 (presence only) ----
    const h1 = page.locator(config.selectors.h1).first();
    const h1Count = await page.locator(config.selectors.h1).count();
    result.checks.h1 = {
      present: h1Count > 0,
      visible: h1Count ? await h1.isVisible() : false,
      nonEmpty: h1Count ? (((await h1.textContent()) || "").trim().length > 0) : false,
    };

    // ---- Hero image (presence only) ----
    const hero = page.locator(config.selectors.hero).first();
    const heroCount = await hero.count();
    let hasSrc = false, visible = false, decoded = false;
    if (heroCount) {
      hasSrc = !!(await hero.getAttribute("src"));
      visible = await hero.isVisible();
      decoded = await hero.evaluate((img) => img.complete && img.naturalWidth > 0);
    }
    result.checks.hero = { present: heroCount > 0, hasSrc, visible, decoded };

    const c = result.checks;
    const h1ok = c.h1.present && c.h1.visible && c.h1.nonEmpty;
    const heroOk = c.hero.present && c.hero.visible && c.hero.decoded;
    result.ok = h1ok && heroOk && result.errors.length === 0;
  } catch (e) {
    result.errors.push(`render-failed: ${e.message}`);
  } finally {
    await page.close();
  }
  return result;
}

async function runAll(browser, urls) {
  const results = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const chunk = urls.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(chunk.map((u) => checkPage(browser, u)))));
  }
  return results;
}

const mark = (b) => (b ? "\u2713" : "\u2717");
function writeSummary(results) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const passed = results.filter((r) => r.ok).length;
  const rows = results.map((r) => {
    const h1 = r.checks.h1 || {}, hero = r.checks.hero || {};
    const status = r.ok ? "\u2705" : "\u274C";
    const notes = r.errors.length ? r.errors.join(", ") : "";
    return `| ${status} | ${r.url} | ${mark(h1.present && h1.visible && h1.nonEmpty)} | ${mark(hero.present && hero.visible && hero.decoded)} | ${notes} |`;
  });
  const md = [
    `## PDP render check \u2014 ${passed}/${results.length} passed`,
    ``,
    `| OK | URL | H1 | Hero | Notes |`,
    `|:--:|---|:--:|:--:|---|`,
    ...rows,
    ``,
    "<details><summary>Full JSON</summary>",
    ``,
    "```json",
    JSON.stringify(results, null, 2),
    "```",
    ``,
    "</details>",
    ``,
  ].join("\n");
  fs.appendFileSync(path, md);
}

const urls = loadUrls();
const browser = await chromium.launch();
let results = [];
try {
  results = await runAll(browser, urls);
} finally {
  await browser.close();
}
writeSummary(results);
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
```

**`.github/workflows/pdp-check.yml`:**
```yaml
name: PDP Render Check

on:
  workflow_dispatch:
    inputs:
      urls:
        description: "URLs (one per line or comma-separated). Blank = use urls.txt."
        required: false
        type: string
  repository_dispatch:
    types: [pdp-check]

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install dependencies
        run: npm install
      - name: Install Chromium for Playwright
        run: npx playwright install --with-deps chromium
      - name: Run PDP render check
        env:
          CHECK_URLS: ${{ github.event.inputs.urls }}
          CHECK_URLS_JSON: ${{ toJSON(github.event.client_payload.urls) }}
        run: npm run check
```

**`urls.txt`** (new file):
```
# One PDP URL per line. Lines starting with # are ignored.
https://main--da-express-milo--adobecom.aem.live/<path-to-a-pdp>
https://main--da-express-milo--adobecom.aem.live/<path-to-another-pdp>
```

**API trigger (batch) after Task A:**
```bash
curl -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/pdp-render-checker/dispatches \
  -d '{"event_type":"pdp-check","client_payload":{"urls":[
       "https://main--da-express-milo--adobecom.aem.live/<path-1>",
       "https://main--da-express-milo--adobecom.aem.live/<path-2>"
     ]}}'
```

---

## 8. Constraints & gotchas

- **Selectors are the thing most likely to need adjustment.** After Task C, if a
  check fails on a page you believe is good, first confirm the element really
  carries `#pdpx-product-title` / `#pdpx-product-hero-image` in the rendered DOM
  (IDs must be unique; if more than one element matches, the tool takes the
  first).
- **Publish latency.** `.aem.live` reflects published content; a freshly published
  page may 404 or be stale for a few seconds. Consider a short retry/backoff on
  navigation before treating an empty render as a failure.
- **`content-never-injected` is a real failure, not a tooling error** — it means
  the elements never appeared within the timeout. If it fires spuriously on slow
  pages, raise `timeouts.contentInjectedMs` in `config.mjs` rather than removing
  the wait.
- **Concurrency vs memory.** Chromium is memory-hungry. If large runs OOM on the
  runner, lower `CONCURRENCY`.
- **Async triggers.** Anything triggering via the API gets no synchronous result;
  it must poll the run (or the workflow must post results back).
- **Playwright version.** Keep `package.json` and (if a container is built later)
  the Playwright Docker image tag in sync.

---

## 9. Roadmap (beyond the three tasks)

- **DA-tool integration.** Trigger via `repository_dispatch` from the generator,
  and add a final workflow step that posts results back to the DA tool (or have
  the tool poll the run) so authors see pass/fail in context.
- **`.aem.page` (pre-publish) validation.** Render preview URLs to gate before
  publish. Requires injecting preview auth into the browser context (project
  access-control specific; the DA app's IMS token is a likely source — confirm
  against the site's access config).
- **Scale / tiering.** The upstream pre-generation step already validates Zazzle
  *data* for every page cheaply; this render check is the more expensive tier, so
  consider sampling or risk-targeting (by product type / template) rather than
  rendering the entire catalog every run. Bounded parallelism (Task A) covers
  moderate lists; for very large sweeps, shard across matrix jobs.
- **Container / Ethos version.** For a synchronous endpoint the DA tool can call
  live, move the same Playwright logic into a container (official Playwright image
  + a tiny HTTP server) and deploy to Adobe Ethos. The check logic ports directly
  (standard `playwright`); only the harness (GitHub Actions → HTTP server) changes.
- **Richer reporting.** Persist results over time, alert on regressions, and
  optionally expand the checked elements (price, CTA, gallery) if needed.

---

## 10. Quick reference

```bash
# Local single / list run
CHECK_URL="https://main--da-express-milo--adobecom.aem.live/<path>" npm run check   # v1
CHECK_URLS="url1,url2" npm run check                                                # after Task A

# Install
npm install && npx playwright install --with-deps chromium

# Trigger via CLI (after Task A)
gh workflow run pdp-check.yml -f urls="https://.../a
https://.../b"
```

**Definition of done for this handoff's tasks:** `urls.txt` drives a parallel,
multi-URL run; no expected-value matching remains anywhere; and both assertions
target `#pdpx-product-title` and `#pdpx-product-hero-image`.
