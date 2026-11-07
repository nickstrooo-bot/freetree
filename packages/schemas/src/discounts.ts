import { z } from "zod";

// ─── Discount engine — shared validation ─────────────────────────────────────
// Bagisto Cart/Catalog Rules + Saleor's three-mechanism model, rebuilt
// natively. These schemas are the single source of truth for rule/coupon
// shapes: the seller-side tRPC procedures validate input against them, the
// engine parses stored rows against them (defense in depth — a row written
// by an older build or by hand must not crash checkout), and the bulk
// coupon generator takes its bounds from them.
//
// Shape map (Saleor):
//   catalogue promotion  -> kind "catalog",  trigger "automatic"
//   order promotion      -> kind "cart",     trigger "automatic"
//   voucher              -> kind "cart",     trigger "coupon" (+ Coupon rows)

export const MAX_RULE_NAME_LENGTH = 120;
export const MAX_COUPON_CODE_LENGTH = 30;
export const MIN_COUPON_CODE_LENGTH = 4;
export const MAX_COUPON_PREFIX_LENGTH = 10;
export const MAX_COUPON_SUFFIX_LENGTH = 10;
export const MAX_COUPON_GENERATE_QUANTITY = 100;
export const MIN_COUPON_GENERATE_QUANTITY = 1;
export const MAX_COUPON_GENERATE_LENGTH = 30;
export const MIN_COUPON_GENERATE_LENGTH = 4;
export const MAX_RULE_PRIORITY = 10_000;
export const MAX_DISCOUNT_PERCENT = 100;
export const MAX_FIXED_DISCOUNT_CENTS = 100_000_000; // $1,000,000

export const discountRuleKindSchema = z.enum(["catalog", "cart"]);
export type DiscountRuleKind = z.infer<typeof discountRuleKindSchema>;

export const discountMechanismSchema = z.enum(["catalogue", "order", "voucher"]);
export type DiscountMechanism = z.infer<typeof discountMechanismSchema>;

export const discountTriggerSchema = z.enum(["automatic", "coupon"]);
export type DiscountTrigger = z.infer<typeof discountTriggerSchema>;

/** Saleor voucher target: what the discount applies to. */
export const discountTargetSchema = z.enum(["entire_order", "specific_product", "shipping"]);
export type DiscountTarget = z.infer<typeof discountTargetSchema>;

/** Bagisto cart-rule actions, plus Saleor's GIFT reward type. */
export const discountActionTypeSchema = z.enum([
  "percent",
  "fixed_per_item",
  "fixed_whole_cart",
  "buy_x_get_y",
  "free_shipping",
  "gift",
]);
export type DiscountActionType = z.infer<typeof discountActionTypeSchema>;

/**
 * Conditions over cart/cart-item/product attributes (Bagisto). All are
 * optional and AND together; an empty object means "always applies".
 * minSubtotalCents is Saleor's minSpent / order-predicate on the subtotal
 * AFTER catalogue (read-time) pricing — the base the buyer actually sees.
 */
export const discountConditionsSchema = z
  .object({
    /** Specific-product scope: only these product ids are eligible. Empty/absent = all products. */
    productIds: z.array(z.string().min(1)).max(500).optional(),
    /** Order predicate: cart subtotal (after catalog pricing) must reach this. */
    minSubtotalCents: z.number().int().min(0).max(MAX_FIXED_DISCOUNT_CENTS).optional(),
    /** Cart must contain at least this many total units. */
    minQuantity: z.number().int().min(1).max(10_000).optional(),
  })
  .default({});

export type DiscountConditions = z.infer<typeof discountConditionsSchema>;

/**
 * The action a rule takes. Which fields matter depends on `type`:
 * percent -> percent (1–100); fixed_* -> amountCents; buy_x_get_y ->
 * buyQty/getQty; gift -> giftProductId (a product of the same seller,
 * added as a zero-priced line); free_shipping -> nothing.
 */
