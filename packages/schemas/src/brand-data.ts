// Brand-button styles, adapted from LittleLink (https://littlelink.io).
// Source: `css/brands.css` + `index.html` button markup, MIT licensed
// (https://github.com/sethcottle/littlelink, Seth Cottle). Colors below are
// transcribed verbatim from that file; the `background` value is either a
// solid color or the file's own `background-image` gradient, exactly as
// LittleLink ships it. `-alt` entries are LittleLink's alternate colorways
// for the same brand; detection returns the primary key only.
//
// Zod-free: render-time consumers import this through @kytelink/schemas/profile-data
// so the public profile's client bundle never pulls in the zod runtime.

export interface BrandStyle {
  /** Button label color. */
  text: string;
  /** Button background — a solid color or a linear-gradient, as LittleLink ships it. */
  background: string;
  /** Button border, e.g. "1px solid #ffffff". Null = no border in LittleLink. */
  border: string | null;
}

export const BRAND_STYLES: Record<string, BrandStyle> = {
  "amazon": { text: "#000000", background: "#FFFFFF", border: "1px solid #212121" },
  "amazon-music": { text: "#000000", background: "#25D1DA", border: null },
  "apple-music": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "apple-music-alt": { text: "#ffffff", background: "linear-gradient(to bottom,#FB5C74,#FA233B)", border: null },
  "apple-podcasts": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "apple-podcasts-alt": { text: "#ffffff", background: "linear-gradient(to bottom,#F452FF,#832BC1)", border: null },
  "appstore": { text: "#FFFFFF", background: "#000000", border: "1px solid #FFFFFF" },
  "bandcamp": { text: "#ffffff", background: "#1d9fc3", border: null },
  "behance": { text: "#ffffff", background: "#0057FF", border: "1px solid #FFFFFF" },
  "bluesky": { text: "#FFFFFF", background: "#1185FE", border: null },
  "bluesky-alt": { text: "#000000", background: "#FFFFFF", border: "1px solid #000000" },
  "cal": { text: "#FFFFFF", background: "#292929", border: "1px solid #FFFFFF" },
  "calendly": { text: "#FFFFFF", background: "#006BFF", border: null },
  "cash-app": { text: "#ffffff", background: "linear-gradient(to bottom,#00d64b,#00c244)", border: null },
  "coffee": { text: "#000000", background: "#ffdd00", border: null },
  "dev-to": { text: "#000000", background: "#f5f5f5", border: "1px solid #212121" },
  "discogs": { text: "#000000", background: "#FFFFFF", border: "1px solid #000000" },
  "discogs-alt": { text: "#FFFFFF", background: "#000000", border: "1px solid #FFFFFF" },
  "discord": { text: "#ffffff", background: "#5865F2", border: null },
  "dribbble": { text: "#000000", background: "#FFFFFF", border: "1px solid #212121" },
  "etsy": { text: "#ffffff", background: "#F45800", border: null },
  "faceb": { text: "#ffffff", background: "#0866FF", border: null },
  "figma": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "fiverr": { text: "#ffffff", background: "#1DBF73", border: null },
  "flickr": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "github": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "gitlab": { text: "#ffffff", background: "#6151b2", border: null },
  "gofundme": { text: "#ffffff", background: "#02A95C", border: null },
  "goodreads": { text: "#333333", background: "#f3f1e6", border: "1px solid #212121" },
  "google-black": { text: "#FFFFFF", background: "#000000", border: "1px solid #FFFFFF" },
  "google-scholar": { text: "#000000", background: "#FFFFFF", border: "1px solid #212121" },
  "hashnode": { text: "#000000", background: "#ffffff", border: "1px solid #212121" },
  "instagram": { text: "#ffffff", background: "linear-gradient(-135deg,#1400c8,#b900b4,#f50000)", border: null },
  "invites": { text: "#FFFFFF", background: "#000000", border: "1px solid #FFFFFF" },
  "kick": { text: "#ffffff", background: "#000000", border: "1px solid #ffffff" },
  "kick-alt": { text: "#000000", background: "#01e701", border: null },
  "kickstarter": { text: "#ffffff", background: "#05ce78", border: null },
  "ko-fi": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "last-fm": { text: "#ffffff", background: "#D51007", border: null },
  "letterboxd": { text: "#ffffff", background: "#2c3440", border: "1px solid #FFFFFF" },
  "line": { text: "#FFFFFF", background: "#06C755", border: null },
  "linked": { text: "#ffffff", background: "#2867b2", border: null },
  "mailchimp": { text: "#000000", background: "#FFE01B", border: null },
  "mastodon": { text: "#ffffff", background: "#17063B", border: "1px solid #FFFFFF" },
  "matrix": { text: "#000000", background: "#ffffff", border: "1px solid #000000" },
  "medium": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "meetup": { text: "#000000", background: "#ffffff", border: "1px solid #000000" },
  "meetup-alt": { text: "#ffffff", background: "#ED1C40", border: null },
  "messenger": { text: "#ffffff", background: "#0866FF", border: null },
  "microsoft": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "notion": { text: "#000000", background: "#ffffff", border: "1px solid #212121" },
  "obsidian": { text: "#ffffff", background: "#262626", border: "1px solid #ffffff" },
  "onlyfans": { text: "#ffffff", background: "#00AEEF", border: null },
  "patreon": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "paypal": { text: "#ffffff", background: "#002991", border: "1px solid #FFFFFF" },
  "pinterest": { text: "#000000", background: "#ffffff", border: "1px solid #212121" },
  "playstore": { text: "#FFFFFF", background: "#000000", border: "1px solid #FFFFFF" },
  "product-hunt": { text: "#000000", background: "#ffffff", border: "1px solid #212121" },
  "reddit": { text: "#FFFFFF", background: "#FF4500", border: null },
  "shop": { text: "#ffffff", background: "#5A31F4", border: null },
  "signal": { text: "#ffffff", background: "#3B45FD", border: null },
  "signal-alt": { text: "#3B45FD", background: "#E3E8FE", border: "1px solid #000000" },
  "slack": { text: "#000000", background: "#FFFFFF", border: "1px solid #212121" },
  "snapchat": { text: "#000000", background: "#fffc00", border: null },
  "soundcloud": { text: "#ffffff", background: "#ff5500", border: null },
  "spotify": { text: "#191414", background: "#1db954", border: null },
  "spotify-alt": { text: "#FFFFFF", background: "#191414", border: "1px solid #FFFFFF" },
  "square": { text: "#FFFFFF", background: "#006AFF", border: null },
  "stack-overflow": { text: "#000000", background: "#FFFFFF", border: "1px solid #000000" },
  "steam": { text: "#ffffff", background: "linear-gradient(90deg,#08BBFF,#2B75FF)", border: null },
  "steam-alt": { text: "#ffffff", background: "linear-gradient(90deg,#09172a,#072a57,#0c5085)", border: "1px solid #FFFFFF" },
  "strava": { text: "#ffffff", background: "#fc5200", border: null },
  "substack": { text: "#ffffff", background: "#FF6719", border: null },
  "telegram": { text: "#ffffff", background: "#3faee8", border: null },
  "threads": { text: "#FFFFFF", background: "#000000", border: "1px solid #FFFFFF" },
  "threema": { text: "#000000", background: "#3fe669", border: null },
  "tiktok": { text: "#ffffff", background: "#000000", border: "1px solid #FFFFFF" },
  "trello": { text: "#ffffff", background: "#0065ff", border: null },
  "tumb": { text: "#ffffff", background: "#131313", border: "1px solid #FFFFFF" },
  "twitch": { text: "#ffffff", background: "#9146ff", border: null },
  "unsplash": { text: "#000000", background: "#ffffff", border: "1px solid #212121" },
  "venmo": { text: "#ffffff", background: "#008CFF", border: null },
  "vimeo": { text: "#ffffff", background: "#1ab7ea", border: null },
  "vsco": { text: "#FFFFFF", background: "#000000", border: "1px solid #FFFFFF" },
  "whatsapp": { text: "#ffffff", background: "#455a64", border: null },
  "wordpress": { text: "#ffffff", background: "#3858E9", border: null },
  "x": { text: "#FFFFFF", background: "#000000", border: "1px solid #FFFFFF" },
  "yt": { text: "#ffffff", background: "#282828", border: "1px solid #FFFFFF" },
  "yt-alt": { text: "#ffffff", background: "#FF0000", border: null },
  "yt-music": { text: "#ffffff", background: "#282828", border: "1px solid #FFFFFF" },
  "zelle": { text: "#ffffff", background: "#6D1ED4", border: null },
  "zoom": { text: "#ffffff", background: "#0B5CFF", border: "1px solid #FFFFFF" },
};

