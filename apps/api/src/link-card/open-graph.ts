// OpenGraph auto-fetch for the photo link-card.
//
// Rebuilds the *logic* of LinkPage's (github.com/rhnvrm/linkpage, BSD-2-Clause
// per its LICENSE file) auto-fetch metadata on link add: when a seller pastes
// a URL, fetch the page server-side and pre-fill a rich link card from its
// og:title / og:description / og:image. LinkPage is Go — this is a fresh
// TypeScript implementation for FreeTree's stack, not a port.
//
// SSRF GUARDS — this fetches seller-supplied URLs server-side, so every hop
// is checked before any bytes are requested:
// - http/https only (no file:, gopher:, ftp:, javascript:, ...).
// - The hostname is resolved with the system resolver and EVERY returned
//   address must be a public IP: loopback, private (RFC 1918), link-local,
//   CGNAT (100.64/10), unspecified, multicast and IPv4-mapped-private IPv6
//   addresses are all rejected. Literal-IP hostnames are checked the same way.
// - Redirects are followed manually (max 5) and each hop is re-validated — a
//   public URL redirecting to http://169.254.169.254/ is blocked at the hop.
// - 5s timeout, 1 MB response cap, non-HTML content-types rejected.
// - A per-request User-Agent identifies the fetcher.
//
// Residual risk, stated plainly: the DNS check and the fetch resolve the
// hostname separately (a TOCTOU / DNS-rebinding window). A hostile DNS that
// answers public to the lookup and private to the fetch could slip through.
// Closing that needs IP-pinned connections (custom agent + Host/SNI override)
// — deliberately out of scope for this first version; the lookup check stops
// every static private/loopback/link-local target, which is the realistic
// abuse shape (cloud metadata endpoints, localhost admin panels).

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import {
  MAX_LINK_CARD_DESCRIPTION_LENGTH,
  MAX_LINK_CARD_TITLE_LENGTH,
  type LinkCard,
} from "@kytelink/schemas";

export const OG_FETCH_TIMEOUT_MS = 5_000;
export const OG_FETCH_MAX_BYTES = 1_000_000;
export const OG_FETCH_MAX_REDIRECTS = 5;

const FETCH_USER_AGENT =
  "FreeTree-LinkCard/1.0 (+https://getfreetree.com) Mozilla/5.0 (compatible; link preview fetcher)";

export type LinkCardFetchCode =
  | "INVALID_URL"
  | "DNS_LOOKUP_FAILED"
  | "BLOCKED_PRIVATE_HOST"
  | "TOO_MANY_REDIRECTS"
  | "FETCH_FAILED"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "NOT_HTML";

export class LinkCardFetchError extends Error {
  readonly code: LinkCardFetchCode;

  constructor(code: LinkCardFetchCode, message: string) {
    super(message);
    this.name = "LinkCardFetchError";
    this.code = code;
  }
}

// ─── Public-IP checks ───────────────────────────────────────────────────────

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  // Malformed input is treated as blocked, never as public.
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return true;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 0) return true; // 0/8 "this network"
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (/^fe[89ab][0-9a-f]*:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[c-d][0-9a-f]*:/.test(lower)) return true; // fc00::/7 unique-local
  if (lower.startsWith("ff")) return true; // ff00::/8 multicast
  // IPv4-mapped: ::ffff:10.0.0.1 — judge the embedded v4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  const embedded = mapped?.[1];
  if (embedded) return isPrivateIPv4(embedded);
  return false;
}

/** False for anything that is not a syntactically valid public IP. */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !isPrivateIPv4(ip);
  if (family === 6) return !isPrivateIPv6(ip);
  return false;
}

export type DnsLookup = (
  hostname: string,
  options: { all: true },
) => Promise<LookupAddress[]>;

/**
 * Resolve a hostname and require every returned address to be public.
 * Literal-IP hostnames never touch DNS — they are checked directly.
 */
