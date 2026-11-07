import { createHash, randomInt } from "node:crypto";
import type { z } from "zod";
import {
  giftCardIssueInputSchema,
  giftCardSchema,
} from "@kytelink/schemas";
import type { TotalsResult } from "./discounts";

export type { TotalsResult };

// ─── FreeTree Gift Cards ─────────────────────────────────────────────────────
// Saleor's gift-card model (BSD-3-Clause) + blamejs.shop's ledger pattern
// (DESIGN REFERENCE ONLY — its license is ambiguous: GitHub metadata says
// NOASSERTION while its README badge says Apache-2.0, and a web check on
// 2026-11-07 could not confirm a LICENSE file, so nothing is copied or
// closely paraphrased from it) + Stacks Commerce's state machine (MIT) +
// Spree's remainder-as-new-card idea (AGPL — IDEAS ONLY, never copied).
// Rebuilt natively. MODELS ONLY — no Saleor/Stacks/Spree/blamejs code is
// run or copied.
//
// Hard rules, all in this file:
//   1. The plaintext code is NEVER stored. Only its SHA-256 hash + a 4-char
//      hint live in the DB; the plaintext is returned once at creation.
//   2. Balance changes go through ONE entry point, updateBalance, whose
//      single conditional UPDATE enforces the state machine in its WHERE
//      clause — the database decides the race, not read-check-write (the
//      same rule the discount engine applies to coupon redemption).
//   3. Every balance change appends a ledger row with a balance-after
//      snapshot (append-only; balances are never edited in place without a
//      ledger entry).
//   4. collectTotals() stays the totals choke-point: gift-card value is
//      applied AFTER it, by applyGiftCardToTotals, so the seller preview
//      and the charge agree, and the fee is computed on the amount Stripe
//      actually charges — never on the gift-card-covered part.
//   5. A buyer-facing balance check is NOT a code-existence oracle:
//      unknown / malformed / expired / used-up codes all get the same
//      generic not-found, from the route (resolveGiftCardByCode throws one
//      error for every failure mode).
//
// Deviation from Saleor, deliberate: Saleor deducts the balance only when
// checkout completes. FreeTree deducts atomically at checkout creation and
// RELEASES the deduction if Stripe session creation then fails (the same
// redeem/release pattern the discount engine already uses for coupons),
// and a checkout.session.expired webhook releases it if the buyer abandons
// the session. A hold-until-completion model is the abandoned-cart gap,
// not this feature.
//
// This module is pure except for the issue/redeem/release/refund functions
// at the bottom, which take minimal structural db handles (no Prisma
// import, so these tests run without the generated client — see the
// discount-engine test for why that matters locally).

// ─── Codes: 16 chars, hash stored + 4-char hint, plaintext once ─────────────

/**
 * 32-glyph alphabet with no ambiguous letters (no 0/O, no 1/I) — the same
 * shape blamejs uses for its codes. A buyer typing a code off a screenshot
 * should not have to guess.
 */
export const GIFT_CARD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Display form: XXXX-XXXX-XXXX-XXXX. The hash is always of the compact form. */
export function formatGiftCardCode(compact: string): string {
  return compact.replace(/(.{4})(?=.)/g, "$1-");
}

/** Normalize buyer input: strip dashes/spaces, uppercase. */
export function normalizeGiftCardCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** SHA-256 hex of the normalized compact code. This is what the DB stores. */
export function hashGiftCardCode(normalizedCompactCode: string): string {
  return createHash("sha256").update(normalizedCompactCode).digest("hex");
}

function randomCodePart(
  length: number,
  rand: (min: number, max: number) => number,
): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += GIFT_CARD_ALPHABET[rand(0, GIFT_CARD_ALPHABET.length)];
  }
  return out;
}

/** One fresh 16-char compact code. Uniqueness is enforced by the DB's
 * unique (orgId, codeHash) index; issueGiftCards retries on collision. */
export function generateGiftCardCode(
  rand: (min: number, max: number) => number = randomInt,
): string {
  return randomCodePart(16, rand);
}

// ─── Totals: gift-card value applied AFTER collectTotals ─────────────────────

