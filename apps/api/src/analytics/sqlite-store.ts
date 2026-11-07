import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Clickhouse,
  LinkHitRow,
  PageHitRow,
  ProductEventRow,
} from "@kytelink/clickhouse";

// LinkBreeze-pattern analytics store: privacy-first page views, link clicks
// and product events in a SINGLE SQLite file — no ClickHouse, no new service,
// no new infrastructure (the $0 answer to the analytics gap). It implements
// the existing `Clickhouse` interface, so the beacon ingest pipeline, the
// per-kyte query router and the seller dashboard work unchanged whichever
// backend is selected; only the storage underneath differs.
//
// Privacy shape (same as the ClickHouse path): raw IPs are never stored —
// ingest hashes them with a daily-rotating salt before they get here —
// referrers are stored as domains only, and bots are stored but excluded
// from every rollup, mirroring the ClickHouse daily materialised views
// (`WHERE is_bot = 0`).
//
// Retention matches the dashboard's promise: up to 12 months of history.
// Rows older than 365 days are pruned opportunistically (at most once an
// hour, on the insert path), so the file stays bounded on a small disk.

export const DEFAULT_ANALYTICS_SQLITE_PATH = "data/analytics.db";

/** Longest window the dashboard offers ("Last 12 months"). */
export const MAX_ANALYTICS_WINDOW_DAYS = 365;

const RETENTION_DAYS = 365;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TOP_LINKS_LIMIT = 50;
const TOP_REFERRERS_LIMIT = 8;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS page_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kyte_id TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  ref_domain TEXT NOT NULL DEFAULT 'direct',
  country TEXT NOT NULL DEFAULT 'XX',
  device TEXT NOT NULL DEFAULT 'UNKNOWN',
  ip_hash TEXT NOT NULL DEFAULT '',
  is_bot INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS page_hits_kyte_ts_idx ON page_hits (kyte_id, ts);
CREATE TABLE IF NOT EXISTS link_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kyte_id TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  ref_domain TEXT NOT NULL DEFAULT 'direct',
  country TEXT NOT NULL DEFAULT 'XX',
  device TEXT NOT NULL DEFAULT 'UNKNOWN',
  ip_hash TEXT NOT NULL DEFAULT '',
  is_bot INTEGER NOT NULL DEFAULT 0,
  link_url TEXT NOT NULL,
  link_title TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS link_hits_kyte_ts_idx ON link_hits (kyte_id, ts);
CREATE TABLE IF NOT EXISTS product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  kyte_id TEXT NOT NULL DEFAULT '',
  anonymous_id TEXT NOT NULL DEFAULT '',
  properties TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS product_events_kyte_ts_idx ON product_events (kyte_id, ts);
