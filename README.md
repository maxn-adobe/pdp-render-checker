# PDP Render Checker

Headless render check for Zazzle-backed Adobe Express product detail pages on
AEM Edge Delivery. It loads a page in real Chromium, waits for the client-side
Zazzle call to inject content, then asserts against the rendered DOM. It is
designed to catch client-side pipeline bugs, not data problems (product data is
validated upstream before page generation).

## What it checks, per page

- H1: present, non-empty, visible.
- Hero image: present, has a src, actually decoded (naturalWidth > 0, so 404s and
  lazy-load failures fail), visible.
- Price: present, visible, non-empty, looks like a currency amount, and not
  $0.00/blank (a zero or blank price is treated as a defect).
- Buy link: the checkout CTA is a real Adobe Express template URL (not the
  un-hydrated `#`) whose templateId matches the page's `data-template-id`.
  Structural only — no network request or checkout is triggered. (The CTA points
  at the Express editor, not Zazzle; the Zazzle product id isn't rendered into
  the page, so it can't be validated from the DOM.)
- No leftover `{{ }}` placeholders: the rendered text and key attributes carry no
  unresolved Milo authoring tokens (these leak from surrounding authored blocks,
  not the PDP island itself).
- Options look right: where a product has customization options, every selected
  value is real (non-empty, never "none"/"null"/etc.). Products with no options
  are skipped.
- No junk tokens: filled-in fields (title, price, option values) contain no
  literal none/null/undefined/N/A (matched in any case; the legitimate "None"
  option label is allowlisted).
- Rest of the photos load: every image in the product gallery (hero + all
  thumbnails) actually decoded, not just the hero.
- All blocks render: any Milo block present on the page is non-empty and not in a
  failed/loading state. (Generic no-error check — it catches a broken block but
  not a wholly-absent expected one, as there is no per-product-type block manifest.)
- Meta tags: a non-empty, substantial meta description (a length floor guards
  against the known "description = short spec title" regression), plus a canonical
  link and og:title / og:image social tags.
- Mobile layout: at phone width the page has no horizontal overflow and the title,
  hero, and price are still present.
- Image alt text: the hero and thumbnail product images have non-empty alt
  (decorative images, which correctly use an empty alt, are excluded).
- Product Details: the Product Details section renders a non-empty accordion —
  at least one item is present (an empty or missing accordion is treated as a
  render failure). The count is scoped to the product-details accordion, so other
  accordions on the page don't count. It is client-rendered, so the check waits
  (bounded) for the first item before judging.
- A page that never populates within the timeout fails (that is the bug we hunt).
- Checks against every URL in one run, in parallel (bounded concurrency).

Accepted URL formats: the staging `https://<branch>--da-express-milo--adobecom.aem.(live|page)/...`
domain, the VPN-gated stage host `https://www.stage.adobe.com/express/...` (the same content as
`.aem.page`, reachable over VPN instead of the AEM Sidekick — the simplest way to validate preview
pages), and the production `https://www.adobe.com/express/...` domain (all same EDS-served content).
See `allowedHostPattern` in `config.mjs`.

## Running it

Three ways to trigger, all via the one workflow (`.github/workflows/pdp-check.yml`):

1. **Actions tab** -> "PDP Render Check" -> Run workflow. Inputs:
   - `urls` — paste a handful of URLs (one per line or comma-separated).
     **Reserve this for a small ad hoc list** — GitHub's manual-run form only
     offers a single-line text box (no textarea/file upload; that's a GitHub
     platform limitation, not something this tool controls), so it's painful to
     review or paste hundreds of URLs into.
   - `urls_file` — a URL list committed under `sample-data/` (e.g. `urls_2.txt`;
     a bare filename resolves inside `sample-data/`). Use this for any list you
     want versioned and reviewable via `git diff`. Ignored if `urls` is filled
     in. Blank uses `sample-data/urls.txt`.
   - `concurrency` — advanced override of page concurrency (see Tuning below).
2. **CLI**, for one-off large batches that aren't committed to the repo — the
   CLI passes the full multi-line value with no textbox limit:
   ```bash
   gh workflow run pdp-check.yml -f urls="$(cat myfile.txt)"
   ```
3. **API** (for the DA tool):

   ```bash
   curl -X POST \
     -H "Authorization: Bearer $GITHUB_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/<owner>/pdp-render-checker/dispatches \
     -d '{"event_type":"pdp-check","client_payload":{"urls":[
          "https://main--da-express-milo--adobecom.aem.live/<path-1>",
          "https://main--da-express-milo--adobecom.aem.live/<path-2>"
        ]}}'
   ```

Results appear in the run's job summary (a pass/fail table plus full JSON),
**written incrementally as each URL finishes** — so even if a run is killed by
the job timeout partway through, the summary already shows every URL checked so
far, not nothing. The run exits non-zero (red) if any page fails.

## Run locally as an app (web UI)

Run bulk checks on your own machine — no CI queue, and richer, downloadable
output. Everything runs locally: the server listens on `127.0.0.1` only and
nothing is sent anywhere.

**Double-click (no terminal) — for authors.** Get the distributable bundle (see
[Build the distributable bundle](#build-the-distributable-bundle-maintainers)),
unzip it, and double-click **`PDP Checker.command`**. Your browser opens to the
checker UI: paste or upload URLs, click **Run checks**, watch live progress, then
**Download XLSX** (a color-coded spreadsheet) and **Open HTML report** (an
interactive report with a screenshot of every failing page). Rendering uses your
installed Google Chrome.

> First launch only: if macOS warns about an unidentified developer, right-click
> `PDP Checker.command` → **Open** once (or run
> `xattr -d com.apple.quarantine "PDP Checker.command"`).

**From a terminal — for developers.**

```bash
npm install
npm start          # prints a http://127.0.0.1:<port> URL — open it in a browser
```

## Command-line run

```bash
npm install
npx playwright install --with-deps chromium

# single or comma/newline-separated list
CHECK_URLS="https://main--da-express-milo--adobecom.aem.live/<path>" npm run check

# a specific committed list (bare filename resolves inside sample-data/)
URLS_FILE=urls_2.txt npm run check

# or just run against the default sample-data/urls.txt
npm run check
```

## Tests

Pure check logic — currency/price validation, Express buy-link parsing, the
`{{ }}` placeholder scan, and verdict folding — is unit-tested with Node's
built-in test runner (no browser or network needed):

```bash
npm test
```

## Tuning

Edit `config.mjs`:
- `selectors` — pin the title, hero, price, buy-button, product-container,
  options-container, images-container, alt-images, and product-details
  (section / accordion / accordion-item) selectors to your PDP markup.
- `patterns` — the currency, Express-template-URL, and `{{ }}` placeholder
  regexes used by the price / buy-link / placeholder checks.
- `junk` — the leaked-token list (`none`/`null`/`undefined`/`n/a`) and the
  exact-cased `allow` list of legitimate labels (e.g. the "None" option).
- `meta` — `descriptionMinLength`, the length floor that stands in for the
  short-title regression (the short title isn't in the rendered DOM).
- `mobile` — the phone-viewport `width`/`height` and `overflowTolerancePx`.
- `allowedHostPattern` — adjust if your branch/repo/owner/production domain differ.
- `timeouts` — raise if pages are slow to populate (`buyLinkMs` waits for the buy
  CTA href to hydrate off `#`; `imagesMs` bounds the gallery-image decode wait;
  `productDetailsMs` bounds the wait for the Product Details accordion to render its
  items; `mobileReflowMs` is the settle time after switching to the mobile viewport).

### Performance / large batches

The checker is I/O-bound (it mostly waits on the page + Zazzle's image endpoint),
so it runs a **continuous worker pool** over one **shared, cached browser
context**, then does a **serial retry pass** over any failures. That retry
matters: running many pages at once starves the browser's layout engine and
produces *transient* false failures (content loads but isn't laid out when
checked); the contention-free retry re-checks those correctly, so genuinely
broken pages stay failed while transient ones recover.

Knobs (env vars / `config.perf`):
- `CONCURRENCY` — first-pass parallelism. Default **auto-scales to CPU cores**,
  capped at `perf.maxConcurrency` (**8**), because higher starves rendering. The
  local app pre-fills its Concurrency field with this value; you can push it
  higher and let the retry pass clean up.
- `RETRIES` (default **1**) / `RETRY_CONCURRENCY` (default **1**, serial) — the
  low-concurrency recovery pass over failed URLs.
- `RECYCLE_EVERY` (default **150**) — browser + context are recycled every N URLs
  to bound memory on very large (thousands-of-URLs) batches.
- `PDP_PROFILE=1` — print per-phase timing (avg/median/p90) at the end of a run.

## Build the distributable bundle (maintainers)

Run the build script — it produces a self-contained folder authors just
double-click (bundled Node + vendored `node_modules` + the launcher), so they
need nothing installed except Google Chrome:

```bash
./build-bundle.sh
```

Output:
- `dist/PDP-Checker/` — the runnable folder (double-click `PDP Checker.command`).
- `dist/PDP-Checker-macos-<arch>.zip` — the shareable artifact.

The script installs prod deps (skipping the Playwright browser download —
rendering uses the user's Chrome), downloads an official Node runtime from
nodejs.org into `runtime/`, stages the app, and zips it. It builds for the host
architecture by default; **cross-build for Intel** with `NODE_ARCH=x64
./build-bundle.sh` (an x64 bundle also runs on Apple Silicon via Rosetta, so it's
the safe single choice for a mixed fleet). Override the Node version with
`NODE_VERSION=v22.11.0 ./build-bundle.sh`.

macOS-first; a Windows `.cmd` launcher is a small follow-up. A *downloaded*
`.command` may need a one-time right-click → **Open** (Gatekeeper); full
code-signing/notarization is only necessary if this later becomes a native
`.app`.

## Known limitations of local testing

While tuning the volume/timeout behavior, a real ~300-URL local test run showed
a sharp failure spike starting partway through the batch (roughly 0% failures
in the first ~50 URLs, then 30-50% for the remainder) — initially suspected to
be concurrency contention or browser-process degradation. Neither explanation
held up under further testing: recycling the browser mid-run didn't change the
pattern, and the *same* spike appeared even fully serially (`CONCURRENCY=1`,
one page at a time, no parallelism at all). Retrying individual "failed" URLs
in isolation afterward, most succeeded immediately — confirming they were
transient, not real page bugs. A few also reproduced `net::ERR_HTTP2_PROTOCOL_ERROR`
on both `aem.live` and `www.adobe.com`, even though plain `curl` reached both
reliably every time.

Taken together, this points to a networking limitation specific to the sandbox
this tool was developed in (something about sustained/high-volume HTTP/2
connections from that environment), not a bug in the checker's logic and not
necessarily representative of GitHub's hosted runners, which have a different
(and normally more capable) network path. **Treat the `CONCURRENCY`/`RECYCLE_EVERY`
defaults as a reasonable starting point, not a fully CI-validated tuning** —
confirm real pass rates and timing against an actual GitHub Actions run on your
full URL list before relying on them for large batches, and if a similar
failure spike shows up there, it's worth checking whether the origin
(Fastly/AEM Edge Delivery) is rate-limiting sustained request volume from the
runner's IP, rather than re-tuning `CONCURRENCY` further.

**Update:** the engine now auto-scales concurrency (capped) and adds a serial
retry pass that re-checks failures contention-free — which recovers exactly these
transient failures. In back-to-back testing the new engine was ~3× faster *and*
passed more URLs than the old fixed-concurrency-3 engine (it recovered transient
failures the old one reported), with no new false failures.
