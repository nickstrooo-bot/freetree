#!/usr/bin/env node
// FreeTree Railway DB repair (Nov 5 2026, v3 — idempotent).
// Repairs the failed 20261105000000_promo_codes_booking_blocks migration.
// Root cause: five models (Product, Purchase, StripeConnectAccount,
// EmailCaptureBlock, EmailSubscriber) never got CREATE TABLE migrations upstream,
// so the promo/booking ALTER failed with `relation "Product" does not exist`.
// Fixed by the new 20261104000000_create_missing_commerce_tables migration,
// which sorts before it and creates the tables first.
//
// This script is safe to run on every container start:
//   1. If the promo/booking migration is currently FAILED, resolve it based on
//      ground truth (3/3 columns exist -> --applied; 0/3 -> --rolled-back;
//      partial -> refuse). If it is not failed, skip the resolve.
//   2. Run `migrate deploy` (applies anything pending; no-op when up to date).
//   3. Verify the 3 columns exist; exit 0 only then.
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

function countColumns() {
  const sql = `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('Product','Kyte','PublishedKyte') AND column_name IN ('allowPromoCodes','bookingBlocks') ORDER BY 1, 2;`;
  const r = prisma(["db", "execute", "--schema", SCHEMA, "--stdin"], sql);
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  if (r.status !== 0) fail("column check failed — cannot determine migration state");
  return (r.stdout.match(/allowPromoCodes|bookingBlocks/g) ?? []).length;
}

console.log("─── railway-db-fix: migration status ───");
const status = prisma(["migrate", "status", "--schema", SCHEMA]);
process.stdout.write(status.stdout ?? "");
process.stderr.write(status.stderr ?? "");
const statusText = `${status.stdout ?? ""}\n${status.stderr ?? ""}`;
const isFailed = statusText.includes("have failed") && statusText.includes(MIGRATION);

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
