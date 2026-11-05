#!/usr/bin/env node
// FreeTree Railway DB repair (Nov 5 2026, v4 — idempotent).
// Repairs the failed 20261105000000_promo_codes_booking_blocks migration.
// Root cause: five models (Product, Purchase, StripeConnectAccount,
// EmailCaptureBlock, EmailSubscriber) never got CREATE TABLE migrations upstream,
// so the promo/booking ALTER failed with `relation "Product" does not exist`.
// Fixed by migration 20261104000000_create_missing_commerce_tables, which sorts
// before it and creates the tables first.
//
// v4 change: DO NOT trust `prisma migrate status` text to detect the failed
// migration — its output omits the failed section when a pending migration
// also exists. Instead, query _prisma_migrations directly: a row with
// finished_at NULL means the migration is currently failed. Safe to run on
// every container start.
import { spawnSync } from "node:child_process";

const MIGRATION = "20261105000000_promo_codes_booking_blocks";
const SCHEMA = "prisma/schema.prisma";

function prisma(args, input) {
  return spawnSync("pnpm", ["--filter", "@kytelink/db", "exec", "prisma", ...args], {
    input,
    encoding: "utf8",
  });
}

function fail(msg) {
  console.error(`\n✗ railway-db-fix: ${msg}\n`);
  process.exit(1);
}

function sql(query) {
  const r = prisma(["db", "execute", "--schema", SCHEMA, "--stdin"], query);
  return r;
}

function countColumns() {
  const r = sql(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('Product','Kyte','PublishedKyte') AND column_name IN ('allowPromoCodes','bookingBlocks') ORDER BY 1, 2;`,
  );
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (r.status !== 0) fail("column check failed — cannot determine migration state");
  return (r.stdout.match(/allowPromoCodes|bookingBlocks/g) ?? []).length;
}

console.log("─── railway-db-fix: is the migration currently failed? (direct DB check) ───");
const failedCheck = sql(
  `SELECT 'MIGRATION_FAILED_MARKER' AS m WHERE EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '${MIGRATION}' AND finished_at IS NULL);`,
);
process.stdout.write(failedCheck.stdout ?? "");
process.stderr.write(failedCheck.stderr ?? "");
if (failedCheck.status !== 0) fail("failed-state check failed");
const isFailed = (failedCheck.stdout ?? "").includes("MIGRATION_FAILED_MARKER");
console.log(`\nMigration ${MIGRATION} failed: ${isFailed}`);

if (isFailed) {
  console.log(`\n─── railway-db-fix: ${MIGRATION} is FAILED — inspecting ground truth ───`);
  const found = countColumns();
  console.log(`\nFound ${found} of 3 expected new columns.`);
  if (found === 3) {
    console.log(`All columns exist — marking ${MIGRATION} as --applied.`);
    const r = prisma(["migrate", "resolve", "--applied", MIGRATION, "--schema", SCHEMA]);
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    if (r.status !== 0) fail(`migrate resolve --applied failed (exit ${r.status})`);
  } else if (found === 0) {
    console.log(`No columns exist — marking ${MIGRATION} as --rolled-back.`);
    const r = prisma(["migrate", "resolve", "--rolled-back", MIGRATION, "--schema", SCHEMA]);
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    if (r.status !== 0) fail(`migrate resolve --rolled-back failed (exit ${r.status})`);
  } else {
    fail(`PARTIAL migration: ${found}/3 columns exist. Refusing to guess — inspect manually.`);
  }
} else {
  console.log(`\n─── railway-db-fix: ${MIGRATION} is not in failed state — skipping resolve ───`);
}

console.log("\n─── railway-db-fix: applying pending migrations ───");
const deploy = prisma(["migrate", "deploy", "--schema", SCHEMA]);
process.stdout.write(deploy.stdout ?? "");
process.stderr.write(deploy.stderr ?? "");
if (deploy.status !== 0) fail(`migrate deploy failed (exit ${deploy.status})`);

console.log("\n─── railway-db-fix: verifying ───");
const found = countColumns();
if (found !== 3) fail(`verification failed: ${found}/3 columns exist after deploy`);
console.log("\n✓ railway-db-fix: database schema is up to date (3/3 columns present).\n");
