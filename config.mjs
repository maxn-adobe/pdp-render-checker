// The things you will actually tune live here: host allowlist, selectors,
// value patterns, and timeouts.

export const config = {
  // 1. HOST ALLOWLIST — the checker will only render URLs matching this.
  //    Prevents the tool being pointed at arbitrary sites by accident or abuse.
  //    Accepts the aem.live/page staging domain, the stage host
  //    www.stage.adobe.com/express/... (VPN-gated — same EDS content as .aem.page),
  //    and the production www.adobe.com/express/... path. Same content, diff hosts.
  //    Adjust if your branch/repo/owner differ from the default below.
  allowedHostPattern:
    /^https:\/\/(?:[a-z0-9-]+--da-express-milo--adobecom\.aem\.(?:live|page)\/|www\.(?:stage\.)?adobe\.com\/express\/)/i,

  // 2. SELECTORS — exact PDP element IDs carried by the rendered markup.
  selectors: {
    h1: "#pdpx-product-title",
    hero: "#pdpx-product-hero-image",
    price: "#pdpx-price-label",
    buyButton: "#pdpx-checkout-button",
    // Wraps the product content once hydrated; carries data-template-id.
    productContainer: ".pdpx-global-container",
    optionsContainer: "#pdpx-customization-inputs-container",
    imagesContainer: "#pdpx-product-images-container",
    // Product images that must carry alt text. Excludes decorative images, for
    // which an empty alt is the correct, accessible choice.
    altImages: "#pdpx-product-hero-image, .pdpx-image-thumbnail-carousel-item-image",
    // Product Details accordion. The item class (.ax-accordion-item-container) is
    // shared by any ax-accordion on the page, so the check always counts items
    // *within* the product-details accordion, never globally.
    productDetailsSection: ".pdpx-product-details-section",
    productDetailsAccordion: ".pdpx-product-details-accordion",
    accordionItem: ".ax-accordion-item-container",
  },

  // 3. PATTERNS — how a rendered value is judged "real".
  patterns: {
    // Looks like a currency amount (locale-tolerant: "$23.15" or "23,15 €").
    price: /[$€£¥₹]\s?\d[\d.,]*|\d[\d.,]*\s?[$€£¥₹]/,
    // The buy CTA must be an Adobe Express editor URL; group 1 = the template
    // URN (e.g. "urn:aaid:sc:..."). Deployed pages use the /design-remix/ route;
    // /design/ is also accepted.
    expressTemplateUrl: /^https:\/\/new\.express\.adobe\.com\/design(?:-remix)?\/template\/([^/?#]+)/i,
    // An unresolved Milo authoring placeholder, e.g. {{title}}.
    placeholder: /\{\{[^}]+\}\}/,
  },

  // 4. JUNK TOKENS — leaked internal values that must never reach a live field.
  //    Matched case-insensitively; `allow` is an exact-cased list of real labels
  //    that would otherwise trip the check (e.g. the legitimate "None" option).
  junk: {
    tokens: ["none", "null", "undefined", "n/a"],
    allow: ["None"],
  },

  // 5. META — a healthy meta description is a full sentence, not the short spec
  //    title (the known regression). The short title isn't in the DOM, so a
  //    length floor is used as the proxy; adjust to taste.
  meta: {
    descriptionMinLength: 50,
  },

  // 6. MOBILE — viewport used to re-check element presence and confirm the page
  //    has no horizontal overflow at phone width.
  mobile: {
    width: 390,
    height: 844,
    overflowTolerancePx: 2,
    // Shared global chrome (Milo nav + footer). After the viewport shrinks from
    // desktop to phone width the global nav can stay in its desktop layout and
    // overhang the viewport — that's not a PDP defect, so its overflow is excluded
    // from the mobile check. Keep in sync with Milo's markup.
    chromeSelectors:
      "header.global-navigation, .global-navigation, .feds-topnav, footer.global-footer, .global-footer",
  },

  // 7. PERFORMANCE — parallelism + recycling for large batches.
  perf: {
    // Concurrency for the LOCAL WEB APP (the validated stage scenario). A perf
    // sweep on stage (see PERF-AUDIT.md) found throughput scales cleanly to ~12
    // concurrent pages with ZERO failures, then falls off a cliff at >=16
    // (transient render-contention failures — content-never-injected, NOT server
    // rate-limiting). The workload is I/O-bound (CPU ~20%), so this is a fixed
    // value deliberately decoupled from CPU cores. The UI no longer exposes it.
    localConcurrency: 12,
    // Auto-scale cap for the Action/CLI: autoConcurrency() = min(cores, this),
    // also overridable via the CONCURRENCY env var. Kept conservative at 8 — the
    // sweep validated 12 on stage, but the Action targets aem.live, which wasn't
    // swept at scale; raise only after a parity/throughput sweep there.
    maxConcurrency: 8,
    // Failed URLs are then re-checked serially (concurrency 1), which is
    // contention-free — so layout-sensitive checks (e.g. mobile overflow) measure
    // correctly and transient failures recover, while truly-broken pages stay failed.
    retries: 1,
    retryConcurrency: 1,
    // Pages processed between browser/context recycles (bounds memory on long
    // batches). Override with RECYCLE_EVERY.
    recycleEvery: 150,
  },

  // 8. REPORT — output-size guards for the local web app's downloadable reports.
  report: {
    // The interactive HTML report inlines each failed page's screenshot as a
    // base64 data URL. On very large runs (thousands of failures) the combined
    // JSON can exceed V8's max string length and crash the build, so above this
    // many screenshots they're omitted from the HTML (the table/notes still
    // render; only the drill-down images drop). CSV/XLSX are unaffected.
    maxInlineScreenshots: 750,
  },

  // Timeouts (ms). Give the client-side Zazzle call room to return.
  timeouts: {
    navigateMs: 30000,
    contentInjectedMs: 20000,
    // Short extra wait for the buy CTA href to hydrate off its "#" placeholder.
    buyLinkMs: 5000,
    // Bounded wait for every gallery image (hero + thumbnails) to decode; the
    // Zazzle rendering endpoint returns them a few seconds after injection.
    imagesMs: 15000,
    // Bounded wait for the Product Details accordion to render its items; it
    // decorates a beat after injection (async decorate + a product API call).
    productDetailsMs: 10000,
    // Settle time after switching to the mobile viewport before measuring overflow.
    mobileReflowMs: 400,
  },
};
