// The things you will actually tune live here: host allowlist, selectors,
// value patterns, and timeouts.

export const config = {
  // 1. HOST ALLOWLIST — the checker will only render URLs matching this.
  //    Prevents the tool being pointed at arbitrary sites by accident or abuse.
  //    Accepts either the aem.live/page staging domain or the production
  //    www.adobe.com/express/... path (same EDS content, different host).
  //    Adjust if your branch/repo/owner differ from the default below.
  allowedHostPattern:
    /^https:\/\/(?:[a-z0-9-]+--da-express-milo--adobecom\.aem\.(?:live|page)\/|www\.adobe\.com\/express\/)/i,

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
    // First-pass concurrency auto-scales to CPU cores, capped here. The cap is
    // deliberately modest: too many pages rendering at once starves the browser's
    // layout engine and causes false failures. Override with CONCURRENCY / the UI.
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

  // Timeouts (ms). Give the client-side Zazzle call room to return.
  timeouts: {
    navigateMs: 30000,
    contentInjectedMs: 20000,
    // Short extra wait for the buy CTA href to hydrate off its "#" placeholder.
    buyLinkMs: 5000,
    // Bounded wait for every gallery image (hero + thumbnails) to decode; the
    // Zazzle rendering endpoint returns them a few seconds after injection.
    imagesMs: 15000,
    // Settle time after switching to the mobile viewport before measuring overflow.
    mobileReflowMs: 400,
  },
};