export interface GiftCardTotalsResult extends TotalsResult {
  /** Cents covered by the gift card (min of balance and discounted total). */
  giftCardCents: number;
  /** Cents Stripe actually charges: discounted total minus gift-card cover. */
  stripeChargeCents: number;
  /** True when the card covers the whole order — no Stripe charge at all. */
  fullyCoveredByGiftCard: boolean;
}

/**
 * Apply a gift-card balance to an already-computed totals result. Pure:
 * the discount engine's collectTotals() runs first (catalog + cart rules),
 * then the card covers up to the discounted total. A fully-covering card
 * means stripeChargeCents is 0 — the order is paid with no Stripe charge
 * and no fee, because computeFeeCents(0) is 0.
 */
export function applyGiftCardToTotals(
  totals: TotalsResult,
  giftCardBalanceCents: number,
): GiftCardTotalsResult {
  const balance = Math.max(0, Math.floor(giftCardBalanceCents));
  const giftCardCents = Math.min(Math.max(0, totals.totalCents), balance);
  const stripeChargeCents = totals.totalCents - giftCardCents;
  return {
    ...totals,
    giftCardCents,
    stripeChargeCents,
    // Full cover means the card actually PAID for the order — a $0 total
    // with $0 of card value is not covered, it is unpaid (a 100%-off
    // order with no card still has no payment path; see the route).
    fullyCoveredByGiftCard: giftCardCents > 0 && stripeChargeCents === 0,
  };
}

// ─── Read-side checks (messaging only; the atomic UPDATE decides) ───────────

export type GiftCardCheck = "ok" | "invalid";

export interface GiftCardRowView {
  status: string;
  balanceCents: number;
  expiresAt: Date | null;
  currency: string;
}

/**
 * Read-side check of a gift-card row. ONE failure bucket on purpose: the
 * buyer-facing surfaces must not distinguish "doesn't exist" from
 * "expired" from "used up" (non-oracle rule), so every failure is just
 * "invalid" here and the route answers with the same generic not-found.
 */
export function checkGiftCard(card: GiftCardRowView, now: Date): GiftCardCheck {
  if (card.status !== "ACTIVE") return "invalid";
  if (card.balanceCents <= 0) return "invalid";
  if (card.expiresAt && card.expiresAt < now) return "invalid";
  return "ok";
}

/** Thrown when a buyer-entered code can't be used; one code, one message. */
export class GiftCardResolutionError extends Error {
  readonly code = "GIFT_CARD_INVALID" as const;
  readonly status = 400;
  constructor(message = "That gift card isn't valid for this seller.") {
    super(message);
    this.name = "GiftCardResolutionError";
  }
}

/** Minimal db handle for gift-card lookup by hash (structural). */
export interface GiftCardLookupDb {
  giftCard: {
    findFirst: (args: { where: { orgId: string; codeHash: string } }) => Promise<unknown>;
  };
}

/**
 * Resolve a buyer-entered code to its card row, org-scoped, via the hash
 * lookup (no plaintext ever touches the DB). Every failure mode — unknown
 * code, wrong seller, deactivated, expired, zero balance — throws the
 * same GiftCardResolutionError, so the caller cannot leak which one it
 * was. Currency is checked by the caller against the product; a mismatch
 * is reported as the same generic error.
 */
export async function resolveGiftCardByCode(
  db: GiftCardLookupDb,
  input: { orgId: string; code: string; now?: Date },
): Promise<any> {
  const now = input.now ?? new Date();
  const normalized = normalizeGiftCardCode(input.code);
  if (normalized.length !== 16) {
    throw new GiftCardResolutionError();
  }
  const card = await db.giftCard.findFirst({
    where: { orgId: input.orgId, codeHash: hashGiftCardCode(normalized) },
  });
  const parsed = giftCardSchema.safeParse(card);
  if (!parsed.success) {
    throw new GiftCardResolutionError();
  }
  if (checkGiftCard(parsed.data, now) !== "ok") {
    throw new GiftCardResolutionError();
  }
  return parsed.data;
}

// ─── The one entry point for balance changes (Stacks rule) ──────────────────

/**
 * Minimal db handle for balance changes. $queryRawUnsafe must return the
 * RETURNING rows ([{ balanceCents, status }]); the fake db in
 * gift-cards.test.ts simulates the conditional UPDATE's guards in the
 * same binding order these builders emit them.
 */
