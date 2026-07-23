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

  // Timeouts (ms). Give the client-side Zazzle call room to return.
  timeouts: {
    navigateMs: 30000,
    contentInjectedMs: 20000,
    // Short extra wait for the buy CTA href to hydrate off its "#" placeholder.
    buyLinkMs: 5000,
  },
};
