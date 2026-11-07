export { GITHUB_OWNER, GITHUB_REPO, GITHUB_REPO_URL } from "@kytelink/ui";

export const SELF_HOSTING_PATH = "/self-hosting";
export const FOUNDER_TWITTER_URL = "https://x.com/Nick173490";
export const FOUNDER_GITHUB_URL = "https://github.com/nickstrooo-bot";
export const FOUNDER_SITE_URL = "https://getfreetree.com";

export const HOME_TITLE = "FreeTree — Free Linktree Alternative | Your Links. Free Forever.";
export const HOME_DESCRIPTION =
  "FreeTree is the free Linktree alternative: a free link-in-bio with unlimited links, custom domains, themes, QR codes, and a full year of analytics — no subscriptions, no paywalls, no ads. Sell digital products and keep 96%: we take just 4%.";

export const PRODUCT_FEATURES = [
  "Unlimited links",
  "Custom domains",
  "12 themes",
  "Full analytics",
  "No ads on your page",
  "4% only when you sell",
] as const;

// Absolute links into the web zone — landing never mounts auth screens itself.
// Server-only WEB_BASE_URL isn't reachable from the browser, and in production
// getfreetree.com resolves these paths via the multi-zone rewrite either way.
export const WEB_BASE_URL =
  process.env.NEXT_PUBLIC_WEB_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://getfreetree.com"
    : "http://localhost:3000");
export const SIGNUP_URL = `${WEB_BASE_URL}/signup`;
export const LOGIN_URL = `${WEB_BASE_URL}/login`;