`;

function clampDays(days: number): number {
  return Math.min(Math.max(1, Math.trunc(days)), MAX_ANALYTICS_WINDOW_DAYS);
}

/** `date('now', '-N days')` modifier for the window cutoff. */
function windowModifier(days: number): string {
  return `-${clampDays(days)} days`;
}

/**
 * Where the analytics file lives. `ANALYTICS_SQLITE_PATH` wins when set;
 * otherwise `data/analytics.db` under the process working directory (the
 * Railway API service root in production). `:memory:` is honoured verbatim
 * for tests — it must not be resolved against the cwd.
 */
export function resolveAnalyticsSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.ANALYTICS_SQLITE_PATH ?? "").trim();
  const raw = configured.length > 0 ? configured : DEFAULT_ANALYTICS_SQLITE_PATH;
  if (raw === ":memory:" || isAbsolute(raw)) return raw;
  return resolve(process.cwd(), raw);
}

export function createSqliteAnalyticsStore(path?: string): SqliteAnalyticsStore {
  return new SqliteAnalyticsStore(path ?? resolveAnalyticsSqlitePath());
}

export class SqliteAnalyticsStore implements Clickhouse {
  readonly enabled = true;
  private readonly path: string;
  private handle: DatabaseSync | null = null;
  private lastPruneAtMs = 0;

  constructor(path: string) {
    this.path = path;
  }

  /** Lazily opens the file (creating it and its parent dir) on first use, so
   * merely importing the analytics module never touches the filesystem. */
  private db(): DatabaseSync {
    if (this.handle) return this.handle;
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    const db = new DatabaseSync(this.path, { open: false, timeout: 5000 });
    db.open();
    db.exec(SCHEMA_SQL);
    this.handle = db;
    return db;
  }

  private pruneIfDue(): void {
    const now = Date.now();
    if (now - this.lastPruneAtMs < PRUNE_INTERVAL_MS) return;
    this.lastPruneAtMs = now;
    const cutoff = `-${RETENTION_DAYS} days`;
    const db = this.db();
    db.prepare("DELETE FROM page_hits WHERE date(ts) < date('now', ?)").run(cutoff);
    db.prepare("DELETE FROM link_hits WHERE date(ts) < date('now', ?)").run(cutoff);
    db.prepare("DELETE FROM product_events WHERE date(ts) < date('now', ?)").run(cutoff);
  }

  private insertBatch(sql: string, rows: readonly (string | number)[][]): void {
    if (rows.length === 0) return;
    const db = this.db();
    this.pruneIfDue();
    const stmt = db.prepare(sql);
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const row of rows) stmt.run(...row);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The connection is already unusable; surface the original error.
      }
      throw error;
    }
  }

  async insertPageHits(rows: readonly PageHitRow[]): Promise<void> {
    this.insertBatch(
      `INSERT INTO page_hits
         (ts, kyte_id, username, referrer, ref_domain, country, device, ip_hash, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows.map((row) => [
        row.ts,
        row.kyte_id,
        row.username,
        row.referrer,
        row.ref_domain,
        row.country,
        row.device,
        row.ip_hash,
        row.is_bot,
      ]),
    );
  }

  async insertLinkHits(rows: readonly LinkHitRow[]): Promise<void> {
    this.insertBatch(
      `INSERT INTO link_hits
         (ts, kyte_id, username, referrer, ref_domain, country, device, ip_hash, is_bot, link_url, link_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows.map((row) => [
        row.ts,
        row.kyte_id,
        row.username,
        row.referrer,
        row.ref_domain,
        row.country,
        row.device,
        row.ip_hash,
        row.is_bot,
        row.link_url,
        row.link_title,
      ]),
    );
  }

  async insertProductEvents(rows: readonly ProductEventRow[]): Promise<void> {
    this.insertBatch(
      `INSERT INTO product_events (ts, event, user_id, kyte_id, anonymous_id, properties)
       VALUES (?, ?, ?, ?, ?, ?)`,
      rows.map((row) => [
        row.ts,
        row.event,
        row.user_id,
        row.kyte_id,
        row.anonymous_id,
        row.properties,
      ]),
    );
  }

  async overview(args: {
    kyteId: string;
    days: number;
  }): Promise<{ totalViews: number; totalClicks: number }> {
    const cutoff = windowModifier(args.days);
    const row = this.db()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM page_hits
             WHERE kyte_id = ? AND is_bot = 0 AND date(ts) >= date('now', ?)) AS views,
           (SELECT COUNT(*) FROM link_hits
             WHERE kyte_id = ? AND is_bot = 0 AND date(ts) >= date('now', ?)) AS clicks`,
      )
      .get(args.kyteId, cutoff, args.kyteId, cutoff) as
      { views: number; clicks: number } | undefined;
    return { totalViews: row?.views ?? 0, totalClicks: row?.clicks ?? 0 };
  }

  async timeSeries(args: {
    kyteId: string;
    days: number;
  }): Promise<{ date: string; views: number }[]> {
    const rows = this.db()
      .prepare(
        `SELECT date(ts) AS date, COUNT(*) AS views FROM page_hits
         WHERE kyte_id = ? AND is_bot = 0 AND date(ts) >= date('now', ?)
         GROUP BY date(ts) ORDER BY date(ts)`,
      )
      .all(args.kyteId, windowModifier(args.days)) as { date: string; views: number }[];
    return rows.map((row) => ({ date: row.date, views: row.views }));
  }

  async topLinks(args: {
    kyteId: string;
    days: number;
  }): Promise<{ linkUrl: string; linkTitle: string; clicks: number }[]> {
    const rows = this.db()
      .prepare(
        `SELECT link_url, MAX(link_title) AS link_title, COUNT(*) AS clicks FROM link_hits
         WHERE kyte_id = ? AND is_bot = 0 AND date(ts) >= date('now', ?)
         GROUP BY link_url ORDER BY clicks DESC LIMIT ${TOP_LINKS_LIMIT}`,
      )
      .all(args.kyteId, windowModifier(args.days)) as {
      link_url: string;
      link_title: string;
      clicks: number;
    }[];
    return rows.map((row) => ({
      linkUrl: row.link_url,
      linkTitle: row.link_title,
      clicks: row.clicks,
    }));
  }

  async referrers(args: {
    kyteId: string;
    days: number;
  }): Promise<{ refDomain: string; views: number }[]> {
    const rows = this.db()
      .prepare(
        `SELECT ref_domain, COUNT(*) AS views FROM page_hits
         WHERE kyte_id = ? AND is_bot = 0 AND date(ts) >= date('now', ?)
         GROUP BY ref_domain ORDER BY views DESC LIMIT ${TOP_REFERRERS_LIMIT}`,
      )
      .all(args.kyteId, windowModifier(args.days)) as {
      ref_domain: string;
      views: number;
    }[];
    return rows.map((row) => ({ refDomain: row.ref_domain, views: row.views }));
  }

  async devices(args: {
    kyteId: string;
    days: number;
  }): Promise<{ device: PageHitRow["device"]; views: number }[]> {
    const rows = this.db()
      .prepare(
        `SELECT device, COUNT(*) AS views FROM page_hits
         WHERE kyte_id = ? AND is_bot = 0 AND date(ts) >= date('now', ?)
         GROUP BY device ORDER BY views DESC`,
      )
      .all(args.kyteId, windowModifier(args.days)) as { device: string; views: number }[];
    return rows.map((row) => ({
      device: row.device as PageHitRow["device"],
      views: row.views,
    }));
  }

  async countries(args: {
    kyteId: string;
    days: number;
  }): Promise<{ country: string; views: number }[]> {
    const rows = this.db()
      .prepare(
        `SELECT country, COUNT(*) AS views FROM page_hits
         WHERE kyte_id = ? AND is_bot = 0 AND date(ts) >= date('now', ?)
         GROUP BY country ORDER BY views DESC`,
      )
      .all(args.kyteId, windowModifier(args.days)) as {
      country: string;
      views: number;
    }[];
    return rows.map((row) => ({ country: row.country, views: row.views }));
  }

  async platformSeries(args: {
    days: number;
  }): Promise<{ date: string; views: number; clicks: number; uniqKytes: number }[]> {
    const cutoff = windowModifier(args.days);
    const rows = this.db()
      .prepare(
        `SELECT d.date AS date,
           COALESCE(v.views, 0) AS views,
           COALESCE(c.clicks, 0) AS clicks,
           COALESCE(v.uniq_kytes, 0) AS uniqKytes
         FROM (
           SELECT date(ts) AS date FROM page_hits
           WHERE is_bot = 0 AND date(ts) >= date('now', ?) GROUP BY date(ts)
           UNION
           SELECT date(ts) AS date FROM link_hits
           WHERE is_bot = 0 AND date(ts) >= date('now', ?) GROUP BY date(ts)
         ) AS d
         LEFT JOIN (
           SELECT date(ts) AS date, COUNT(*) AS views, COUNT(DISTINCT kyte_id) AS uniq_kytes
           FROM page_hits WHERE is_bot = 0 AND date(ts) >= date('now', ?) GROUP BY date(ts)
         ) AS v ON v.date = d.date
         LEFT JOIN (
           SELECT date(ts) AS date, COUNT(*) AS clicks
           FROM link_hits WHERE is_bot = 0 AND date(ts) >= date('now', ?) GROUP BY date(ts)
         ) AS c ON c.date = d.date
         ORDER BY d.date`,
      )
      .all(cutoff, cutoff, cutoff, cutoff) as {
      date: string;
      views: number;
      clicks: number;
      uniqKytes: number;
    }[];
    return rows.map((row) => ({
      date: row.date,
      views: row.views,
      clicks: row.clicks,
      uniqKytes: row.uniqKytes,
    }));
  }

  async topKytes(args: {
    days: number;
    limit: number;
  }): Promise<{ kyteId: string; views: number }[]> {
    const rows = this.db()
      .prepare(
        `SELECT kyte_id, COUNT(*) AS views FROM page_hits
         WHERE is_bot = 0 AND date(ts) >= date('now', ?)
         GROUP BY kyte_id ORDER BY views DESC LIMIT ?`,
      )
      .all(windowModifier(args.days), Math.max(1, Math.trunc(args.limit))) as {
      kyte_id: string;
      views: number;
    }[];
    return rows.map((row) => ({ kyteId: row.kyte_id, views: row.views }));
  }

  async ping(): Promise<boolean> {
    try {
      this.db().prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.handle) {
      this.handle.close();
      this.handle = null;
    }
  }
}
