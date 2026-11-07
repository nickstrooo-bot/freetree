import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { formatClickhouseTimestamp, type PageHitRow } from "@kytelink/clickhouse";
import { ingestBeacon } from "./ingest-beacon";
import { resolveAnalyticsSqlitePath, SqliteAnalyticsStore } from "./sqlite-store";

const DAY_MS = 24 * 60 * 60 * 1000;

function ts(daysAgo: number): string {
  return formatClickhouseTimestamp(new Date(Date.now() - daysAgo * DAY_MS));
}

function pageHit(overrides: Partial<PageHitRow> = {}): PageHitRow {
  return {
    ts: ts(0),
    kyte_id: "k_1",
    username: "seller",
    referrer: "https://www.google.com/search",
    ref_domain: "google.com",
    country: "US",
    device: "MOBILE",
    ip_hash: "abc123",
    is_bot: 0,
    ...overrides,
  };
}

function tmpFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "freetree-analytics-"));
  return { dir, path: join(dir, "analytics.db") };
}

describe("resolveAnalyticsSqlitePath", () => {
  it("defaults to data/analytics.db under the working directory", () => {
    expect(resolveAnalyticsSqlitePath({})).toBe(
      join(process.cwd(), "data", "analytics.db"),
    );
  });

  it("honours ANALYTICS_SQLITE_PATH, relative or absolute", () => {
    expect(resolveAnalyticsSqlitePath({ ANALYTICS_SQLITE_PATH: "elsewhere/a.db" })).toBe(
      join(process.cwd(), "elsewhere", "a.db"),
    );
    expect(resolveAnalyticsSqlitePath({ ANALYTICS_SQLITE_PATH: "/var/lib/a.db" })).toBe(
      "/var/lib/a.db",
    );
  });

  it("leaves :memory: alone", () => {
    expect(resolveAnalyticsSqlitePath({ ANALYTICS_SQLITE_PATH: ":memory:" })).toBe(
      ":memory:",
    );
  });
});

describe("SqliteAnalyticsStore — empty", () => {
  it("returns zeros and empty lists, and pings true", async () => {
    const store = new SqliteAnalyticsStore(":memory:");
    await expect(store.ping()).resolves.toBe(true);
    await expect(store.overview({ kyteId: "k_1", days: 30 })).resolves.toEqual({
      totalViews: 0,
      totalClicks: 0,
    });
    await expect(store.timeSeries({ kyteId: "k_1", days: 30 })).resolves.toEqual([]);
    await expect(store.topLinks({ kyteId: "k_1", days: 30 })).resolves.toEqual([]);
    await expect(store.referrers({ kyteId: "k_1", days: 30 })).resolves.toEqual([]);
    await expect(store.devices({ kyteId: "k_1", days: 30 })).resolves.toEqual([]);
    await expect(store.countries({ kyteId: "k_1", days: 30 })).resolves.toEqual([]);
    await expect(store.platformSeries({ days: 30 })).resolves.toEqual([]);
    await expect(store.topKytes({ days: 30, limit: 10 })).resolves.toEqual([]);
    await store.close();
  });
});

