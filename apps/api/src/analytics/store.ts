import {
  getClickhouse,
  readClickhouseConfig,
  type Clickhouse,
} from "@kytelink/clickhouse";
import { parseBoolEnv } from "@kytelink/schemas";
import { createSqliteAnalyticsStore, resolveAnalyticsSqlitePath } from "./sqlite-store";

// The analytics backend selector. ClickHouse wins when it is configured
// (self-hosters who already run it keep exactly the old behaviour); otherwise
// the built-in single-file SQLite store serves the same `Clickhouse`
// interface, so ingest, the per-kyte router and the dashboard never know
// which backend is underneath. `ANALYTICS_DISABLED=true` turns analytics
// off entirely (the selector then returns the Noop client).

let singleton: Clickhouse | undefined;

export function getAnalyticsStore(env: NodeJS.ProcessEnv = process.env): Clickhouse {
  if (singleton) return singleton;
  if (readClickhouseConfig(env)) {
    singleton = getClickhouse(env);
    return singleton;
  }
  if (parseBoolEnv(env.ANALYTICS_DISABLED)) {
    singleton = getClickhouse(env);
    return singleton;
  }
  singleton = createSqliteAnalyticsStore(resolveAnalyticsSqlitePath(env));
  return singleton;
}

export function resetAnalyticsStoreForTest(): void {
  singleton = undefined;
}
