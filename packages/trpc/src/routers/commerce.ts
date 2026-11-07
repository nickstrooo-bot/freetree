import { z } from "zod";
import {
  createCouponInputSchema,
  discountActionSchema,
  discountConditionsSchema,
  discountMechanismSchema,
  discountRuleInputSchema,
  discountRuleKindSchema,
  discountTargetSchema,
  discountTriggerSchema,
  generateCouponsInputSchema,
  giftCardIssueInputSchema,
  giftCardReloadInputSchema,
  giftCardStatusSchema,
  MAX_RULE_NAME_LENGTH,
  MAX_RULE_PRIORITY,
} from "@kytelink/schemas";
import { kyteProcedure, router } from "../trpc";
import { notImplemented } from "../errors";
import { kyteIdInput, okSchema } from "../shapes";

// ─── FreeTree Commerce contract ─────────────────────────────────────────────
// Digital-product checkout with a 4% application fee via Stripe Connect.
// Every procedure here throws notImplemented; the concrete implementations live
// in apps/api/src/routers/commerce.ts and must conform to these shapes.

export const productSchema = z.object({
  id: z.string(),
  kyteId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string(),
  fileName: z.string().nullable(),
  fileSizeBytes: z.number().int().nullable(),
  hasFile: z.boolean(),
  externalUrl: z.string().nullable(),
  // "digital" = a sellable file/external product; "tip" = the hidden backing
  // row for a kyte's tip jar (never listed, never sold directly).
  kind: z.string(),
  active: z.boolean(),
  allowPromoCodes: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CommerceProduct = z.infer<typeof productSchema>;

export const saleSchema = z.object({
  id: z.string(),
  productId: z.string(),
  productName: z.string(),
  buyerEmail: z.string().nullable(),
  amountCents: z.number().int(),
  feeCents: z.number().int(),
  currency: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

// ─── Discount engine (Bagisto Cart/Catalog Rules + Saleor catalogue / order /
// voucher shape, rebuilt natively) ───────────────────────────────────────────
// Stored rows carry Date objects; the wire carries ISO strings, so the
// output schemas below are the row shape with dates as strings. Inputs reuse
// the @kytelink/schemas validation verbatim — the contract and the concrete
// router must agree, and sharing the schema is how they do.

export const discountRuleOutputSchema = z.object({
  id: z.string(),
  kyteId: z.string(),
  orgId: z.string(),
  name: z.string(),
  kind: discountRuleKindSchema,
  mechanism: discountMechanismSchema,
  trigger: discountTriggerSchema,
  active: z.boolean(),
  priority: z.number().int(),
  stopOtherRules: z.boolean(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  target: discountTargetSchema,
  conditions: discountConditionsSchema,
  action: discountActionSchema,
  couponCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DiscountRuleOutput = z.infer<typeof discountRuleOutputSchema>;

export const couponOutputSchema = z.object({
  id: z.string(),
  kyteId: z.string(),
  orgId: z.string(),
  ruleId: z.string(),
  code: z.string(),
  usageCount: z.number().int(),
  maxUses: z.number().int().nullable(),
  maxUsesPerCustomer: z.number().int().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  active: z.boolean(),
  generated: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CouponOutput = z.infer<typeof couponOutputSchema>;

// ─── Gift cards (Saleor model + blamejs ledger + Stacks state machine, ─────
// rebuilt natively) ──────────────────────────────────────────────────────────
// The plaintext code is NEVER on the wire except once, in the issue
// response. Everywhere else the card is identified by id + its 4-char hint.

export const giftCardOutputSchema = z.object({
  id: z.string(),
  kyteId: z.string(),
  orgId: z.string(),
  codeHint: z.string(),
  currency: z.string(),
  initialBalanceCents: z.number().int(),
  balanceCents: z.number().int(),
  status: giftCardStatusSchema,
  isReloadable: z.boolean(),
  issuedTo: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type GiftCardOutput = z.infer<typeof giftCardOutputSchema>;

export const giftCardLedgerEntryOutputSchema = z.object({
  id: z.string(),
  giftCardId: z.string(),
  kind: z.string(),
  amountCents: z.number().int(),
  balanceAfterCents: z.number().int(),
  purchaseId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

export type GiftCardLedgerEntryOutput = z.infer<typeof giftCardLedgerEntryOutputSchema>;

/** Issue response — the ONLY place a plaintext code ever appears. */
export const giftCardIssueResultSchema = z.object({
  cards: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      amountCents: z.number().int(),
      currency: z.string(),
    }),
  ),
});

export type GiftCardIssueResult = z.infer<typeof giftCardIssueResultSchema>;

export const previewTotalsOutputSchema = z.object({
  productId: z.string(),
  listPriceCents: z.number().int(),
  salePriceCents: z.number().int(),
  subtotalCents: z.number().int(),
  discountCents: z.number().int(),
  shippingCents: z.number().int(),
  shippingDiscountCents: z.number().int(),
  totalCents: z.number().int(),
  feeCents: z.number().int(),
  applied: z.array(
    z.object({
      ruleId: z.string(),
      ruleName: z.string(),
      mechanism: discountMechanismSchema,
      amountCents: z.number().int(),
      description: z.string(),
    }),
  ),
  giftLines: z.array(z.object({ productId: z.string(), quantity: z.number().int() })),
  couponApplied: z.boolean(),
  couponNotAppliedReason: z.string().nullable(),
  /** Gift-card portion of the preview (0 when no card entered). */
  giftCardCents: z.number().int(),
  /** What Stripe would actually charge after the card. */
  stripeChargeCents: z.number().int(),
  fullyCoveredByGiftCard: z.boolean(),
});

export type PreviewTotalsOutput = z.infer<typeof previewTotalsOutputSchema>;

const createProductInput = z.object({
  kyteId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  priceCents: z.number().int().min(50).max(10000000),
  currency: z.string().trim().toLowerCase().default("usd"),
  // Base64-encoded file content for the digital deliverable (max 25MB).
  fileBase64: z.string().max(35_000_000).optional(),
  fileName: z.string().trim().max(255).optional(),
  // ...or an external download URL instead of an uploaded file.
  externalUrl: z.string().trim().url().max(2048).optional(),
  // Show a promo-code field at Stripe Checkout. Codes are managed in the
  // seller's own Stripe dashboard.
  allowPromoCodes: z.boolean().default(false),
});

const updateProductInput = z.object({
  kyteId: z.string().min(1),
  productId: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  priceCents: z.number().int().min(50).max(10000000).optional(),
  fileBase64: z.string().max(35_000_000).nullable().optional(),
  fileName: z.string().trim().max(255).nullable().optional(),
  externalUrl: z.string().trim().url().max(2048).nullable().optional(),
  active: z.boolean().optional(),
  allowPromoCodes: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const commerceRouter = router({
  // ── Seller: product management ──────────────────────────────────────────

  listProducts: kyteProcedure
    .input(kyteIdInput)
    .output(z.object({ products: z.array(productSchema) }))
    .query(() => {
      throw notImplemented("commerce.listProducts");
    }),

  createProduct: kyteProcedure
    .input(createProductInput)
    .output(productSchema)
    .mutation(() => {
      throw notImplemented("commerce.createProduct");
    }),

  updateProduct: kyteProcedure
    .input(updateProductInput)
    .output(productSchema)
    .mutation(() => {
      throw notImplemented("commerce.updateProduct");
    }),

  deleteProduct: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), productId: z.string().min(1) }))
    .output(okSchema)
    .mutation(() => {
      throw notImplemented("commerce.deleteProduct");
    }),

  // ── Seller: Stripe Connect onboarding ───────────────────────────────────

  getConnectStatus: kyteProcedure
    .input(kyteIdInput)
    .output(
      z.object({
        configured: z.boolean(),
        connected: z.boolean(),
        chargesEnabled: z.boolean(),
        payoutsEnabled: z.boolean(),
        detailsSubmitted: z.boolean(),
      }),
    )
    .query(() => {
      throw notImplemented("commerce.getConnectStatus");
    }),

  createOnboardingLink: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        returnUrl: z.string().url(),
        refreshUrl: z.string().url(),
      }),
    )
    .output(z.object({ url: z.string().url() }))
    .mutation(() => {
      throw notImplemented("commerce.createOnboardingLink");
    }),

  // ── Seller: sales history ───────────────────────────────────────────────

  getSales: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      }),
    )
    .output(
      z.object({
        sales: z.array(saleSchema),
        nextCursor: z.string().nullable(),
        totals: z.object({
          grossCents: z.number().int(),
          feesCents: z.number().int(),
          netCents: z.number().int(),
          count: z.number().int(),
        }),
      }),
    )
    .query(() => {
      throw notImplemented("commerce.getSales");
    }),

  // ── Seller: discount engine ───────────────────────────────────────────────
  // Rules, coupons, and the seller preview of what a buyer would pay. The
  // concrete implementations live in apps/api/src/routers/commerce.ts.

  listDiscountRules: kyteProcedure
    .input(kyteIdInput)
    .output(z.object({ rules: z.array(discountRuleOutputSchema) }))
    .query(() => {
      throw notImplemented("commerce.listDiscountRules");
    }),

  createDiscountRule: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), rule: discountRuleInputSchema }))
    .output(discountRuleOutputSchema)
    .mutation(() => {
      throw notImplemented("commerce.createDiscountRule");
    }),

  updateDiscountRule: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        ruleId: z.string().min(1),
        patch: z.object({
          name: z.string().trim().min(1).max(MAX_RULE_NAME_LENGTH).optional(),
          kind: discountRuleKindSchema.optional(),
          trigger: discountTriggerSchema.optional(),
          active: z.boolean().optional(),
          priority: z.number().int().min(0).max(MAX_RULE_PRIORITY).optional(),
          stopOtherRules: z.boolean().optional(),
          startsAt: z.date().nullable().optional(),
          endsAt: z.date().nullable().optional(),
          target: discountTargetSchema.optional(),
          conditions: discountConditionsSchema.optional(),
          action: discountActionSchema.optional(),
        }),
      }),
    )
    .output(discountRuleOutputSchema)
    .mutation(() => {
      throw notImplemented("commerce.updateDiscountRule");
    }),

  deleteDiscountRule: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), ruleId: z.string().min(1) }))
    .output(okSchema)
    .mutation(() => {
      throw notImplemented("commerce.deleteDiscountRule");
    }),

  listCoupons: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), ruleId: z.string().min(1).optional() }))
    .output(
      z.object({
        coupons: z.array(couponOutputSchema.extend({ ruleName: z.string().nullable() })),
      }),
    )
    .query(() => {
      throw notImplemented("commerce.listCoupons");
    }),

  createCoupon: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        ruleId: z.string().min(1),
        coupon: createCouponInputSchema,
      }),
    )
    .output(couponOutputSchema)
    .mutation(() => {
      throw notImplemented("commerce.createCoupon");
    }),

  generateCoupons: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        ruleId: z.string().min(1),
        options: generateCouponsInputSchema,
      }),
    )
    .output(
      z.object({
        codes: z.array(z.string()),
        requested: z.number().int(),
        created: z.number().int(),
        collisions: z.number().int(),
        generatedAt: z.string(),
      }),
    )
    .mutation(() => {
      throw notImplemented("commerce.generateCoupons");
    }),

  setCouponActive: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        couponId: z.string().min(1),
        active: z.boolean(),
      }),
    )
    .output(couponOutputSchema)
    .mutation(() => {
      throw notImplemented("commerce.setCouponActive");
    }),

  previewTotals: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        productId: z.string().min(1),
        couponCode: z.string().trim().min(1).max(64).optional(),
        giftCardCode: z.string().trim().min(1).max(64).optional(),
      }),
    )
    .output(previewTotalsOutputSchema)
    .query(() => {
      throw notImplemented("commerce.previewTotals");
    }),

  // ── Seller: gift cards ──────────────────────────────────────────────────
  // Issue (single + bulk), list, detail + ledger, reload, activate toggle.
  // The concrete implementations live in apps/api/src/routers/commerce.ts.

  listGiftCards: kyteProcedure
    .input(kyteIdInput)
    .output(z.object({ giftCards: z.array(giftCardOutputSchema) }))
    .query(() => {
      throw notImplemented("commerce.listGiftCards");
    }),

  issueGiftCards: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), issue: giftCardIssueInputSchema }))
    .output(giftCardIssueResultSchema)
    .mutation(() => {
      throw notImplemented("commerce.issueGiftCards");
    }),

  getGiftCard: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), giftCardId: z.string().min(1) }))
    .output(
      z.object({
        giftCard: giftCardOutputSchema,
        ledger: z.array(giftCardLedgerEntryOutputSchema),
      }),
    )
    .query(() => {
      throw notImplemented("commerce.getGiftCard");
    }),

  reloadGiftCard: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        giftCardId: z.string().min(1),
        amountCents: giftCardReloadInputSchema.shape.amountCents,
      }),
    )
    .output(giftCardOutputSchema)
    .mutation(() => {
      throw notImplemented("commerce.reloadGiftCard");
    }),

  setGiftCardActive: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        giftCardId: z.string().min(1),
        active: z.boolean(),
      }),
    )
    .output(giftCardOutputSchema)
    .mutation(() => {
      throw notImplemented("commerce.setGiftCardActive");
    }),
});
