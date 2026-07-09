// The two things you will actually tune live here.

export const config = {
  // 1. HOST ALLOWLIST — the checker will only render URLs matching this.
  //    Prevents the tool being pointed at arbitrary sites by accident or abuse.
  //    Adjust if your branch/repo/owner differ from the default below.
  allowedHostPattern:
    /^https:\/\/[a-z0-9-]+--da-express-milo--adobecom\.aem\.(live|page)\//i,

  // 2. SELECTORS — CSS selectors for the elements to validate.
  //    IMPORTANT: pin these to your actual PDP block markup. The values below
  //    are generic fallbacks and may match too much or too little on your pages.
  selectors: {
    h1: "h1",
    hero:
      '.marquee picture img, .hero picture img, [class*="hero"] picture img, [class*="hero"] img',
  },

  // Timeouts (ms). Give the client-side Zazzle call room to return.
  timeouts: {
    navigateMs: 30000,
    contentInjectedMs: 20000,
  },
};
