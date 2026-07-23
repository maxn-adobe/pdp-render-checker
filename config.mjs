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

  // Timeouts (ms). Give the client-side Zazzle call room to return.
  timeouts: {
    navigateMs: 30000,
    contentInjectedMs: 20000,
    // Short extra wait for the buy CTA href to hydrate off its "#" placeholder.
    buyLinkMs: 5000,
    // Bounded wait for every gallery image (hero + thumbnails) to decode; the
    // Zazzle rendering endpoint returns them a few seconds after injection.
    imagesMs: 15000,
  },
};