describe("SqliteAnalyticsStore — rollups", () => {
  it("counts views and clicks, and excludes bots like the ClickHouse rollups", async () => {
    const store = new SqliteAnalyticsStore(":memory:");
    await store.insertPageHits([
      pageHit(),
      pageHit({ ip_hash: "def456" }),
      pageHit({ is_bot: 1, ip_hash: "bot999" }),
    ]);
    await store.insertLinkHits([
      {
        ...pageHit({ ip_hash: "abc123" }),
        link_url: "https://example.com/a",
        link_title: "A",
      },
      {
        ...pageHit({ ip_hash: "abc123", is_bot: 1 }),
        link_url: "https://example.com/a",
        link_title: "A",
      },
    ]);

    await expect(store.overview({ kyteId: "k_1", days: 30 })).resolves.toEqual({
      totalViews: 2,
      totalClicks: 1,
    });
    await store.close();
  });

  it("groups the time series by day and respects the window", async () => {
    const store = new SqliteAnalyticsStore(":memory:");
    await store.insertPageHits([
      pageHit({ ts: ts(0) }),
      pageHit({ ts: ts(0), ip_hash: "b" }),
      pageHit({ ts: ts(2), ip_hash: "c" }),
      pageHit({ ts: ts(31), ip_hash: "d" }),
    ]);

    const points = await store.timeSeries({ kyteId: "k_1", days: 30 });
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ date: ts(2).slice(0, 10), views: 1 });
    expect(points[1]).toEqual({ date: ts(0).slice(0, 10), views: 2 });
    await store.close();
  });

  it("clamps the window to 1..365 days", async () => {
    const store = new SqliteAnalyticsStore(":memory:");
    await store.insertPageHits([
      pageHit({ ts: ts(0), ip_hash: "today" }),
      pageHit({ ts: ts(1), ip_hash: "yesterday" }),
      pageHit({ ts: ts(364), ip_hash: "almost-year" }),
      pageHit({ ts: ts(400), ip_hash: "too-old" }),
    ]);

    // days=0 clamps to 1, and like ClickHouse's `date >= today() - days` a
    // 1-day window covers yesterday + today.
    await expect(store.timeSeries({ kyteId: "k_1", days: 0 })).resolves.toEqual([
      { date: ts(1).slice(0, 10), views: 1 },
      { date: ts(0).slice(0, 10), views: 1 },
    ]);
    // days=400 clamps to 365: the 400-day row stays out, the 364-day row is in.
    const points = await store.timeSeries({ kyteId: "k_1", days: 400 });
    expect(points.map((point) => point.date)).toEqual([
      ts(364).slice(0, 10),
      ts(1).slice(0, 10),
      ts(0).slice(0, 10),
    ]);
    await store.close();
  });

  it("ranks top links, referrers, devices and countries", async () => {
    const store = new SqliteAnalyticsStore(":memory:");
    const link = (url: string, title: string, hash: string) => ({
      ...pageHit({ ip_hash: hash }),
      link_url: url,
      link_title: title,
    });
    await store.insertPageHits([
      pageHit({
        ip_hash: "a",
        device: "MOBILE",
        country: "US",
        ref_domain: "google.com",
      }),
      pageHit({
        ip_hash: "b",
        device: "DESKTOP",
        country: "DE",
        ref_domain: "instagram.com",
      }),
      pageHit({
        ip_hash: "c",
        device: "MOBILE",
        country: "US",
        ref_domain: "google.com",
      }),
    ]);
    await store.insertLinkHits([
      link("https://example.com/a", "A", "a"),
      link("https://example.com/a", "A", "b"),
      link("https://example.com/b", "B", "c"),
    ]);

    await expect(store.topLinks({ kyteId: "k_1", days: 30 })).resolves.toEqual([
      { linkUrl: "https://example.com/a", linkTitle: "A", clicks: 2 },
      { linkUrl: "https://example.com/b", linkTitle: "B", clicks: 1 },
    ]);
    await expect(store.referrers({ kyteId: "k_1", days: 30 })).resolves.toEqual([
      { refDomain: "google.com", views: 2 },
      { refDomain: "instagram.com", views: 1 },
    ]);
    await expect(store.devices({ kyteId: "k_1", days: 30 })).resolves.toEqual([
      { device: "MOBILE", views: 2 },
      { device: "DESKTOP", views: 1 },
    ]);
    await expect(store.countries({ kyteId: "k_1", days: 30 })).resolves.toEqual([
      { country: "US", views: 2 },
      { country: "DE", views: 1 },
    ]);
    await store.close();
  });

  it("caps top links at 50 and referrers at 8", async () => {
    const store = new SqliteAnalyticsStore(":memory:");
    await store.insertLinkHits(
      Array.from({ length: 55 }, (_, i) => ({
        ...pageHit({ ip_hash: `h${i}` }),
        link_url: `https://example.com/${i}`,
        link_title: `L${i}`,
      })),
    );
    await store.insertPageHits(
      Array.from({ length: 10 }, (_, i) =>
        pageHit({ ip_hash: `r${i}`, ref_domain: `d${i}.com` }),
      ),
    );
    expect((await store.topLinks({ kyteId: "k_1", days: 30 })).length).toBe(50);
    expect((await store.referrers({ kyteId: "k_1", days: 30 })).length).toBe(8);
    await store.close();
  });

  it("platformSeries counts distinct kytes and keeps click-only days", async () => {
    const store = new SqliteAnalyticsStore(":memory:");
    await store.insertPageHits([
      pageHit({ kyte_id: "k_1", ts: ts(1), ip_hash: "a" }),
      pageHit({ kyte_id: "k_2", ts: ts(1), ip_hash: "b" }),
      pageHit({ kyte_id: "k_1", ts: ts(0), ip_hash: "c" }),
    ]);
    await store.insertLinkHits([
      {
        ...pageHit({ kyte_id: "k_1", ts: ts(1), ip_hash: "a" }),
        link_url: "https://x.test/1",
        link_title: "X",
      },
      // A click on a day with no page view still appears in the series.
      {
        ...pageHit({ kyte_id: "k_2", ts: ts(3), ip_hash: "d" }),
        link_url: "https://x.test/2",
        link_title: "Y",
      },
    ]);

    await expect(store.platformSeries({ days: 30 })).resolves.toEqual([
      { date: ts(3).slice(0, 10), views: 0, clicks: 1, uniqKytes: 0 },
      { date: ts(1).slice(0, 10), views: 2, clicks: 1, uniqKytes: 2 },
      { date: ts(0).slice(0, 10), views: 1, clicks: 0, uniqKytes: 1 },
    ]);
    await expect(store.topKytes({ days: 30, limit: 10 })).resolves.toEqual([
      { kyteId: "k_1", views: 2 },
      { kyteId: "k_2", views: 1 },
    ]);
    await expect(store.topKytes({ days: 30, limit: 1 })).resolves.toEqual([
      { kyteId: "k_1", views: 2 },
    ]);
    await store.close();
  });

  it("stores product events (checked at the file level)", async () => {
    const { dir, path } = tmpFile();
    try {
      const store = new SqliteAnalyticsStore(path);
      await store.insertProductEvents([
        {
          ts: ts(0),
          event: "profile_published",
          user_id: "u_1",
          kyte_id: "k_1",
          anonymous_id: "",
          properties: JSON.stringify({ via: "editor" }),
        },
      ]);
      await store.close();

      const raw = new DatabaseSync(path, { readOnly: true });
      const count = raw.prepare("SELECT COUNT(*) AS c FROM product_events").get() as {
        c: number;
      };
      expect(count.c).toBe(1);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists across reopen and prunes rows older than 365 days", async () => {
    const { dir, path } = tmpFile();
    try {
      const first = new SqliteAnalyticsStore(path);
      await first.insertPageHits([pageHit({ ts: ts(400), ip_hash: "old" })]);
      await first.close();

      // A fresh instance on the same file sees the old row…
      const second = new SqliteAnalyticsStore(path);
      await expect(second.overview({ kyteId: "k_1", days: 365 })).resolves.toEqual({
        totalViews: 0,
        totalClicks: 0,
      });
      // …but its next insert triggers the opportunistic prune, which drops it.
      await second.insertPageHits([pageHit({ ts: ts(0), ip_hash: "new" })]);
      const raw = new DatabaseSync(path, { readOnly: true });
      const rows = raw.prepare("SELECT ip_hash AS h FROM page_hits").all() as {
        h: string;
      }[];
      expect(rows.map((row) => row.h)).toEqual(["new"]);
      raw.close();
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SqliteAnalyticsStore — ingest pipeline wiring", () => {
  function fakeRedis() {
    const strings = new Map<string, string>();
    const counters = new Map<string, number>();
    return {
      get: vi.fn(async (key: string) => strings.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        strings.set(key, value);
        return "OK";
      }),
      del: vi.fn(async () => 1),
      incr: vi.fn(async (key: string) => {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      }),
      pexpire: vi.fn(async () => 1),
      pttl: vi.fn(async () => -1),
      rpush: vi.fn(async () => 0),
      lpush: vi.fn(async () => 0),
      lpop: vi.fn(async () => null),
      llen: vi.fn(async () => 0),
    };
  }

  it("the existing beacon pipeline writes into SQLite end to end", async () => {
    const store = new SqliteAnalyticsStore(":memory:");
    const deps = {
      ch: store,
      redis: fakeRedis(),
      db: {
        publishedKyte: { findUnique: vi.fn().mockResolvedValue({ kyteId: "k_1" }) },
      },
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    } as unknown as Parameters<typeof ingestBeacon>[0];

    await ingestBeacon(deps, "page", {
      ip: "203.0.113.7",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      headers: { "cf-ipcountry": "US" },
      body: {
        username: "seller",
        kyteId: "k_1",
        referrer: "https://www.google.com/search",
      },
    });
    await ingestBeacon(deps, "link", {
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      headers: { "cf-ipcountry": "US" },
      body: {
        username: "seller",
        kyteId: "k_1",
        referrer: "https://www.google.com/search",
        linkUrl: "https://example.com/shop",
        linkTitle: "Shop",
      },
    });

    await expect(store.overview({ kyteId: "k_1", days: 30 })).resolves.toEqual({
      totalViews: 1,
      totalClicks: 1,
    });
    await expect(store.topLinks({ kyteId: "k_1", days: 30 })).resolves.toEqual([
      { linkUrl: "https://example.com/shop", linkTitle: "Shop", clicks: 1 },
    ]);
    await expect(store.devices({ kyteId: "k_1", days: 30 })).resolves.toEqual([
      { device: "MOBILE", views: 1 },
    ]);
    await store.close();
  });
});
