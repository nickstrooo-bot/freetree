import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClickhouse, resetClickhouse } from "@kytelink/clickhouse";
import { getAnalyticsStore, resetAnalyticsStoreForTest } from "./store";
import { SqliteAnalyticsStore } from "./sqlite-store";

function tmpPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "freetree-analytics-store-"));
  return { dir, path: join(dir, "analytics.db") };
}

describe("getAnalyticsStore", () => {
  let dirs: string[] = [];

  beforeEach(() => {
    dirs = [];
    resetAnalyticsStoreForTest();
    resetClickhouse();
  });

  afterEach(async () => {
    const store = getAnalyticsStore({ ANALYTICS_SQLITE_PATH: ":memory:" });
    // Only close when this worker actually opened a SQLite store; the Noop
    // and Live clients are unaffected by close().
    await store.close().catch(() => undefined);
    resetAnalyticsStoreForTest();
    resetClickhouse();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to the SQLite store with no ClickHouse configured", async () => {
    const { dir, path } = tmpPath();
    dirs.push(dir);
    const store = getAnalyticsStore({ ANALYTICS_SQLITE_PATH: path });
    expect(store).toBeInstanceOf(SqliteAnalyticsStore);
    expect(store.enabled).toBe(true);
    await expect(store.ping()).resolves.toBe(true);
  });

  it("returns the same instance on repeat calls", () => {
    const { dir, path } = tmpPath();
    dirs.push(dir);
    const env = { ANALYTICS_SQLITE_PATH: path };
    expect(getAnalyticsStore(env)).toBe(getAnalyticsStore(env));
  });

  it("returns the disabled Noop client with ANALYTICS_DISABLED=true", async () => {
    const { dir, path } = tmpPath();
    dirs.push(dir);
    const store = getAnalyticsStore({
      ANALYTICS_DISABLED: "true",
      ANALYTICS_SQLITE_PATH: path,
    });
    expect(store).not.toBeInstanceOf(SqliteAnalyticsStore);
    expect(store.enabled).toBe(false);
    await expect(store.overview({ kyteId: "k_1", days: 30 })).resolves.toEqual({
      totalViews: 0,
      totalClicks: 0,
    });
  });

  it("prefers ClickHouse when CLICKHOUSE_URL is set", () => {
    const { dir, path } = tmpPath();
    dirs.push(dir);
    const env = { CLICKHOUSE_URL: "http://localhost:8123", ANALYTICS_SQLITE_PATH: path };
    expect(getAnalyticsStore(env)).toBe(getClickhouse(env));
  });
});