export const discountActionSchema = z
  .object({
    type: discountActionTypeSchema,
    percent: z.number().int().min(1).max(MAX_DISCOUNT_PERCENT).optional(),
    amountCents: z.number().int().min(1).max(MAX_FIXED_DISCOUNT_CENTS).optional(),
    buyQty: z.number().int().min(1).max(10_000).optional(),
    getQty: z.number().int().min(1).max(10_000).optional(),
    giftProductId: z.string().min(1).optional(),
  })
  .superRefine((action, ctx) => {
    const need = (field: string, present: boolean, message: string) => {
      if (!present) {
        ctx.addIssue({ code: "custom", path: [field], message });
      }
    };
    switch (action.type) {
      case "percent":
        need("percent", action.percent !== undefined, "percent is required for a percent discount.");
        break;
      case "fixed_per_item":
      case "fixed_whole_cart":
        need(
          "amountCents",
          action.amountCents !== undefined,
          "amountCents is required for a fixed discount.",
        );
        break;
      case "buy_x_get_y":
        need("buyQty", action.buyQty !== undefined, "buyQty is required for Buy-X-Get-Y.");
        need("getQty", action.getQty !== undefined, "getQty is required for Buy-X-Get-Y.");
        break;
      case "gift":
        need(
          "giftProductId",
          action.giftProductId !== undefined,
          "giftProductId is required for a gift reward.",
        );
        break;
      case "free_shipping":
        break;
    }
  });

export type DiscountAction = z.infer<typeof discountActionSchema>;

/** A stored DiscountRule row, parsed defensively (see header note). */
export const discountRuleSchema = z
  .object({
    id: z.string().min(1),
    kyteId: z.string().min(1),
    orgId: z.string().min(1),
    name: z.string().trim().min(1).max(MAX_RULE_NAME_LENGTH),
    kind: discountRuleKindSchema,
    mechanism: discountMechanismSchema,
    trigger: discountTriggerSchema,
    active: z.boolean(),
    priority: z.number().int().min(0).max(MAX_RULE_PRIORITY),
    stopOtherRules: z.boolean(),
    startsAt: z.date().nullable(),
    endsAt: z.date().nullable(),
    target: discountTargetSchema,
    conditions: discountConditionsSchema,
    action: discountActionSchema,
  })
  .superRefine((rule, ctx) => {
    // Kind/mechanism/trigger must agree — they are three views of one thing.
    const expectedMechanism: DiscountMechanism =
      rule.kind === "catalog" ? "catalogue" : rule.trigger === "coupon" ? "voucher" : "order";
    if (rule.mechanism !== expectedMechanism) {
      ctx.addIssue({
        code: "custom",
        path: ["mechanism"],
        message: `mechanism must be "${expectedMechanism}" for kind "${rule.kind}" + trigger "${rule.trigger}".`,
      });
    }
    // Catalog rules price products, so only per-item actions make sense
    // there; whole-cart / Buy-X-Get-Y / free-shipping / gift are checkout
    // concepts and belong on cart rules.
    if (
      rule.kind === "catalog" &&
      rule.action.type !== "percent" &&
      rule.action.type !== "fixed_per_item"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["action", "type"],
        message: `Catalog rules only support percent and fixed_per_item actions, not ${rule.action.type}.`,
      });
    }
    if (rule.startsAt && rule.endsAt && rule.endsAt <= rule.startsAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be after startsAt.",
      });
    }
  });

export type DiscountRule = z.infer<typeof discountRuleSchema>;

/** Input for creating/updating a rule (no ids, no org — those come from context). */
export const discountRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_RULE_NAME_LENGTH),
    kind: discountRuleKindSchema.default("cart"),
    trigger: discountTriggerSchema.default("automatic"),
    active: z.boolean().default(true),
    priority: z.number().int().min(0).max(MAX_RULE_PRIORITY).default(0),
    stopOtherRules: z.boolean().default(false),
    startsAt: z.date().nullable().optional(),
    endsAt: z.date().nullable().optional(),
    target: discountTargetSchema.default("entire_order"),
    conditions: discountConditionsSchema.default({}),
    action: discountActionSchema,
  })
  .superRefine((rule, ctx) => {
    if (
      rule.kind === "catalog" &&
      rule.action.type !== "percent" &&
      rule.action.type !== "fixed_per_item"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["action", "type"],
        message: `Catalog rules only support percent and fixed_per_item actions, not ${rule.action.type}.`,
      });
    }
    if (rule.startsAt && rule.endsAt && rule.endsAt <= rule.startsAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be after startsAt.",
      });
    }
  });

export type DiscountRuleInput = z.infer<typeof discountRuleInputSchema>;

