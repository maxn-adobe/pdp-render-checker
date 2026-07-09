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
- A page that never populates within the timeout fails (that is the bug we hunt).
- Checks against every URL in one run, in parallel (bounded concurrency).

## Running it

Three ways to trigger, all via the one workflow (`.github/workflows/pdp-check.yml`):

1. Actions tab -> "PDP Render Check" -> Run workflow -> paste one or more URLs
   (blank uses the committed `urls.txt`).
2. CLI: `gh workflow run pdp-check.yml -f urls="https://.../a,https://.../b"`
3. API (for the DA tool):

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

Results appear in the run's job summary (a pass/fail table plus full JSON). The
run exits non-zero (red) if any page fails.

## Local run

```bash
npm install
npx playwright install --with-deps chromium

# single or comma/newline-separated list
CHECK_URLS="https://main--da-express-milo--adobecom.aem.live/<path>" npm run check

# or just run against the committed urls.txt
npm run check
```

## Tuning

Edit `config.mjs`:
- `selectors` — pin the H1 and hero selectors to your actual PDP block markup.
- `allowedHostPattern` — adjust if your branch/repo/owner differ.
- `timeouts` — raise if pages are slow to populate.