export type BrandKey = keyof typeof BRAND_STYLES;

// Hostnames that identify each brand. Detection matches the longest domain
// first, so music.youtube.com resolves to yt-music, not yt.
export const BRAND_DOMAINS: Record<string, readonly string[]> = {
  "amazon": ["amazon.com", "amazon.co.uk", "amazon.ca", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.com.au", "amzn.to"],
  "amazon-music": ["music.amazon.com"],
  "apple-music": ["music.apple.com"],
  "apple-podcasts": ["podcasts.apple.com"],
  "appstore": ["apps.apple.com"],
  "bandcamp": ["bandcamp.com"],
  "behance": ["behance.net"],
  "bluesky": ["bsky.app"],
  "cal": ["cal.com", "cal.co"],
  "calendly": ["calendly.com"],
  "cash-app": ["cash.app"],
  "coffee": ["buymeacoffee.com"],
  "dev-to": ["dev.to"],
  "discogs": ["discogs.com"],
  "discord": ["discord.com", "discord.gg", "discordapp.com"],
  "dribbble": ["dribbble.com"],
  "etsy": ["etsy.com"],
  "faceb": ["facebook.com", "fb.com", "fb.me"],
  "figma": ["figma.com"],
  "fiverr": ["fiverr.com"],
  "flickr": ["flickr.com"],
  "github": ["github.com"],
  "gitlab": ["gitlab.com"],
  "gofundme": ["gofundme.com"],
  "goodreads": ["goodreads.com"],
  "google-black": ["google.com"],
  "google-scholar": ["scholar.google.com"],
  "hashnode": ["hashnode.com", "hashnode.dev"],
  "instagram": ["instagram.com", "instagr.am"],
  "invites": ["invites.apple.com"],
  "kick": ["kick.com"],
  "kickstarter": ["kickstarter.com"],
  "ko-fi": ["ko-fi.com"],
  "last-fm": ["last.fm"],
  "letterboxd": ["letterboxd.com"],
  "line": ["line.me"],
  "linked": ["linkedin.com"],
  "mailchimp": ["mailchimp.com"],
  "mastodon": ["mastodon.social", "mastodon.online", "fosstodon.org", "mstdn.social"],
  "matrix": ["matrix.org", "matrix.to"],
  "medium": ["medium.com"],
  "meetup": ["meetup.com"],
  "messenger": ["m.me", "messenger.com"],
  "microsoft": ["microsoft.com"],
  "notion": ["notion.so", "notion.site"],
  "obsidian": ["obsidian.md"],
  "onlyfans": ["onlyfans.com"],
  "patreon": ["patreon.com"],
  "paypal": ["paypal.com", "paypal.me"],
  "pinterest": ["pinterest.com", "pin.it"],
  "playstore": ["play.google.com"],
  "product-hunt": ["producthunt.com"],
  "reddit": ["reddit.com", "redd.it"],
  "shop": ["shop.app"],
  "signal": ["signal.org"],
  "slack": ["slack.com"],
  "snapchat": ["snapchat.com"],
  "soundcloud": ["soundcloud.com"],
  "spotify": ["spotify.com"],
  "square": ["square.site", "squareup.com"],
  "stack-overflow": ["stackoverflow.com"],
  "steam": ["steampowered.com", "store.steampowered.com", "steamcommunity.com"],
  "strava": ["strava.com"],
  "substack": ["substack.com"],
  "telegram": ["t.me", "telegram.me", "telegram.org"],
  "threads": ["threads.net", "threads.com"],
  "threema": ["threema.ch"],
  "tiktok": ["tiktok.com"],
  "trello": ["trello.com"],
  "tumb": ["tumblr.com"],
  "twitch": ["twitch.tv"],
  "unsplash": ["unsplash.com"],
  "venmo": ["venmo.com"],
  "vimeo": ["vimeo.com"],
  "vsco": ["vsco.co"],
  "whatsapp": ["whatsapp.com", "wa.me"],
  "wordpress": ["wordpress.com"],
  "x": ["x.com", "twitter.com"],
  "yt": ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  "yt-music": ["music.youtube.com"],
  "zelle": ["zellepay.com"],
  "zoom": ["zoom.us"],
};

// Alternate colorways map back to their primary brand for detection.
export const BRAND_ALT_OF: Record<string, string> = {
  "apple-music-alt": "apple-music",
  "apple-podcasts-alt": "apple-podcasts",
  "bluesky-alt": "bluesky",
  "discogs-alt": "discogs",
  "kick-alt": "kick",
  "meetup-alt": "meetup",
  "signal-alt": "signal",
  "spotify-alt": "spotify",
  "steam-alt": "steam",
  "yt-alt": "yt",
};

// FontAwesome icon key (see packages/ui/src/fa-icons.ts) for the brands that
// have one in the ui registry. Absent = render no glyph; Kick has no FA icon,
// and X keeps the FaTwitter glyph (the closest available).
export const BRAND_FA_ICON: Record<string, string> = {
  "amazon": "FaAmazon",
  "apple-music": "FaApple",
  "apple-podcasts": "FaPodcast",
  "bandcamp": "FaBandcamp",
  "behance": "FaBehance",
  "dev-to": "FaDev",
  "discord": "FaDiscord",
  "dribbble": "FaDribbble",
  "etsy": "FaEtsy",
  "faceb": "FaFacebook",
  "figma": "FaFigma",
  "github": "FaGithub",
  "goodreads": "FaBook",
  "google-black": "FaGlobe",
  "instagram": "FaInstagram",
  "linked": "FaLinkedin",
  "medium": "FaMedium",
  "patreon": "FaPatreon",
  "paypal": "FaPaypal",
  "pinterest": "FaPinterest",
  "playstore": "FaGooglePlay",
  "reddit": "FaReddit",
  "shop": "FaShoppingCart",
  "slack": "FaSlack",
  "snapchat": "FaSnapchat",
  "soundcloud": "FaSoundcloud",
  "spotify": "FaSpotify",
  "square": "FaStore",
  "telegram": "FaTelegram",
  "tiktok": "FaTiktok",
  "twitch": "FaTwitch",
  "whatsapp": "FaWhatsapp",
  "wordpress": "FaWordpress",
  "x": "FaTwitter",
  "yt": "FaYoutube",
  "yt-music": "FaMusic",
};

/**
 * Identify the brand behind a link URL by hostname. Tolerates a missing
 * scheme ("youtube.com/@x" works) and www./subdomain prefixes. Returns null
 * for unknown hosts — the theme's own link style applies instead.
 */
export function detectLinkBrand(url: string): BrandKey | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let hostname: string;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname.startsWith("www.")) hostname = hostname.slice(4);
  let best: { brand: BrandKey; length: number } | null = null;
  for (const [brand, domains] of Object.entries(BRAND_DOMAINS)) {
    for (const domain of domains) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        if (!best || domain.length > best.length) best = { brand: brand as BrandKey, length: domain.length };
      }
    }
  }
  return best?.brand ?? null;
}