/** Derive Saleor's mechanism from kind + trigger — one rule, three views. */
export function mechanismForRule(
  kind: DiscountRuleKind,
  trigger: DiscountTrigger,
): DiscountMechanism {
  if (kind === "catalog") return "catalogue";
  return trigger === "coupon" ? "voucher" : "order";
}

/** Normalize a coupon code the way the DB stores it: trimmed + uppercased. */
export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

export const couponCodeSchema = z
  .string()
  .trim()
  .min(MIN_COUPON_CODE_LENGTH)
  .max(MAX_COUPON_CODE_LENGTH)
  .transform((code) => normalizeCouponCode(code))
  .refine((code) => /^[A-Z0-9][A-Z0-9_-]*$/.test(code), {
    message: "Coupon codes use letters, digits, hyphens, and underscores only.",
  });

/** A stored Coupon row, parsed defensively. */
export const couponSchema = z.object({
  id: z.string().min(1),
  kyteId: z.string().min(1),
  orgId: z.string().min(1),
  ruleId: z.string().min(1),
  code: couponCodeSchema,
  usageCount: z.number().int().min(0),
  maxUses: z.number().int().min(1).nullable(),
  maxUsesPerCustomer: z.number().int().min(1).nullable(),
  startsAt: z.date().nullable(),
  endsAt: z.date().nullable(),
  active: z.boolean(),
  generated: z.boolean(),
});

export type Coupon = z.infer<typeof couponSchema>;

/** Input for a single hand-typed coupon code (Bagisto "single manual code"). */
export const createCouponInputSchema = z
  .object({
    code: couponCodeSchema,
    maxUses: z.number().int().min(1).nullable().optional(),
    maxUsesPerCustomer: z.number().int().min(1).nullable().optional(),
    startsAt: z.date().nullable().optional(),
    endsAt: z.date().nullable().optional(),
    active: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be after startsAt.",
      });
    }
  });

export type CreateCouponInput = z.infer<typeof createCouponInputSchema>;

/** Bagisto's bulk auto-generation bounds: length 4–30, quantity 1–100. */
export const couponCharsetSchema = z.enum(["alphanumeric", "alphabetic", "numeric"]);
export type CouponCharset = z.infer<typeof couponCharsetSchema>;

export const generateCouponsInputSchema = z
  .object({
    quantity: z.number().int().min(MIN_COUPON_GENERATE_QUANTITY).max(MAX_COUPON_GENERATE_QUANTITY),
    length: z.number().int().min(MIN_COUPON_GENERATE_LENGTH).max(MAX_COUPON_GENERATE_LENGTH),
    prefix: z
      .string()
      .trim()
      .max(MAX_COUPON_PREFIX_LENGTH)
      .transform((s) => normalizeCouponCode(s))
      .optional(),
    suffix: z
      .string()
      .trim()
      .max(MAX_COUPON_SUFFIX_LENGTH)
      .transform((s) => normalizeCouponCode(s))
      .optional(),
    charset: couponCharsetSchema.default("alphanumeric"),
    maxUses: z.number().int().min(1).nullable().optional(),
    maxUsesPerCustomer: z.number().int().min(1).nullable().optional(),
    startsAt: z.date().nullable().optional(),
    endsAt: z.date().nullable().optional(),
  })
  .superRefine((input, ctx) => {
    const total = input.length + (input.prefix?.length ?? 0) + (input.suffix?.length ?? 0);
    if (total > MAX_COUPON_CODE_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["length"],
        message: `Prefix + code + suffix must be at most ${MAX_COUPON_CODE_LENGTH} characters (got ${total}).`,
      });
    }
    if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be after startsAt.",
      });
    }
  });

export type GenerateCouponsInput = z.infer<typeof generateCouponsInputSchema>;

/** What collectTotals() records for one applied rule (also the Purchase audit trail). */
export const appliedDiscountSchema = z.object({
  ruleId: z.string().min(1),
  ruleName: z.string().min(1),
  mechanism: discountMechanismSchema,
  amountCents: z.number().int().min(0),
  description: z.string().min(1),
});

export type AppliedDiscount = z.infer<typeof appliedDiscountSchema>;

/** Stored on Purchase.discountBreakdown: the audit trail of a checkout. */
export const discountBreakdownSchema = z.object({
  applied: z.array(appliedDiscountSchema),
  giftProductIds: z.array(z.string().min(1)),
});

export type DiscountBreakdown = z.infer<typeof discountBreakdownSchema>;
