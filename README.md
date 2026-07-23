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
- A page that never populates within the timeout fails (that is the bug we hunt).
- Checks against every URL in one run, in parallel (bounded concurrency).

Accepted URL formats: the staging `https://<branch>--da-express-milo--adobecom.aem.(live|page)/...`
domain, and the production `https://www.adobe.com/express/...` domain (same
EDS-served content). See `allowedHostPattern` in `config.mjs`.

## Running it

Three ways to trigger, all via the one workflow (`.github/workflows/pdp-check.yml`):

1. **Actions tab** -> "PDP Render Check" -> Run workflow. Inputs:
   - `urls` — paste a handful of URLs (one per line or comma-separated).
     **Reserve this for a small ad hoc list** — GitHub's manual-run form only
     offers a single-line text box (no textarea/file upload; that's a GitHub
     platform limitation, not something this tool controls), so it's painful to
     review or paste hundreds of URLs into.
   - `urls_file` — path to a URL list already committed to the repo (e.g.
     `urls_2.txt`). Use this for any list you want versioned and reviewable via
     `git diff`. Ignored if `urls` is filled in. Blank uses `urls.txt`.
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

## Local run

```bash
npm install
npx playwright install --with-deps chromium

# single or comma/newline-separated list
CHECK_URLS="https://main--da-express-milo--adobecom.aem.live/<path>" npm run check

# a specific committed file
URLS_FILE=urls_2.txt npm run check

# or just run against the committed urls.txt
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
- `selectors` — pin the title, hero, price, buy-button, and product-container
  selectors to your actual PDP block markup.
- `patterns` — the currency, Express-template-URL, and `{{ }}` placeholder
  regexes used by the price / buy-link / placeholder checks.
- `allowedHostPattern` — adjust if your branch/repo/owner/production domain differ.
- `timeouts` — raise if pages are slow to populate (`buyLinkMs` is a short extra
  wait for the buy CTA href to hydrate off `#`).

Other knobs (env vars / matching `workflow_dispatch` inputs):
- `CONCURRENCY` (default **3**) — pages checked in parallel.
- `RECYCLE_EVERY` (default **40**) — the browser is closed and relaunched every
  N URLs, as cheap insurance against unbounded memory/handle growth in one
  long-lived Chromium process on very large batches.

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
