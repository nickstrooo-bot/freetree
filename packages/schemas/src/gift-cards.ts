import { z } from "zod";

// ─── FreeTree Gift Cards — shared validation ─────────────────────────────────
// Saleor's gift-card model (BSD-3-Clause) + blamejs.shop's ledger pattern
// (DESIGN REFERENCE ONLY — its license is ambiguous: GitHub metadata says
// NOASSERTION while its README badge says Apache-2.0, and a web check on
// 2026-11-07 could not confirm a LICENSE file, so nothing is copied or
// closely paraphrased from it) + Stacks Commerce's state machine (MIT) +
// Spree's remainder-as-new-card idea (AGPL — IDEAS ONLY, never copied).
// Rebuilt natively. These schemas are the single source of truth for
// gift-card shapes: the seller-side tRPC procedures validate input against
// them, and the engine parses stored rows against them (defense in depth).
//
// Shape map:
//   Saleor: currency-based balance, bulk creation, one checkout at a time,
//     balance NOT deducted until checkout completes (FreeTree deviates
//     deliberately — see gift-cards.ts: the balance is deducted atomically
//     at checkout creation and RELEASED if Stripe then fails, the same
//     redeem/release pattern the discount engine already uses for coupons;
//     a checkout.session.expired webhook releases it if the buyer abandons
//     the session. A hold-until-completion model is the abandoned-cart gap,
//     not this feature).
//   blamejs: 16-char code, hash stored + 4-char hint, plaintext once;
//     append-only ledger with a balance-after snapshot per entry.
//   Stacks: one entry point for balance changes (updateBalance); redeem
//     only from ACTIVE; reload from ACTIVE or from USED when reloadable;
//     balance hitting 0 flips status to USED in the same statement.
//   Spree: partial use / refund of a card that cannot take credit mints
//     the remainder as a NEW card; guests redeem without an account.

export const MAX_GIFT_CARD_AMOUNT_CENTS = 100_000_000; // $1,000,000
export const MIN_GIFT_CARD_AMOUNT_CENTS = 50; // Stripe's minimum charge
export const MAX_GIFT_CARD_QUANTITY = 100; // bulk issue cap (Bagisto parity)
export const MIN_GIFT_CARD_QUANTITY = 1;
export const GIFT_CARD_CODE_LENGTH = 16;
export const MAX_GIFT_CARD_ISSUED_TO_LENGTH = 320;

/** Lowercase ISO-4217 code, e.g. "usd". Gift cards are currency-based. */
export const giftCardCurrencySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{3}$/, "Currency must be a 3-letter code, e.g. usd.");

/** Gift-card lifecycle status (Stacks Commerce state machine). */
export const giftCardStatusSchema = z.enum(["ACTIVE", "USED", "EXPIRED", "DEACTIVATED"]);
export type GiftCardStatus = z.infer<typeof giftCardStatusSchema>;

/** Ledger entry kind — append-only, one row per balance change. */
export const giftCardLedgerKindSchema = z.enum([
  "issue",
  "redeem",
  "reload",
  "refund",
  "release",
  "expire",
]);
export type GiftCardLedgerKind = z.infer<typeof giftCardLedgerKindSchema>;

/**
 * Seller input for issuing gift cards (single or bulk — Saleor's
 * giftCardBulkCreate). `quantity` cards are minted with the same amount /
 * currency / expiry / recipient; each gets its own code, and the plaintext
 * codes are returned ONCE in the mutation response (they are never stored).
 */
export const giftCardIssueInputSchema = z
  .object({
    /** Face value of each card, in the smallest currency unit. */
    amountCents: z.number().int().min(MIN_GIFT_CARD_AMOUNT_CENTS).max(MAX_GIFT_CARD_AMOUNT_CENTS),
    currency: giftCardCurrencySchema.default("usd"),
    /** How many identical cards to mint (1 = single issue). */
    quantity: z.number().int().min(MIN_GIFT_CARD_QUANTITY).max(MAX_GIFT_CARD_QUANTITY).default(1),
    /** Who the card was issued to (buyer email or a name). Optional. */
    issuedTo: z.string().trim().max(MAX_GIFT_CARD_ISSUED_TO_LENGTH).optional(),
    /** Null = no expiry. Past dates are rejected — an already-expired card is a bug. */
    expiresAt: z.date().nullable().optional(),
    /** A reloadable card can be topped up after it hits zero; a
     * non-reloadable one cannot be revived (Stacks rule). */
    isReloadable: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Expiry must be in the future.",
      });
    }
  });
export type GiftCardIssueInput = z.infer<typeof giftCardIssueInputSchema>;

/** Stored GiftCard row, as the engine reads it back. */
export const giftCardSchema = z.object({
  id: z.string().min(1),
  kyteId: z.string().min(1),
  orgId: z.string().min(1),
  /** SHA-256 hex of the normalized code. The plaintext is never stored. */
  codeHash: z.string().length(64),
  /** Last 4 chars of the code — seller lookup / support only. */
  codeHint: z.string().length(4),
  currency: giftCardCurrencySchema,
  initialBalanceCents: z.number().int().min(0),
  balanceCents: z.number().int().min(0),
  status: giftCardStatusSchema,
  isReloadable: z.boolean(),
  issuedTo: z.string().nullable(),
  expiresAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type GiftCardRow = z.infer<typeof giftCardSchema>;

/** Seller input for topping a card up (Stacks reload path). */
export const giftCardReloadInputSchema = z.object({
  amountCents: z.number().int().min(MIN_GIFT_CARD_AMOUNT_CENTS).max(MAX_GIFT_CARD_AMOUNT_CENTS),
});
export type GiftCardReloadInput = z.infer<typeof giftCardReloadInputSchema>;
