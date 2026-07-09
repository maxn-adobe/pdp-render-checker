// The two things you will actually tune live here.

export const config = {
  // 1. HOST ALLOWLIST — the checker will only render URLs matching this.
  //    Prevents the tool being pointed at arbitrary sites by accident or abuse.
  //    Adjust if your branch/repo/owner differ from the default below.
  allowedHostPattern:
    /^https:\/\/[a-z0-9-]+--da-express-milo--adobecom\.aem\.(live|page)\//i,

  // 2. SELECTORS — exact PDP element IDs carried by the rendered markup.
  selectors: {
    h1: "#pdpx-product-title",
    hero: "#pdpx-product-hero-image",
  },

  // Timeouts (ms). Give the client-side Zazzle call room to return.
  timeouts: {
    navigateMs: 30000,
    contentInjectedMs: 20000,
  },
};
