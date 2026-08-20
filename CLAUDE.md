# pdp-render-checker — agent guide

Pre-publish **render-QA** for Adobe Express **Print PDPs**. It renders each page in
headless Chromium (Playwright), waits for the client-side Zazzle injection, and
asserts 13 checks against the *rendered* DOM — it catches render/pipeline bugs, not
data bugs (product data is validated upstream). Two front-ends over one shared
engine: a **GitHub Action** and a **local double-click web app**.

**See `HANDOFF.md` for current status, open issues, and roadmap.**

## Architecture (all ESM `.mjs`, Node 20+)
- `config.mjs` — all tunables: `allowedHostPattern`, `selectors`, `patterns`, `junk`, `meta`, `mobile`, `perf`, `timeouts`.
- `checks.mjs` — **pure logic, no browser**: predicates, `verdicts()`, `parseUrls()`, `rowModel()`/`CHECK_COLUMNS`. Unit-tested (`node:test`).
- `engine.mjs` — Playwright: `checkPage(context, url)` runs the 13 checks; `runChecks({…, onResult})` = worker pool + shared cached context + retry pass. **Shared by both front-ends — don't fork it.**
- `check.mjs` — GitHub Action / CLI entrypoint (env in → incremental summary table + exit code).
- `report.mjs` — `buildXlsx` / `buildCsv` / `buildHtmlReport` (all driven by `rowModel`).
- `server.mjs` + `public/index.html` — local web app (loopback `node:http` + vanilla, XSS-safe UI).
- `build-bundle.sh` — builds the self-contained macOS bundle into `dist/`.
- `sample-data/` — committed URL lists (`urls*.txt`). `runs/` and `dist/` are gitignored.

## The 13 checks (per URL)
title, hero image, price, buy-link, no-`{{ }}`-placeholders, options, no-junk-tokens, all-photos-decoded, all-blocks-render, meta-tags, mobile-overflow, image-alt-text, product-details (accordion has ≥1 item).

## Commands
- `npm test` — unit tests (pure logic).
- `npm run check` — Action/CLI run. Env inputs: `CHECK_URLS` / `CHECK_URLS_JSON` / `URLS_FILE` (a bare filename resolves inside `sample-data/`); default `sample-data/urls.txt`.
- `npm start` — local web app (prints a `http://127.0.0.1:<port>` URL).
- `./build-bundle.sh` — build the double-click bundle (`NODE_ARCH=x64 ./build-bundle.sh` cross-builds Intel).
- `PDP_PROFILE=1 …` — print per-phase timing.

## Invariants / gotchas (don't undo without re-validating)
- **Validate against LIVE pages, not the SDK source** (`express-milo-pdp-sdk`) — the deployed DOM differs (e.g. the buy CTA is `new.express.adobe.com/design-remix/template/{urn}`, **not** Zazzle).
- **`www.adobe.com` is behind Akamai**, which rejects headless Chromium's `HeadlessChrome` UA at the HTTP/2 layer (`ERR_HTTP2_PROTOCOL_ERROR`). `engine.mjs` strips that token; the **local app uses system Chrome** (bundled Chromium is still blocked for prod, so the Action targets pre-publish `aem.live`).
- **Concurrency** — the **local web app** runs a fixed `config.perf.localConcurrency` (**12**, validated on stage — see `PERF-AUDIT.md`); the **Action/CLI** uses `autoConcurrency()` = `min(cores, config.perf.maxConcurrency=8)`, overridable via `CONCURRENCY`. Above the safe knee, pages hit **transient render-contention false failures** (`content-never-injected`) — stage melts down at ≥16 — which the **retry pass** recovers (now concurrency 4, and it **skips retrying deterministic content failures** — `checks.mjs` `isRetryable`); it's client-side contention, **not** a server rate-limit. Re-validate with a back-to-back parity run (`regressions=0`) before raising either value.
- **Never change what/how a check passes** without a parity run (old vs new, identical per-URL `ok`, zero new failures).
- The host allowlist (`allowedHostPattern`) is intentional — keep it.

## Workflow
Work directly on `main` (solo project — no branch/PR required). Pure logic → `checks.mjs` (+ a `node:test`); browser work → `engine.mjs`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
