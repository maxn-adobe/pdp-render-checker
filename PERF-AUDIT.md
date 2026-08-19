# Performance audit — large stage runs (2026-08-19)

Context: a 5,000-URL **stage** run took ~2 hours (concurrency 8). This is the
discovery pass — *where does the time go, and what can we change?* Measured with
the built-in `PDP_PROFILE=1` per-phase timing plus purpose-built probes against
live `www.stage.adobe.com` (system Chrome) and `aem.live` (bundled Chromium).

## TL;DR

The wall time is almost entirely spent **waiting on stage/Zazzle to render and
return each page's images** — not CPU, not the report, not screenshots. Across
every experiment **CPU stayed ~18–23 %** on a 16-core box: we are wait-bound.
Two client-side things make it worse than necessary:

1. **Playwright `locator` reads melt down under concurrency** — 20–30× slower
   than the identical read via `page.evaluate` (seconds vs. milliseconds per op
   on a cold page). Only the h1/hero/price/buy blocks use locators; every other
   check already uses `page.evaluate` and stayed at single-digit ms throughout.
2. **Concurrency 8 is past the knee.** For the current (locator-heavy) engine,
   *lower* concurrency is faster; higher just adds contention and induces false
   failures that then get re-run one-at-a-time in the serial retry pass.

## Methodology & caveats

- Corpus: the committed `sample-data/urls_2.txt` business-card PDPs, rewritten to
  the `www.stage.adobe.com/express/…` host to reproduce the real (VPN-gated,
  Akamai-fronted) scenario; system Chrome via `channel:"chrome"` like the app.
- **Stage render latency is highly variable** (sub-second when Zazzle has a
  product cached server-side, 10–20 s cold) and **re-hitting the same URLs warms
  that cache**, so absolute throughput bounced between ~0.2 and ~2 pages/s across
  runs. Treat the *structure* of the findings as solid and any single
  throughput/“N× faster” number as indicative only. A real 5K run hits 5,000
  distinct URLs each **once (cold)**, so the slow regime is the representative one.

## Where the time goes (per-page phase breakdown)

`checkPage` is a chain of **sequential** awaited waits. Representative cold-stage
medians at concurrency 8:

| Phase | Cold stage | What it is |
|---|---|---|
| `goto` | ~0.4–0.9 s | initial HTML |
| `contentWait` | ~3.5–6 s | wait for Zazzle to inject + hero image to *decode* — largely irreducible server-render time |
| **h1/hero/price/buy reads (`locator`)** | **~15–20 s** ⚠️ | the fixable cost — see below |
| images / product-details / blocks / meta / alt (`page.evaluate`) | 2–7 ms each | cheap |
| mobile | ~0.5 s | viewport switch + fixed 400 ms reflow |

⚠️ The hero block alone measured **median ~15 s / p90 ~20 s** under concurrency,
vs. **34 ms** on aem.live. A controlled probe isolated the cause: `locator.count()`
= median 4 s / p90 16 s, `locator.evaluate()` = median 1.7 s — while the **same
reads in one `page.evaluate()` were median ~130 ms with a bounded ~2.5 s tail.**
Run *serially*, locators are fine (<250 ms); they only balloon when 8 pages share
one browser context and serialize on the single CDP channel + Node event loop.

## Answers to the specific questions

**Is the HTML report expensive?** No. Measured builders for a 5,000-row run:

| Artifact | Time | Note |
|---|---|---|
| CSV | ~11 ms | — |
| HTML report | ~15 ms | even with 250 screenshots inlined (15 MB) |
| XLSX | ~2.4 s | the flattened “Details” sheet (~260 K rows) |

**~2.4 s total (~0.03 % of a 2-hour run)**, built **once at the end** — zero
effect on per-URL throughput. Not worth optimizing.

**What are the artifacts / screenshots?** Artifacts = the three files each run
writes to `runs/<id>/` (`report.csv`, `report.html`, `report.xlsx`). Screenshots
= a single quality-60 JPEG captured **only for FAILING pages** (`engine.mjs`,
`captureScreenshotOnFailure && !ok`), embedded in the HTML drill-down. ~200 ms
per failing page, best-effort, never blocks. **Not a meaningful cost** unless a
huge fraction of pages fail.

**Is concurrency 8 right? Can we go higher? Rate limits? VPN?**
- The box is 16 cores / 51 GB, but CPU is **80 % idle at concurrency 8** — we are
  wait-bound, so “more cores → crank it up” does not apply to the current engine.
- Going **higher made it worse**: cold runs at concurrency 8 were slower than 4
  *and* produced a batch of false failures (a 25 % first-pass failure rate in one
  cold run vs. 0 % at concurrency 4). Those failures then re-run serially.
- **No server rate-limiting observed** — zero HTTP 429/503 at any concurrency;
  failures were client-side render timeouts (`content-never-injected`), i.e.
  Playwright starving pages under contention, not Adobe throttling. So there is no
  server limit to raise and **VPN does not change it** (VPN is just how stage is
  reached; any rate limit would be server-side per-token, and we never hit one).

## Levers (ranked by impact ÷ effort)

1. **Convert h1/hero/price/buy reads `locator` → one `page.evaluate` per block.**
   Biggest safe client-side win; removes the multi-second locator tax *and* the
   main source of concurrency contention/false-failures. **Requires a parity run**
   (`isVisible()` semantics differ subtly from a DOM check). ← *implemented; see
   the commit that adds this file.*
2. **Re-tune concurrency.** For the engine as-is, ~4 beats 8. After lever #1
   removes the contention, re-sweep — with CPU at 20 % the box should then scale
   *up* (12–16), which is where the real throughput win comes from.
3. **Cut the serial-retry tail.** Retries run at concurrency 1 through the full
   wait chain. Retry at 2–4 instead, and **skip retrying deterministic failures**
   (an empty Product Details accordion is not transient — re-running just burns
   another 10 s).
4. **Tighten timeouts.** The buy block’s `pageTemplateId` `getAttribute` had *no*
   explicit timeout (inherited Playwright’s 30 s — fixed by lever #1); failing
   pages still eat the full `contentInjectedMs` 20 s + `imagesMs` 15 s +
   `productDetailsMs` 10 s, ×2 with the retry. Lower caps + parity-check.
5. **Overlap the sequential waits / drop the redundant hero read.** `contentWait`
   already blocks until the hero decodes, so the separate hero-decode read partly
   repeats that work.

Note: raising concurrency *alone* is a trap with the pre-lever-#1 engine — it
slows runs down and manufactures failures. The unlock is lever #1, *then* #2.
