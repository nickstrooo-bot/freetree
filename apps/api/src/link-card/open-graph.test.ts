import { createServer, type Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import {
  assertPublicHost,
  fetchOpenGraph,
  isPublicIp,
  LinkCardFetchError,
  parseOpenGraph,
} from "./open-graph";

const OG_PAGE = `<!doctype html><html><head>
<meta property="og:title" content="The &amp; Great Article">
<meta property="og:description" content="What the article is about.">
<meta property="og:image" content="https://cdn.example.com/cover.jpg">
<title>Fallback Title</title>
</head><body>hello</body></html>`;

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

let loopbackServer: Server | null = null;

afterEach(async () => {
  if (loopbackServer) {
    await new Promise<void>((resolve) => loopbackServer!.close(() => resolve()));
    loopbackServer = null;
  }
});

describe("isPublicIp", () => {
  it.each([
    ["93.184.216.34", true],
    ["8.8.8.8", true],
    ["127.0.0.1", false],
    ["127.5.6.7", false],
    ["10.0.0.5", false],
    ["172.16.0.1", false],
    ["172.31.255.255", false],
    ["172.32.0.1", true],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["0.0.0.0", false],
    ["100.64.0.1", false],
    ["100.127.255.255", false],
    ["100.128.0.1", true],
    ["224.0.0.1", false],
    ["::1", false],
    ["::", false],
    ["fe80::1", false],
    ["febf::1", false],
    ["fc00::1", false],
    ["fd12:3456::1", false],
    ["ff02::1", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["2606:4700:4700::1111", true],
    ["not-an-ip", false],
  ])("%s -> public=%s", (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });
});

describe("assertPublicHost", () => {
  it("blocks literal private IPs without touching DNS", async () => {
    await expect(assertPublicHost("127.0.0.1", publicLookup)).rejects.toMatchObject({
      code: "BLOCKED_PRIVATE_HOST",
    });
    await expect(assertPublicHost("169.254.169.254", publicLookup)).rejects.toMatchObject(
      {
        code: "BLOCKED_PRIVATE_HOST",
      },
    );
  });

  it("allows literal public IPs", async () => {
    await expect(
      assertPublicHost("93.184.216.34", publicLookup),
    ).resolves.toBeUndefined();
  });

  it("blocks a hostname whose DNS answers private", async () => {
    const evilLookup = async () => [{ address: "10.1.2.3", family: 4 as const }];
    await expect(assertPublicHost("evil.example.com", evilLookup)).rejects.toMatchObject({
      code: "BLOCKED_PRIVATE_HOST",
    });
  });

  it("blocks when any one of several answers is private", async () => {
    const mixedLookup = async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "192.168.0.1", family: 4 as const },
    ];
    await expect(
      assertPublicHost("mixed.example.com", mixedLookup),
    ).rejects.toMatchObject({
      code: "BLOCKED_PRIVATE_HOST",
    });
  });

  it("reports DNS failure instead of fetching", async () => {
    const failingLookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      assertPublicHost("missing.example.com", failingLookup),
    ).rejects.toMatchObject({
      code: "DNS_LOOKUP_FAILED",
    });
  });
});

describe("parseOpenGraph", () => {
  it("extracts og:title / og:description / og:image", () => {
    expect(parseOpenGraph(OG_PAGE, "https://example.com/article")).toEqual({
      title: "The & Great Article",
      description: "What the article is about.",
      image: "https://cdn.example.com/cover.jpg",
    });
  });

  it("resolves a relative og:image against the final page URL", () => {
    const html = `<meta property="og:image" content="/img/cover.jpg">`;
    expect(parseOpenGraph(html, "https://example.com/a/b")).toEqual({
      image: "https://example.com/img/cover.jpg",
    });
  });

  it("falls back to twitter: cards, then <title> and meta description", () => {
    const html = `<html><head>
      <meta name="twitter:title" content="Tweet Title">
      <meta name="description" content="Plain meta description.">
      <title>Title Tag</title>
    </head></html>`;
    expect(parseOpenGraph(html, "https://example.com/")).toEqual({
      title: "Tweet Title",
      description: "Plain meta description.",
    });
    const titleOnly = `<html><head><title>  Spaced   Title </title></head></html>`;
    expect(parseOpenGraph(titleOnly, "https://example.com/")).toEqual({
      title: "Spaced Title",
    });
  });

  it("reads attributes in any order and with single quotes", () => {
    const html = `<meta content='Single Quoted' property='og:title'>`;
    expect(parseOpenGraph(html, "https://example.com/")).toEqual({
      title: "Single Quoted",
    });
  });

  it("returns null when the page carries no usable metadata", () => {
    expect(
      parseOpenGraph(
        "<html><head></head><body>no meta</body></html>",
        "https://example.com/",
      ),
    ).toBeNull();
  });

  it("drops a non-http(s) og:image instead of keeping it", () => {
    const html = `<meta property="og:title" content="T"><meta property="og:image" content="data:image/png;base64,abc">`;
    expect(parseOpenGraph(html, "https://example.com/")).toEqual({ title: "T" });
  });

  it("decodes entities and truncates over-long values", () => {
    const html = `<meta property="og:title" content="${"x".repeat(250)}">
      <meta property="og:description" content="a &quot;quoted&quot; &#65; thing">`;
    const card = parseOpenGraph(html, "https://example.com/");
    expect(card?.title).toHaveLength(200);
    expect(card?.description).toBe('a "quoted" A thing');
  });
});

