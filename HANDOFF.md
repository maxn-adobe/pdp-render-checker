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

- **12-check validation gate** (MWPW-198738, tiers P0/P1/P2): title, hero, **price**
  (fails on $0.00/blank), **buy-link** (Express `/design-remix/template/{urn}` matches
  the page's `data-template-id`; structural, no network), **no `{{ }}` placeholders**,
  **options** (real selected values), **no junk tokens** (none/null/…), **all photos
  decoded**, **all blocks render** (generic no-error), **meta tags**, **mobile
  overflow**, **image alt**. (PR #1)
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

Unit tests: `npm test` (32, pure logic). Verified against live business-card PDPs.

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
- **Meta short-title** detection is a length-floor proxy (`titleCyo` isn't in the DOM).
- **Large HTML reports**: thousands of URLs + base64 failure screenshots could make the
  report file large — not yet addressed (consider caps / linking screenshots).
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
- **Update JIRA MWPW-198738**: the buy CTA targets the Adobe Express editor (not Zazzle),
  so "points at the right Zazzle product" can't be validated from the DOM — we validate the
  Express template URN instead.
- Longer-term (original roadmap): DA-tool integration (post results back / `repository_dispatch`),
  `.aem.page` pre-publish validation (needs preview auth in the browser context), an Ethos
  container for a synchronous endpoint, richer/persisted reporting + regression alerting, and
  per-product-type sampling for very large sweeps.

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
