#!/usr/bin/env node
// FreeTree Railway one-time DB repair (Nov 5 2026).
// The 20261105000000_promo_codes_booking_blocks migration was recorded as FAILED
// during the first Railway deploy, which blocks all further `migrate deploy` runs
// (P3009) on a non-empty schema (P3005). This script inspects what actually
// happened and resolves it the correct way:
//   - all 3 new columns exist  -> the migration's statements applied; mark it --applied
//   - none of the columns exist -> the transaction rolled back; mark it --rolled-back
//   - some exist (partial)      -> refuse; needs a human decision
// Then it runs `migrate deploy` to finish. Safe to re-run: once the migration is
// resolved and applied, every step is a no-op.
import { spawnSync } from "node:child_process";

const MIGRATION = "20261105000000_promo_codes_booking_blocks";
const SCHEMA = "prisma/schema.prisma";

function prisma(args, input) {
  const r = spawnSync("pnpm", ["--filter", "@kytelink/db", "exec", "prisma", ...args], {
    input,
    encoding: "utf8",
  });
  return r;
}

function fail(msg) {
  console.error(`\n✗ railway-db-fix: ${msg}\n`);
  process.exit(1);
}

console.log("─── railway-db-fix: migration status ───");
const status = prisma(["migrate", "status", "--schema", SCHEMA]);
process.stdout.write(status.stdout ?? "");
process.stderr.write(status.stderr ?? "");

console.log("\n─── railway-db-fix: checking whether the failed migration partially applied ───");
const sql = `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('Product','Kyte','PublishedKyte') AND column_name IN ('allowPromoCodes','bookingBlocks') ORDER BY 1, 2;`;
const check = prisma(["db", "execute", "--schema", SCHEMA, "--stdin"], sql);
process.stdout.write(check.stdout ?? "");
process.stderr.write(check.stderr ?? "");
if (check.status !== 0) fail("column check failed — cannot determine migration state");

const found = (check.stdout.match(/allowPromoCodes|bookingBlocks/g) ?? []).length;
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
  fail(
    `PARTIAL migration: ${found}/3 columns exist. Refusing to guess — inspect the database manually.`,
  );
}

console.log("\n─── railway-db-fix: applying pending migrations ───");
const deploy = prisma(["migrate", "deploy", "--schema", SCHEMA]);
process.stdout.write(deploy.stdout ?? "");
process.stderr.write(deploy.stderr ?? "");
if (deploy.status !== 0) fail(`migrate deploy failed (exit ${deploy.status})`);

console.log("\n✓ railway-db-fix: database schema is up to date.\n");