describe("fetchOpenGraph with a stub fetch (no live websites)", () => {
  function stubFetch(routes: Record<string, Response>): typeof fetch {
    return (async (input: string | URL | Request): Promise<Response> => {
      const res = routes[String(input)];
      if (!res) return new Response("not found", { status: 404 });
      return res;
    }) as typeof fetch;
  }

  const htmlResponse = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/html", ...headers },
    });

  it("fetches and parses a page, stamping fetchedAt and the final URL", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/article": htmlResponse(OG_PAGE),
    });
    const { card, fetchedUrl } = await fetchOpenGraph("https://example.com/article", {
      fetchImpl,
      lookup: publicLookup,
    });
    expect(fetchedUrl).toBe("https://example.com/article");
    expect(card?.title).toBe("The & Great Article");
    expect(card?.image).toBe("https://cdn.example.com/cover.jpg");
    expect(card?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns card null when the page has no metadata", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/blank": htmlResponse("<html><body>nothing</body></html>"),
    });
    const { card } = await fetchOpenGraph("https://example.com/blank", {
      fetchImpl,
      lookup: publicLookup,
    });
    expect(card).toBeNull();
  });

  it("follows redirects and reports the final URL", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/short": new Response(null, {
        status: 302,
        headers: { location: "/article" },
      }),
      "https://example.com/article": htmlResponse(OG_PAGE),
    });
    const { card, fetchedUrl } = await fetchOpenGraph("https://example.com/short", {
      fetchImpl,
      lookup: publicLookup,
    });
    expect(fetchedUrl).toBe("https://example.com/article");
    expect(card?.title).toBe("The & Great Article");
  });

  it("blocks a redirect hop to a private address", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/short": new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      }),
    });
    await expect(
      fetchOpenGraph("https://example.com/short", { fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "BLOCKED_PRIVATE_HOST" });
  });

  it("blocks a redirect to a non-http(s) scheme", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/short": new Response(null, {
        status: 302,
        headers: { location: "file:///etc/passwd" },
      }),
    });
    await expect(
      fetchOpenGraph("https://example.com/short", { fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "INVALID_URL" });
  });

  it("stops after the redirect limit", async () => {
    const looping: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/loop" },
      });
    await expect(
      fetchOpenGraph("https://example.com/loop", {
        fetchImpl: looping,
        lookup: publicLookup,
        maxRedirects: 3,
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
  });

  it("rejects non-http(s) input URLs", async () => {
    await expect(
      fetchOpenGraph("file:///etc/passwd", { lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "INVALID_URL" });
    await expect(
      fetchOpenGraph("not a url", { lookup: publicLookup }),
    ).rejects.toMatchObject({
      code: "INVALID_URL",
    });
  });

  it("rejects non-HTML responses", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/pic.png": new Response("fake-png", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    });
    await expect(
      fetchOpenGraph("https://example.com/pic.png", { fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "NOT_HTML" });
  });

  it("rejects HTTP errors", async () => {
    const fetchImpl = stubFetch({});
    await expect(
      fetchOpenGraph("https://example.com/missing", { fetchImpl, lookup: publicLookup }),
    ).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });

  it("enforces the response size cap", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/big": htmlResponse("x".repeat(500)),
    });
    await expect(
      fetchOpenGraph("https://example.com/big", {
        fetchImpl,
        lookup: publicLookup,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("enforces the timeout", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out.", "TimeoutError")),
        );
      });
    await expect(
      fetchOpenGraph("https://example.com/slow", {
        fetchImpl: hanging,
        lookup: publicLookup,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("fetchOpenGraph SSRF guard with the real fetch (local loopback server)", () => {
  it("never issues a request to a loopback URL", async () => {
    let hits = 0;
    loopbackServer = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(OG_PAGE);
    });
    await new Promise<void>((resolve) => loopbackServer!.listen(0, "127.0.0.1", resolve));
    const address = loopbackServer.address();
    if (!address || typeof address === "string") throw new Error("no loopback address");
    const url = `http://127.0.0.1:${address.port}/`;

    let caught: unknown;
    try {
      await fetchOpenGraph(url);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LinkCardFetchError);
    expect(caught).toMatchObject({ code: "BLOCKED_PRIVATE_HOST" });
    expect(hits).toBe(0);
  });

  it("blocks localhost by hostname too", async () => {
    await expect(fetchOpenGraph("http://localhost:9/")).rejects.toMatchObject({
      code: "BLOCKED_PRIVATE_HOST",
    });
  });
});
