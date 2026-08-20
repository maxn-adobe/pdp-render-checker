# PDP Render Checker — Handoff & Status

> **Current state, open issues, and roadmap.** For how the code is organized and
> how to run/test/build, see **`CLAUDE.md`**. Architecture rationale that must not
> be undone is under "Key decisions" below.

## Purpose

Adobe Express generates a large catalog of **Print product detail pages (PDPs)** on
AEM Edge Delivery. Each PDP's real content (title, hero image, price, options, buy
CTA, …) is **not** in the page source — client-side JS calls the **Zazzle** API at
load and injects it. This tool renders each page in a real headless browser and
asserts the expected elements are present and correctly rendered, to catch
**client-side render/pipeline bugs** (not data bugs — data is validated upstream).

## Current state — everything below is shipped on `main` (PRs #1–#6, ~2026-08)

- **13-check validation gate** (MWPW-198738 tiers P0/P1/P2, plus a later product-details check): title, hero, **price**
  (fails on $0.00/blank), **buy-link** (Express `/design-remix/template/{urn}` matches
  the page's `data-template-id`; structural, no network), **no `{{ }}` placeholders**,
  **options** (real selected values), **no junk tokens** (none/null/…), **all photos
  decoded**, **all blocks render** (generic no-error), **meta tags**, **mobile
  overflow**, **image alt**, and **product details** (the Product Details section's
  accordion must render ≥1 item; empty/missing = fail — client-rendered, so it has a
  bounded wait like the gallery). (P0/P1/P2 in PR #1; product-details added 2026-08)
- **Local web app** — double-click launcher → loopback server + browser UI: paste/upload
  URLs, live progress, interactive sortable/filterable table with per-URL drill-down,
  and downloadable **XLSX** + self-contained interactive **HTML report** (with a
  screenshot of every failing page). Reuses the same engine as the Action. (PR #2)
- **`build-bundle.sh`** — one command builds the self-contained macOS bundle (bundled
  Node + vendored `node_modules` + launcher). URL lists moved to `sample-data/`; a bare
  `URLS_FILE` name resolves there. (PR #3)
- **Akamai UA fix** — production `www.adobe.com` URLs now load (headless UA rejected at
  the HTTP/2 layer; engine strips `HeadlessChrome`; local app uses system Chrome). (PR #4)
- **Build-arch badge** in the web UI — "Apple Silicon (arm64)" vs "Intel (x64)". (PR #5)
- **Performance** — continuous worker pool + one shared cached browser context +
  auto-scaled concurrency (capped 8) + serial retry pass + generation recycling.
  Back-to-back: ~3× faster, zero regressions, recovered transient failures. (PR #6)
- **Render-read optimization (2026-08-19)** — the h1/hero/price/buy checks now read the
  DOM with a single `page.evaluate` per block instead of Playwright `locator` methods,
  which balloon to seconds/op under shared-context concurrency (a perf audit found this
  is the dominant cost of large **stage** runs — not the report/screenshots, and CPU sits
  ~20%). Cut the `domReads` phase ~5× on cold stage pages and eliminated the
  contention-induced false failures that were feeding the serial retry pass.
  Behavior-preserving: verified by a deterministic fixture parity run (12 edge cases) +
  live back-to-back parity (aem.live + stage), **zero verdict changes**. Full audit and
  the remaining levers (re-tune concurrency, trim the retry pass) are in **`PERF-AUDIT.md`**.
- **Concurrency re-tune + UI simplification (2026-08-20, lever #2)** — a stage sweep of the new
  engine found the safe knee is **12** (0 failures at ≤12; ≥16 *probabilistically* melts down with
  transient render-contention failures; **no server rate-limiting at any level up to 32** — the
  ceiling is client-side, so VPN is irrelevant). The **local web app now runs a fixed
  `config.perf.localConcurrency = 12`** (decoupled from CPU cores — the workload is I/O-bound), and
  the **user-facing concurrency field was removed** from the UI. The Action/CLI is unchanged
  (`autoConcurrency` = min(cores, `maxConcurrency` 8), still overridable via `CONCURRENCY`).
  Validated by a regression gate (0 pass→fail vs a low-concurrency ground truth).
- **Retry-pass trim (2026-08-20, lever #3)** — the retry pass (recovers transient failures) now runs
  at **concurrency 4** (was serial/1; safe below the 12 cliff, ~4× faster) and **skips retrying
  deterministic failures** via a new pure `isRetryable()` in `checks.mjs`: a placeholder leak, junk
  token, $0.00/malformed price, wrong buy-URL, or missing-alt-on-rendered-images can't recover, so
  re-rendering them is skipped. Conservative — anything timing-sensitive or ambiguous (title, hero,
  images, mobile, meta, product-details, blocks) is still retried. Applies to both front-ends.
  Validated by unit tests + a request-counting fixture E2E + a live induce-then-recover stage run.

Unit tests: `npm test` (48, pure logic). Verified against live business-card PDPs.

## Key decisions (do not undo without reason)

- **A headless browser is required.** Static/server fetch returns only a product ID;
  the title/image/etc. are Zazzle-injected at runtime.
- **Do not validate by replaying the Zazzle API.** Validate the *rendered page* — the
  data is validated upstream, and re-checking the API wouldn't catch render failures.
- **Wait on the injected content itself**; a wait timeout *is* a caught bug
  (`content-never-injected`), not a tooling error (raise `timeouts.contentInjectedMs`
  only if it fires on genuinely slow-but-fine pages).
- **Host allowlist** (`config.allowedHostPattern`) is intentional — keep it.
- **Validate against live pages, not the SDK source**, and note **www.adobe.com needs
  system Chrome + the real-UA fix**; **concurrency is capped ~8** (renderer contention)
  with a serial retry pass. (Details in `CLAUDE.md` → Invariants.)

## Open issues / caveats

- **Bundle is macOS-only and unsigned.** arm64 by default (`NODE_ARCH=x64` for Intel; an
  x64 bundle also runs on Apple Silicon via Rosetta). A *downloaded* `.command` needs a
  one-time right-click → **Open** (Gatekeeper). Requires Google Chrome installed.
- **Network variance** to `aem.live` in this environment makes absolute timings noisy —
  validate pass-rates/timing on a real GitHub Actions run before trusting large-batch numbers.
- **"All blocks render"** is a generic no-error check (no per-product-type manifest), so it
  can't catch a *wholly-absent* expected block — only broken/empty ones that are present.
- **Meta description** now only requires a couple of words (`descriptionMinLength` 10). It no
  longer detects the short-title regression (the old ≥50-char + not-equal-to-title proxy was
  relaxed 2026-08-20 — it false-failed legitimately-short stage descriptions; e.g. the farm-trip
  flyer's description is literally its title).
- **Large HTML reports**: thousands of URLs + base64 failure screenshots make the report file
  large; guarded by `config.report.maxInlineScreenshots` (drops inline shots above the cap). The
  perf audit measured report/artifact build at ~2.4 s for a 5,000-URL run (HTML itself ~15 ms), i.e.
  negligible vs. the run — not a perf concern.
- The **GitHub Action uses bundled Chromium** → good for pre-publish `aem.live`; production
  `www.adobe.com` checks currently need the **local app** (system Chrome).

## Roadmap / next steps

- **Rebuild + redistribute the bundle** now that the perf PR is merged (`./build-bundle.sh`).
- **Windows `.cmd` launcher** for the bundle (macOS-first today).
- **Code-sign + notarize** the Mac app to remove the Gatekeeper prompt (needs Apple
  Developer ID / an internal distribution channel).
- Optionally let the **Action use system Chrome** (ubuntu runners ship Chrome) so it can
  also check production `www.adobe.com`, not just `aem.live`.
- **Large-scale validation on a real GitHub Actions runner** — confirm pass-rates and tune
  `CONCURRENCY` / `RECYCLE_EVERY` at scale.
- **Perf initiative — closed out (2026-08-20; see `PERF-AUDIT.md`).** Levers #1 (locator→evaluate),
  #2 (concurrency 12 + UI field removed), and #3 (retry pass conc 4 + skip deterministic failures)
  shipped. **#4 (tighten failing-page timeouts) deferred** — marginal (only helps failing pages),
  needs cold-page p99 data that's now scarce, and touches the correctness-critical injection gate.
  **#5 (overlap sequential waits) evaluated and skipped — no speedup**: the waits poll over content
  that hydrates concurrently, so sequential total already equals `max(readiness times)`; overlapping
  gains nothing and only shrinks deadlines. Per-page cost is now at the irreducible Zazzle-hydration
  floor (~35–45 min for 5K at conc 12).
- **Update JIRA MWPW-198738**: the buy CTA targets the Adobe Express editor (not Zazzle),
  so "points at the right Zazzle product" can't be validated from the DOM — we validate the
  Express template URN instead.
- Longer-term (original roadmap): DA-tool integration (post results back / `repository_dispatch`),
  an Ethos container for a synchronous endpoint, richer/persisted reporting + regression alerting,
  and per-product-type sampling for very large sweeps.
- **Pre-publish preview validation** now works via the VPN-gated stage host
  (`www.stage.adobe.com/express/…`, allowlisted). Deeper in-tool auth for the raw `.aem.page`
  host is parked on `feature-preview-auth` — see below.

## Parked work / branches (not on `main`)

Unmerged branches kept as records; resurrect if a need returns.

- **`feature-preview-auth`** — authenticating the tool to gated `.aem.page` preview pages.
  **Superseded** by the stage-URL workaround shipped on `main`, but kept because the investigation
  was substantial:
  - **Key finding:** `.aem.page` content auth is an **`Authorization: token <siteToken>` request
    header** that the AEM Sidekick injects browser-wide via `declarativeNetRequest`. The `siteToken`
    is transient and delivered only through the Sidekick's extension OAuth.
  - **Option C (site token):** paste a configured `hlx_…` token; the engine adds the header only to
    the project's content hosts. Implemented; needs a token issued for the site.
  - **Option A (CDP attach):** connect to the user's Sidekick-signed-in Chrome
    (`--remote-debugging-port`) and run in its existing context. Implemented.
  - **Option B (headless auto-fetch of the token):** proven **infeasible** (extension-only).
  - **Option D (Sidekick loaded into a headed tool window):** designed, not built.
  - Full analysis + exact edit points are in `PREVIEW-AUTH.md` on that branch.
- **`fix-mobile-overflow-nav`** (PR #8) and **`feature-table-ui-improvements`** (PR #9) — separate
  still-open feature PRs (mobile-overflow false-positive fix; results-table UX), unrelated to auth.

## Quick reference

```bash
npm test                                   # unit tests
npm run check                              # Action/CLI run (default sample-data/urls.txt)
URLS_FILE=urls_2.txt npm run check         # a committed list (resolves in sample-data/)
CHECK_URLS="url1,url2" npm run check        # ad hoc URLs
npm start                                  # local web app (prints a 127.0.0.1 URL)
./build-bundle.sh                          # build the double-click macOS bundle
PDP_PROFILE=1 npm run check                # per-phase timing
```