export async function assertPublicHost(
  hostname: string,
  lookup: DnsLookup = dnsLookup,
): Promise<void> {
  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new LinkCardFetchError(
        "BLOCKED_PRIVATE_HOST",
        `refusing to fetch private IP host ${hostname}`,
      );
    }
    return;
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new LinkCardFetchError("DNS_LOOKUP_FAILED", `could not resolve ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new LinkCardFetchError("DNS_LOOKUP_FAILED", `could not resolve ${hostname}`);
  }
  for (const { address } of addresses) {
    if (!isPublicIp(address)) {
      throw new LinkCardFetchError(
        "BLOCKED_PRIVATE_HOST",
        `refusing to fetch ${hostname}: resolves to private address ${address}`,
      );
    }
  }
}

// ─── OpenGraph parsing (pure — fixture-testable, no network) ────────────────

const META_TAG_RE = /<meta\b[^>]*>/gi;
const META_ATTR_RE =
  /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const TITLE_TAG_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function cleanText(value: string, maxLength: number): string | undefined {
  const cleaned = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned;
}

function parseMetaAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of tag.matchAll(META_ATTR_RE)) {
    const rawName = match[1];
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

function resolveImageUrl(raw: string, baseUrl: string): string | undefined {
  try {
    const resolved = new URL(raw.trim(), baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
    return resolved.href;
  } catch {
    return undefined;
  }
}

/**
 * Extract og:title / og:description / og:image from HTML, with the usual
 * fallbacks (twitter: cards, <title>, meta description). Returns null when
 * the page carries nothing usable. Relative og:image URLs resolve against
 * the final (post-redirect) page URL.
 */
export function parseOpenGraph(html: string, baseUrl: string): LinkCard | null {
  const found = new Map<string, string>();
  for (const tag of html.matchAll(META_TAG_RE)) {
    const attrs = parseMetaAttributes(tag[0]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (!key || content === undefined || content === "") continue;
    if (!found.has(key)) found.set(key, content);
  }

  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = found.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const titleRaw =
    pick("og:title", "twitter:title") ??
    (() => {
      const m = TITLE_TAG_RE.exec(html)?.[1];
      if (!m) return undefined;
      return m.replace(/<[^>]*>/g, "");
    })();
  const descriptionRaw = pick("og:description", "twitter:description", "description");
  const imageRaw = pick(
    "og:image",
    "og:image:url",
    "og:image:secure_url",
    "twitter:image",
    "twitter:image:src",
  );

  const title = titleRaw ? cleanText(titleRaw, MAX_LINK_CARD_TITLE_LENGTH) : undefined;
  const description = descriptionRaw
    ? cleanText(descriptionRaw, MAX_LINK_CARD_DESCRIPTION_LENGTH)
    : undefined;
  const image = imageRaw ? resolveImageUrl(imageRaw, baseUrl) : undefined;

  if (!title && !description && !image) return null;
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
  };
}

// ─── Server-side fetch ──────────────────────────────────────────────────────

export interface FetchOpenGraphOptions {
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests — defaults to node:dns/promises lookup. */
  lookup?: DnsLookup;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface FetchOpenGraphResult {
  /** Null when the page fetched fine but carried no usable metadata. */
  card: LinkCard | null;
  /** Final URL after redirects. */
  fetchedUrl: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new LinkCardFetchError(
      "TOO_LARGE",
      `refusing response declaring ${declared} bytes (cap ${maxBytes})`,
    );
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new LinkCardFetchError(
            "TOO_LARGE",
            `refusing response over ${maxBytes} bytes`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Fetch a URL's OpenGraph metadata with the SSRF guards above. Throws
 * LinkCardFetchError on any guard or network failure; returns { card: null }
 * when the page simply has no metadata (not an error — the editor keeps the
 * seller's manual title).
 */
export async function fetchOpenGraph(
  inputUrl: string,
  options: FetchOpenGraphOptions = {},
): Promise<FetchOpenGraphResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup = options.lookup ?? dnsLookup;
  const timeoutMs = options.timeoutMs ?? OG_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? OG_FETCH_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? OG_FETCH_MAX_REDIRECTS;

  let current: URL;
  try {
    current = new URL(inputUrl.trim());
  } catch {
    throw new LinkCardFetchError("INVALID_URL", `not a valid URL: ${inputUrl}`);
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") {
    throw new LinkCardFetchError(
      "INVALID_URL",
      `only http(s) URLs can be fetched, got ${current.protocol}`,
    );
  }

  let redirects = 0;
  for (;;) {
    await assertPublicHost(current.hostname, lookup);

    let res: Response;
    try {
      res = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "User-Agent": FETCH_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (error) {
      if (error instanceof LinkCardFetchError) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new LinkCardFetchError(
          "TIMEOUT",
          `fetch of ${current.href} timed out after ${timeoutMs}ms`,
        );
      }
      throw new LinkCardFetchError(
        "FETCH_FAILED",
        `fetch of ${current.href} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        throw new LinkCardFetchError(
          "FETCH_FAILED",
          `${current.href} redirected with no Location header`,
        );
      }
      if (++redirects > maxRedirects) {
        throw new LinkCardFetchError(
          "TOO_MANY_REDIRECTS",
          `more than ${maxRedirects} redirects from ${inputUrl}`,
        );
      }
      let next: URL;
      try {
        next = new URL(location, current.href);
      } catch {
        throw new LinkCardFetchError("INVALID_URL", `bad redirect Location: ${location}`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new LinkCardFetchError(
          "INVALID_URL",
          `redirect to non-http(s) URL blocked: ${next.protocol}`,
        );
      }
      current = next;
      continue;
    }

    if (!res.ok) {
      throw new LinkCardFetchError(
        "FETCH_FAILED",
        `fetch of ${current.href} returned HTTP ${res.status}`,
      );
    }

    const contentType = res.headers.get("content-type");
    if (
      contentType !== null &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      throw new LinkCardFetchError(
        "NOT_HTML",
        `refusing non-HTML content-type ${contentType} from ${current.href}`,
      );
    }

    const html = await readBodyCapped(res, maxBytes);
    const parsed = parseOpenGraph(html, current.href);
    const card: LinkCard | null = parsed
      ? { ...parsed, fetchedAt: new Date().toISOString() }
      : null;
    return { card, fetchedUrl: current.href };
  }
}
