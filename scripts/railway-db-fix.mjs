#!/usr/bin/env node
// FreeTree Railway DB repair (Nov 5 2026, v5 — idempotent).
// Repairs the failed 20261105000000_promo_codes_booking_blocks migration.
// Root cause: five models (Product, Purchase, StripeConnectAccount,
// EmailCaptureBlock, EmailSubscriber) never got CREATE TABLE migrations upstream,
// so the promo/booking ALTER failed with `relation "Product" does not exist`.
// Fixed by migration 20261104000000_create_missing_commerce_tables, which sorts
// before it and creates the tables first.
//
// v5 change: STOP trying to detect the failed state before resolving.
// Detection kept failing (migrate status omits it; the direct DB query
// disagreed with deploy). Instead, UNCONDITIONALLY run
// `migrate resolve --rolled-back` and ignore its exit code: if the migration
// is failed it clears it; if it is not failed the resolve errors harmlessly
// and deploy proceeds. Ground truth for the columns (0/3) was already proven
// independently by deploy itself failing with `relation "Product" does not exist`,
// so --rolled-back is the correct resolution. Then deploy, then verify via
// `migrate status` (trustworthy, Prisma-native).
// Safe to run on every container start.
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

console.log(`─── railway-db-fix: clearing failed state for ${MIGRATION} (resolve --rolled-back; failure here is harmless) ───`);
const resolve = prisma(["migrate", "resolve", "--rolled-back", MIGRATION, "--schema", SCHEMA]);
process.stdout.write(resolve.stdout ?? "");
process.stderr.write(resolve.stderr ?? "");
console.log(`resolve exit code: ${resolve.status} (ignored — deploy is the verdict)`);

console.log("\n─── railway-db-fix: applying pending migrations ───");
const deploy = prisma(["migrate", "deploy", "--schema", SCHEMA]);
process.stdout.write(deploy.stdout ?? "");
process.stderr.write(deploy.stderr ?? "");
if (deploy.status !== 0) fail(`migrate deploy failed (exit ${deploy.status})`);

console.log("\n─── railway-db-fix: verifying schema is up to date ───");
const status = prisma(["migrate", "status", "--schema", SCHEMA]);
process.stdout.write(status.stdout ?? "");
process.stderr.write(status.stderr ?? "");
const statusText = `${status.stdout ?? ""}\n${status.stderr ?? ""}`;
if (!/up to date/i.test(statusText)) {
  fail("migrate status does not report the schema as up to date after deploy");
}

console.log("\n✓ railway-db-fix: database schema is up to date.\n");
