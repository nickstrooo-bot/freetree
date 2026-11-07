import { describe, expect, it, vi } from "vitest";
import { createCallerFactory, type TrpcContext } from "@kytelink/trpc";
import { loadConfig, setConfigForTest } from "../config";
import { logger } from "../logger";
import { createSeededStore, type MemoryStore } from "../store/memory-store";
import { createAnalyticsRouter } from "./analytics-router";
import { SqliteAnalyticsStore } from "./sqlite-store";

const createCaller = createCallerFactory(
  createAnalyticsRouter({
    redis: {
      get: vi.fn(async () => null),
      set: vi.fn(async (): Promise<"OK"> => "OK"),
    },
  }),
);

function contextFor(store: MemoryStore, ch: SqliteAnalyticsStore): TrpcContext {
  return {
    session: {
      userId: "usr_agent",
      email: "agent@kytelink.dev",
      isAdmin: false,
      status: "ACTIVE",
    },
    user: { id: "usr_agent", email: "agent@kytelink.dev" },
    ip: "127.0.0.1",
    redis: null,
    db: store,
    ch,
    log: logger,
  } as unknown as TrpcContext;
}

describe("analytics router on the SQLite store", () => {
  it("serves real rollups to the seller dashboard queries", async () => {
    setConfigForTest(loadConfig({ ...process.env }));
    const ch = new SqliteAnalyticsStore(":memory:");
    const store = createSeededStore();
    const caller = createCaller(await contextFor(store, ch));

    await ch.insertPageHits([
      {
        ts: new Date().toISOString().slice(0, 10) + " 10:00:00.000",
        kyte_id: "kyte_ag_1",
        username: "agent",
        referrer: "https://www.google.com/search",
        ref_domain: "google.com",
        country: "US",
        device: "MOBILE",
        ip_hash: "a",
        is_bot: 0,
      },
      {
        ts: new Date().toISOString().slice(0, 10) + " 11:00:00.000",
        kyte_id: "kyte_ag_1",
        username: "agent",
        referrer: "https://instagram.com/",
        ref_domain: "instagram.com",
        country: "DE",
        device: "DESKTOP",
        ip_hash: "b",
        is_bot: 0,
      },
    ]);
    await ch.insertLinkHits([
      {
        ts: new Date().toISOString().slice(0, 10) + " 10:05:00.000",
        kyte_id: "kyte_ag_1",
        username: "agent",
        referrer: "https://www.google.com/search",
        ref_domain: "google.com",
        country: "US",
        device: "MOBILE",
        ip_hash: "a",
        is_bot: 0,
        link_url: "https://example.com/shop",
        link_title: "Shop",
      },
    ]);

    const input = { kyteId: "kyte_ag_1", days: 30 };
    await expect(caller.overview(input)).resolves.toEqual({
      totalViews: 2,
      totalClicks: 1,
    });
    const series = await caller.timeSeries(input);
    expect(series.points).toHaveLength(1);
    expect(series.points[0]?.views).toBe(2);
    await expect(caller.topLinks(input)).resolves.toEqual({
      links: [{ linkUrl: "https://example.com/shop", linkTitle: "Shop", clicks: 1 }],
    });
    // Ties (1–1) have no defined order in either backend — compare sorted.
    const byRef = (rows: { refDomain: string }[]) =>
      [...rows].sort((a, b) => a.refDomain.localeCompare(b.refDomain));
    const referrers = await caller.referrers(input);
    expect(byRef(referrers.referrers)).toEqual([
      { refDomain: "google.com", views: 1 },
      { refDomain: "instagram.com", views: 1 },
    ]);
    const byDevice = (rows: { device: string }[]) =>
      [...rows].sort((a, b) => a.device.localeCompare(b.device));
    const devices = await caller.devices(input);
    expect(byDevice(devices.devices)).toEqual([
      { device: "DESKTOP", views: 1 },
      { device: "MOBILE", views: 1 },
    ]);
    const byCountry = (rows: { country: string }[]) =>
      [...rows].sort((a, b) => a.country.localeCompare(b.country));
    const countries = await caller.countries(input);
    expect(byCountry(countries.countries)).toEqual([
      { country: "DE", views: 1 },
      { country: "US", views: 1 },
    ]);
    await ch.close();
  });
});