export interface GiftCardBalanceDb {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<Array<{ balanceCents: number; status: string }>>;
  // tx is `any` on purpose: PrismaClient's $transaction is overloaded
  // (array form + callback form), and a narrow tx type is not assignable
  // to either overload's parameter. The engine functions type their own
  // tx explicitly (see updateBalanceInTx), so nothing is lost here.
  $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

export interface GiftCardLedgerDb {
  giftCardLedger: {
    create: (args: {
      data: {
        giftCardId: string;
        orgId: string;
        kind: string;
        amountCents: number;
        balanceAfterCents: number;
        purchaseId?: string | null;
        note?: string | null;
      };
    }) => Promise<unknown>;
  };
}

export interface GiftCardRedemptionDb {
  giftCardRedemption: {
    create: (args: {
      data: {
        giftCardId: string;
        orgId: string;
        buyerEmail: string | null;
        purchaseId: string | null;
        amountCents: number;
        status: string;
      };
    }) => Promise<unknown>;
    updateMany: (args: {
      where: { giftCardId: string; purchaseId: string | null; status: string };
      data: { status: string; releasedAt: Date };
    }) => Promise<{ count: number }>;
  };
}

export interface UpdateBalanceInput {
  giftCardId: string;
  orgId: string;
  /** Signed cents: negative = redeem, positive = reload / refund-credit. */
  deltaCents: number;
  kind: "redeem" | "reload" | "refund" | "release";
  purchaseId?: string | null;
  note?: string | null;
  now?: Date;
}

/**
 * The balance-change statement. Every guard lives in the WHERE clause:
 *   - negative (redeem): only from ACTIVE, not expired, balance covers it;
 *   - positive (reload / refund-credit): from ACTIVE, or from USED when
 *     the card is reloadable — a non-reloadable card cannot be revived;
 *   - balance can never go below zero;
 *   - balance hitting exactly 0 flips status to USED in the same statement;
 *     a positive change on a USED reloadable card flips it back to ACTIVE.
 * Binding order (positional, $1..$4): giftCardId, orgId, deltaCents, now.
 */
export function buildUpdateBalanceSql(input: UpdateBalanceInput): { text: string; values: unknown[] } {
  const now = input.now ?? new Date();
  const text = [
    `UPDATE "GiftCard"`,
    `SET "balanceCents" = "balanceCents" + $3,`,
    `    "status" = CASE`,
    `      WHEN "balanceCents" + $3 = 0 THEN 'USED'`,
    `      WHEN "balanceCents" + $3 > 0 THEN 'ACTIVE'`,
    `      ELSE "status"`,
    `    END,`,
    `    "updatedAt" = NOW()`,
    `WHERE "id" = $1`,
    `  AND "orgId" = $2`,
    `  AND "balanceCents" + $3 >= 0`,
    `  AND (( $3 < 0`,
    `    AND "status" = 'ACTIVE'`,
    `    AND ("expiresAt" IS NULL OR "expiresAt" >= $4))`,
    `    OR ( $3 > 0`,
    `    AND ("status" = 'ACTIVE' OR ("status" = 'USED' AND "isReloadable" = true))))`,
    `RETURNING "balanceCents", "status"`,
  ].join("\n");
  return { text, values: [input.giftCardId, input.orgId, input.deltaCents, now] };
}

/** Tx-scoped core: run the conditional UPDATE, append the ledger row.
 * Returns the post-update balance, or null when the guards rejected it. */
async function updateBalanceInTx(
  tx: GiftCardBalanceDb & GiftCardLedgerDb,
  input: UpdateBalanceInput,
): Promise<{ balanceCents: number; status: string } | null> {
  const { text, values } = buildUpdateBalanceSql(input);
  const rows = await tx.$queryRawUnsafe(text, ...values);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  await tx.giftCardLedger.create({
    data: {
      giftCardId: input.giftCardId,
      orgId: input.orgId,
      kind: input.kind,
      amountCents: input.deltaCents,
      balanceAfterCents: row.balanceCents,
      purchaseId: input.purchaseId ?? null,
      note: input.note ?? null,
    },
  });
  return row;
}

/**
 * THE one entry point for balance changes (Stacks Commerce rule). Positive
 * and negative deltas both come here; the SQL decides what is legal. The
 * UPDATE and its ledger row commit in one transaction, so a balance can
 * never move without its audit entry. Returns the post-update row, or null
 * when the state machine rejected the change (caller re-reads the card to
 * classify: wrong status, expired, insufficient balance).
 */
export async function updateGiftCardBalance(
  db: GiftCardBalanceDb & GiftCardLedgerDb,
  input: UpdateBalanceInput,
): Promise<{ balanceCents: number; status: string } | null> {
  return db.$transaction(async (tx) => updateBalanceInTx(tx as any, input));
}

// ─── Redeem (atomic balance guard) ───────────────────────────────────────────

export interface RedeemGiftCardInput {
  giftCardId: string;
  orgId: string;
  amountCents: number;
  /** Null for anonymous buyers — redemption still works (guest redemption,
   * Spree model: no account required). */
  buyerEmail: string | null;
  purchaseId: string | null;
  now?: Date;
}

/**
 * Redeem a gift card against a purchase, atomically: the conditional
 * UPDATE deducts the balance (guards in the WHERE clause — two buyers
 * spending the same card simultaneously cannot both succeed) and the
 * ledger + redemption rows are written in the same transaction. Returns
 * true when the deduction landed. False means the card failed a guard
 * (wrong status / expired / insufficient balance) — the caller reports
 * the generic GIFT_CARD_INVALID and creates no order.
 */
export async function redeemGiftCardAtomic(
  db: GiftCardBalanceDb & GiftCardLedgerDb & GiftCardRedemptionDb,
  input: RedeemGiftCardInput,
): Promise<boolean> {
  if (input.amountCents <= 0) return false;
  return db.$transaction(async (tx) => {
    const updated = await updateBalanceInTx(tx as any, {
      giftCardId: input.giftCardId,
      orgId: input.orgId,
      deltaCents: -input.amountCents,
      kind: "redeem",
      purchaseId: input.purchaseId,
      now: input.now,
    });
    if (!updated) return false;
    await tx.giftCardRedemption.create({
      data: {
        giftCardId: input.giftCardId,
        orgId: input.orgId,
        buyerEmail: input.buyerEmail,
        purchaseId: input.purchaseId,
        amountCents: input.amountCents,
        status: "redeemed",
      },
    });
    return true;
  });
}

// ─── Release (compensating credit when a checkout dies) ──────────────────────

/**
 * The release statement. This is deliberately NOT updateBalance: releasing
 * undoes a redemption, so it must revive even a non-reloadable card that
 * hit zero (otherwise a failed Stripe session would permanently burn a
 * single-use card). The EXISTS guard ties the credit to a still-redeemed
 * redemption row for this purchase, so a release can never double-credit.
 * Binding order ($1..$4): giftCardId, orgId, amountCents, purchaseId.
 */
export function buildReleaseSql(input: {
  giftCardId: string;
  orgId: string;
  amountCents: number;
  purchaseId: string | null;
}): { text: string; values: unknown[] } {
  const text = [
    `UPDATE "GiftCard"`,
    `SET "balanceCents" = "balanceCents" + $3,`,
    `    "status" = CASE WHEN "balanceCents" + $3 > 0 THEN 'ACTIVE' ELSE "status" END,`,
    `    "updatedAt" = NOW()`,
    `WHERE "id" = $1`,
    `  AND "orgId" = $2`,
    `  AND EXISTS (SELECT 1 FROM "GiftCardRedemption"`,
    `    WHERE "GiftCardRedemption"."giftCardId" = $1`,
    `      AND "GiftCardRedemption"."purchaseId" = $4`,
    `      AND "GiftCardRedemption"."status" = 'redeemed')`,
    `RETURNING "balanceCents", "status"`,
  ].join("\n");
  return { text, values: [input.giftCardId, input.orgId, input.amountCents, input.purchaseId] };
}

/**
 * Give a redeemed amount back: called (best-effort, caller logs failures)
 * when a checkout that already redeemed a card then fails — e.g. Stripe
 * session creation throws — or when the Stripe session expires
 * (checkout.session.expired webhook) and the buyer never paid. Credits
 * the balance, flips the redemption to "released", appends a "release"
 * ledger row, all in one transaction. Returns true when money moved.
 */
export async function releaseGiftCardRedemption(
  db: GiftCardBalanceDb & GiftCardLedgerDb & GiftCardRedemptionDb,
  input: { giftCardId: string; orgId: string; amountCents: number; purchaseId: string | null; now?: Date },
): Promise<boolean> {
  if (input.amountCents <= 0 || !input.purchaseId) return false;
  return db.$transaction(async (tx) => {
    const { text, values } = buildReleaseSql(input);
    const rows = await tx.$queryRawUnsafe(text, ...values);
    if (rows.length !== 1) return false;
    await tx.giftCardRedemption.updateMany({
      where: { giftCardId: input.giftCardId, purchaseId: input.purchaseId, status: "redeemed" },
      data: { status: "released", releasedAt: input.now ?? new Date() },
    });
    await tx.giftCardLedger.create({
      data: {
        giftCardId: input.giftCardId,
        orgId: input.orgId,
        kind: "release",
        amountCents: input.amountCents,
        balanceAfterCents: rows[0]!.balanceCents,
        purchaseId: input.purchaseId,
        note: null,
      },
    });
    return true;
  });
}

// ─── Issue (single + bulk) ───────────────────────────────────────────────────

export interface GiftCardIssueDb {
  giftCard: {
    // data is `any`: Prisma's create takes the full GiftCardCreateInput,
    // and a Record<string, unknown> payload is not assignable to it.
    create: (args: { data: any }) => Promise<any>;
  };
  giftCardLedger: GiftCardLedgerDb["giftCardLedger"];
  // tx is `any` — see GiftCardBalanceDb: Prisma's overloaded $transaction
  // does not accept a narrow tx type.
  $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

/**
 * Mint gift cards (Saleor's giftCardBulkCreate, rebuilt natively). Each
 * card gets its own 16-char code; only the hash + hint are stored, and the
 * plaintext codes are returned ONCE in the result — the seller must show
 * or send them now, because they can never be recovered. A create that
 * collides on the unique (orgId, codeHash) index regenerates the code and
 * retries instead of failing the batch. Each mint appends an "issue"
 * ledger row, in the same transaction as the card row.
 */
export async function issueGiftCards(
  db: GiftCardIssueDb,
  // The zod INPUT type (defaults not yet applied): callers pass raw seller
  // input and the schema parse below fills the defaults. The tRPC layer
  // passes already-parsed input, which is assignable to this too.
  input: { kyteId: string; orgId: string; issue: z.input<typeof giftCardIssueInputSchema> },
  rand: (min: number, max: number) => number = randomInt,
): Promise<Array<{ id: string; code: string; amountCents: number; currency: string }>> {
  const checked = giftCardIssueInputSchema.parse(input.issue);
  const created: Array<{ id: string; code: string; amountCents: number; currency: string }> = [];
  return db.$transaction(async (tx) => {
    for (let n = 0; n < checked.quantity; n++) {
      let card: any = null;
      let code = "";
      let attempts = 0;
      while (!card) {
        if (++attempts > 50) {
          throw new Error("Could not mint a unique gift-card code — the code space is exhausted.");
        }
        code = generateGiftCardCode(rand);
        try {
          card = await tx.giftCard.create({
            data: {
              kyteId: input.kyteId,
              orgId: input.orgId,
              codeHash: hashGiftCardCode(code),
              codeHint: code.slice(-4),
              currency: checked.currency,
              initialBalanceCents: checked.amountCents,
              balanceCents: checked.amountCents,
              status: "ACTIVE",
              isReloadable: checked.isReloadable,
              issuedTo: checked.issuedTo ?? null,
              expiresAt: checked.expiresAt ?? null,
            },
          });
        } catch (error: any) {
          // Unique (orgId, codeHash) collision — regenerate, don't fail.
          if (error?.code === "P2002") continue;
          throw error;
        }
      }
      await tx.giftCardLedger.create({
        data: {
          giftCardId: card.id,
          orgId: input.orgId,
          kind: "issue",
          amountCents: checked.amountCents,
          balanceAfterCents: checked.amountCents,
          purchaseId: null,
          note: checked.issuedTo ? `Issued to ${checked.issuedTo}` : null,
        },
      });
      created.push({
        id: card.id,
        code: formatGiftCardCode(code),
        amountCents: checked.amountCents,
        currency: checked.currency,
      });
    }
    return created;
  });
}

// ─── Refunds: pair every refund with its order adjustment (Solidus) ─────────

/**
 * Gift-card share of a refund, proportional (blamejs's rule: a partial
 * refund reverses gift-card credit proportionally). The order was paid
 * with stripeChargedCents via Stripe plus giftCardCents via card. A
 * PARTIAL refund of R reverses R's share of the card portion:
 * R * G / (S + G). A FULL refund of the Stripe charge means the whole
 * order is being refunded, so the ENTIRE card portion comes back — the
 * proportional slice of a full cash refund would strand part of the
 * card's value, which is exactly the corruption this pairing exists to
 * prevent. Capped at the card portion actually paid, floored at 0.
 */
export function computeGiftCardRefundShare(input: {
  refundAmountCents: number;
  stripeChargedCents: number;
  giftCardCents: number;
}): number {
  const totalPaid = Math.max(0, input.stripeChargedCents) + Math.max(0, input.giftCardCents);
  if (totalPaid <= 0 || input.refundAmountCents <= 0 || input.giftCardCents <= 0) return 0;
  if (input.refundAmountCents >= input.stripeChargedCents) {
    return input.giftCardCents;
  }
  const share = Math.round((input.refundAmountCents * input.giftCardCents) / totalPaid);
  return Math.min(Math.max(0, share), input.giftCardCents);
}

export interface GiftCardRefundDb {
  purchase: {
    findFirst: (args: { where: { id: string } }) => Promise<any>;
    // data is `any`: Prisma's update takes the full PurchaseUpdateInput,
    // and a Record<string, unknown> payload is not assignable to it.
    update: (args: { where: { id: string }; data: any }) => Promise<any>;
  };
  refund: {
    findMany: (args: { where: { purchaseId: string } }) => Promise<Array<{ amountCents: number }>>;
    create: (args: { data: any }) => Promise<any>;
  };
  orderAdjustment: {
    create: (args: { data: any }) => Promise<any>;
  };
  giftCard: {
    findFirst: (args: { where: { id: string } }) => Promise<any>;
    create: (args: { data: any }) => Promise<any>;
  };
  $queryRawUnsafe: GiftCardBalanceDb["$queryRawUnsafe"];
  giftCardLedger: GiftCardLedgerDb["giftCardLedger"];
  // tx is `any` — see GiftCardBalanceDb: Prisma's overloaded $transaction
  // does not accept a narrow tx type.
  $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

export interface RecordRefundInput {
  purchaseId: string;
  orgId: string;
  /** Incremental refund to record (the webhook computes this from Stripe's
   * running amount_refunded minus refunds already recorded). */
  amountCents: number;
  currency?: string;
  stripeRefundId?: string | null;
  reason?: string | null;
  now?: Date;
}

export interface RecordRefundResult {
  refund: any;
  adjustment: any;
  giftCardReversedCents: number;
  /** Plaintext code of a freshly minted replacement card, if the original
   * card could not take the credit back (Spree remainder-as-new-card).
   * Returned once — the seller must send it to the buyer now. */
  replacementGiftCardCode: string | null;
  replacementGiftCardId: string | null;
}

/**
 * Record a refund the Solidus way: a Refund is a SEPARATE model from the
 * payment, and it is always paired with an OrderAdjustment in the same
 * transaction — a bare refund must never leave the order's balance_due
 * (Solidus's documented quirk) without its adjustment. When the refunded
 * order was partly paid by gift card, the card's share is reversed
 * proportionally (computeGiftCardRefundShare): credited back to the
 * original card when it can take it (ACTIVE, not expired — via the same
 * one-entry-point updateBalance), otherwise minted as a NEW card for the
 * buyer (Spree's remainder-as-new-card), never silently dropped. A full
 * refund (whole Stripe charge back AND whole card share reversed) flips
 * the purchase to "refunded"; a partial refund leaves it "completed"
 * with the Refund + OrderAdjustment rows as the audit trail.
 */
export async function recordGiftCardRefund(
  db: GiftCardRefundDb,
  input: RecordRefundInput,
  rand: (min: number, max: number) => number = randomInt,
): Promise<RecordRefundResult> {
  if (input.amountCents <= 0) {
    throw new Error("recordGiftCardRefund requires amountCents > 0.");
  }
  return db.$transaction(async (tx) => {
    const purchase = await tx.purchase.findFirst({ where: { id: input.purchaseId } });
    if (!purchase) {
      throw new Error(`recordGiftCardRefund: purchase ${input.purchaseId} not found.`);
    }
    const now = input.now ?? new Date();
    const giftShare = computeGiftCardRefundShare({
      refundAmountCents: input.amountCents,
      stripeChargedCents: purchase.amountCents ?? 0,
      giftCardCents: purchase.giftCardCents ?? 0,
    });

    let replacementGiftCardCode: string | null = null;
    let replacementGiftCardId: string | null = null;
    let reversedToOriginal = false;

    if (giftShare > 0 && purchase.giftCardId) {
      const card = await tx.giftCard.findFirst({ where: { id: purchase.giftCardId } });
      const canCreditBack =
        card &&
        card.status === "ACTIVE" &&
        (!card.expiresAt || new Date(card.expiresAt) >= now) &&
        card.currency === (purchase.currency ?? "usd");
      if (canCreditBack) {
        // Same one-entry-point update as a reload (kind "refund" for the
        // ledger, so the audit trail says why the balance went up).
        const credited = await updateBalanceInTx(tx as any, {
          giftCardId: card.id,
          orgId: input.orgId,
          deltaCents: giftShare,
          kind: "refund",
          purchaseId: purchase.id,
          now,
        });
        reversedToOriginal = credited !== null;
      }
      if (!reversedToOriginal) {
        // Original card can't take the credit (USED + non-reloadable,
        // deactivated, or expired): mint the share as a NEW card for the
        // buyer instead of corrupting — or dropping — the balance (Spree).
        let code = "";
        let newCard: any = null;
        let attempts = 0;
        while (!newCard) {
          if (++attempts > 50) {
            throw new Error("Could not mint a replacement gift-card code.");
          }
          code = generateGiftCardCode(rand);
          try {
            newCard = await tx.giftCard.create({
              data: {
                kyteId: purchase.kyteId,
                orgId: input.orgId,
                codeHash: hashGiftCardCode(code),
                codeHint: code.slice(-4),
                currency: purchase.currency ?? "usd",
                initialBalanceCents: giftShare,
                balanceCents: giftShare,
                status: "ACTIVE",
                isReloadable: false,
                issuedTo: purchase.buyerEmail ?? null,
                expiresAt: null,
              },
            });
          } catch (error: any) {
            if (error?.code === "P2002") continue;
            throw error;
          }
        }
        await tx.giftCardLedger.create({
          data: {
            giftCardId: newCard.id,
            orgId: input.orgId,
            kind: "refund",
            amountCents: giftShare,
            balanceAfterCents: giftShare,
            purchaseId: purchase.id,
            note: `Refund remainder from gift card ${purchase.giftCardId}`,
          },
        });
        replacementGiftCardId = newCard.id;
        replacementGiftCardCode = formatGiftCardCode(code);
      }
    }

    const refund = await tx.refund.create({
      data: {
        purchaseId: purchase.id,
        orgId: input.orgId,
        amountCents: input.amountCents,
        currency: input.currency ?? purchase.currency ?? "usd",
        stripeRefundId: input.stripeRefundId ?? null,
        reason: input.reason ?? null,
        giftCardReversedCents: giftShare,
        giftCardId: purchase.giftCardId ?? null,
        replacementGiftCardId,
      },
    });
    const adjustment = await tx.orderAdjustment.create({
      data: {
        purchaseId: purchase.id,
        orgId: input.orgId,
        kind: "refund",
        amountCents: -input.amountCents,
        note:
          giftShare > 0
            ? `Refund of ${input.amountCents}¢; ${giftShare}¢ of gift-card value reversed` +
              (replacementGiftCardId ? " as a new card" : " to the original card")
            : `Refund of ${input.amountCents}¢`,
      },
    });

    // Full refund = whole Stripe charge back AND whole card share reversed.
    const fullyRefunded =
      input.amountCents >= (purchase.amountCents ?? 0) &&
      giftShare >= (purchase.giftCardCents ?? 0);
    if (fullyRefunded && purchase.status === "completed") {
      await tx.purchase.update({
        where: { id: purchase.id },
        data: { status: "refunded" },
      });
    }

    return { refund, adjustment, giftCardReversedCents: giftShare, replacementGiftCardCode, replacementGiftCardId };
  });
}
