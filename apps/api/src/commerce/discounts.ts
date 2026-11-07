import { randomInt } from "node:crypto";
import {
  discountRuleSchema,
  normalizeCouponCode,
  type CouponCharset,
  type DiscountAction,
  type DiscountRule,
  type GenerateCouponsInput,
} from "@kytelink/schemas";

// ─── FreeTree Discount Engine ────────────────────────────────────────────────
// Bagisto's two engines (Catalog Rules + Cart Rules) + Saleor's
// three-mechanism shape (catalogue promotions / order promotions / vouchers),
// rebuilt natively. MODELS ONLY — no Bagisto/Saleor code is run or copied.
//
// Two hard rules live here:
//   1. Catalog rules apply AT READ TIME (applyCatalogRules). No stored sale
//      price, no reindex — Bagisto's gotcha is that saving a catalog rule
//      fires a full price reindex that can blow past HTTP timeouts.
//   2. collectTotals() is the ONE place a checkout total is computed. Every
//      discount flows through it, and the caller feeds its DISCOUNTED total
//      into computeFeeCents at both the charge site and the seller-preview
//      site, so the two agree. FreeTree native discounts and Stripe promo
//      codes are mutually exclusive per checkout (the route disables
//      allow_promotion_codes whenever this engine discounts anything) —
//      otherwise the same order would be discounted twice.
//
// This module is pure except for the coupon redeem/release pair at the
// bottom, which take a minimal structural db handle (no Prisma import, so
// these tests run without the generated client — see the forms router test
// for why that matters locally).

export type EngineRule = DiscountRule;

export interface CatalogProductInput {
  id: string;
  priceCents: number;
}

export interface CatalogPriceResult {
  /** Price the buyer actually sees / pays (list price minus catalog rules). */
  priceCents: number;
  listPriceCents: number;
  applied: Array<{ ruleId: string; ruleName: string; amountCents: number }>;
}

export interface CartLineInput {
  productId: string;
  name?: string;
  /** Unit price AFTER catalog rules — the price the buyer sees. */
  unitPriceCents: number;
  quantity: number;
}

export interface CollectTotalsInput {
  lines: CartLineInput[];
  /** Shipping the buyer would pay before discounts (0 for digital goods). */
  shippingCents?: number;
  /** Normalized code the buyer entered, if any. */
  couponCode?: string | null;
  /** The coupon's rule, resolved by the caller. Null = no code entered. */
  couponRule?: EngineRule | null;
}

export interface GiftLine {
  productId: string;
  quantity: number;
}

export interface TotalsResult {
  /** Sum of line unit prices × quantities, before cart rules. */
  subtotalCents: number;
  /** Total taken off the subtotal by cart rules (excludes shipping). */
  discountCents: number;
  /** Shipping before discounts. */
  shippingCents: number;
  /** Shipping taken off by free-shipping rules. */
  shippingDiscountCents: number;
  /** What the buyer is actually charged: subtotal − discount + shipping. */
  totalCents: number;
  applied: Array<{
    ruleId: string;
    ruleName: string;
    mechanism: EngineRule["mechanism"];
    amountCents: number;
    description: string;
  }>;
  /** Zero-priced lines a GIFT rule added (Saleor's gift reward). */
  giftLines: GiftLine[];
  /** True when a free-shipping rule fired (even if shipping was already 0). */
  freeShipping: boolean;
  /** True when the entered coupon's rule actually applied a discount/gift. */
  couponApplied: boolean;
  /** Why an entered coupon did not apply (conditions not met, etc.). */
  couponNotAppliedReason?: string;
}

/** Stripe Checkout's minimum charge for USD (50¢). Below this a session can't be created. */
export const STRIPE_MINIMUM_CHARGE_CENTS = 50;

/** A rule only fires inside its window, while active. */
export function isRuleInWindow(
  rule: Pick<EngineRule, "active" | "startsAt" | "endsAt">,
  now: Date,
): boolean {
  if (!rule.active) return false;
  if (rule.startsAt && rule.startsAt > now) return false;
  if (rule.endsAt && rule.endsAt < now) return false;
  return true;
}

/** Product-conditions gate: empty/absent productIds = every product. */
function ruleAppliesToProduct(
  rule: EngineRule,
  productId: string,
): boolean {
  const ids = rule.conditions.productIds;
  if (!ids || ids.length === 0) return true;
  return ids.includes(productId);
}

function sortRules(rules: EngineRule[]): EngineRule[] {
  return [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/**
 * Catalog pricing at READ time. Applies the seller's catalog rules (kind
 * "catalog") to one product's list price, in priority order, compounding.
 * Returns the effective price plus what each rule took off. Never writes
 * anything — the list price in the DB is untouched.
 */
export function applyCatalogRules(
  product: CatalogProductInput,
  rules: EngineRule[],
  now: Date = new Date(),
): CatalogPriceResult {
  let price = product.priceCents;
  const applied: CatalogPriceResult["applied"] = [];
  for (const rule of sortRules(rules)) {
    if (rule.kind !== "catalog") continue;
    if (!isRuleInWindow(rule, now)) continue;
    if (!ruleAppliesToProduct(rule, product.id)) continue;
    const before = price;
    if (rule.action.type === "percent") {
      price = Math.max(0, price - Math.round((price * rule.action.percent!) / 100));
    } else if (rule.action.type === "fixed_per_item") {
      price = Math.max(0, price - rule.action.amountCents!);
    } else {
      // Catalog rules only carry per-item actions (the schema enforces it);
      // skip anything else rather than mis-pricing.
      continue;
    }
    if (price !== before) {
      applied.push({ ruleId: rule.id, ruleName: rule.name, amountCents: before - price });
    }
    if (rule.stopOtherRules) break;
  }
  return { priceCents: price, listPriceCents: product.priceCents, applied };
}

// ─── collectTotals — the totals choke-point ──────────────────────────────────

function eligibleLines(
  input: CollectTotalsInput,
  rule: EngineRule,
): CartLineInput[] {
  return input.lines.filter((line) => ruleAppliesToProduct(rule, line.productId));
}

function linesTotal(lines: CartLineInput[]): number {
  return lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
}

function linesQuantity(lines: CartLineInput[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

/**
 * Free units for Buy-X-Get-Y on one line: complete (buy+get) sets give
 * getQty free each; a partial set gives the remainder over buyQty free
 * (capped at getQty). E.g. buy 2 get 1: qty 3 → 1 free, qty 5 → 1 free
 * (pay 4), qty 6 → 2 free, qty 8 → 2 free (pay 6).
 */
function freeUnitsForLine(quantity: number, buyQty: number, getQty: number): number {
  const setSize = buyQty + getQty;
  const fullSets = Math.floor(quantity / setSize);
  const remainder = quantity % setSize;
  const partialFree = Math.max(0, Math.min(getQty, remainder - buyQty));
  return fullSets * getQty + partialFree;
}

function describeAction(rule: EngineRule): string {
  const a: DiscountAction = rule.action;
  switch (a.type) {
    case "percent":
      return `${a.percent}% off`;
    case "fixed_per_item":
      return `$${((a.amountCents ?? 0) / 100).toFixed(2)} off per item`;
    case "fixed_whole_cart":
      return `$${((a.amountCents ?? 0) / 100).toFixed(2)} off order`;
    case "buy_x_get_y":
      return `Buy ${a.buyQty} get ${a.getQty} free`;
    case "free_shipping":
      return "Free shipping";
    case "gift":
      return "Free gift";
    default: {
      // Unreachable for validated rows; a hand-edited action JSON could
      // still land here — fail loudly instead of pricing silently.
      const _never: never = a.type;
      throw new Error(`Unknown discount action type: ${String(_never)}`);
    }
  }
}

/**
 * THE choke-point: the one place a checkout total is computed. Every
 * discount — automatic cart rules, the entered coupon's rule, gift lines —
 * flows through here, in priority order, honoring each rule's "End Other
 * Rules" stop-flag. Per-rule discounts are computed against the ORIGINAL
 * line prices and the running total is capped at the subtotal, so stacked
 * rules can never drive the total below zero (and can never double-count
 * the same cent twice within one rule).
 *
 * Callers pass lines at their CATALOG-discounted unit prices, so Saleor's
 * order-predicate (minSubtotalCents) is judged on the subtotal the buyer
 * actually sees, after catalogue promotions.
 */
export function collectTotals(
  input: CollectTotalsInput,
  rules: EngineRule[],
  now: Date = new Date(),
): TotalsResult {
  const lines = input.lines.map((line) => ({
    ...line,
    quantity: Math.max(0, Math.floor(line.quantity)),
    unitPriceCents: Math.max(0, Math.floor(line.unitPriceCents)),
  }));
  if (lines.length === 0) {
    throw new Error("collectTotals requires at least one cart line.");
  }
  if (lines.some((line) => line.quantity < 1)) {
    throw new Error("collectTotals requires every line to have quantity >= 1.");
  }

  const shippingCents = Math.max(0, Math.floor(input.shippingCents ?? 0));
  const subtotalCents = linesTotal(lines);
  const totalQuantity = linesQuantity(lines);

  // Candidate cart rules: automatic ones, plus the entered coupon's rule
  // (one coupon per cart — a code never activates any other coupon rule).
  const candidates = sortRules(rules).filter((rule) => {
    if (rule.kind !== "cart") return false;
    if (!isRuleInWindow(rule, now)) return false;
    if (rule.trigger === "coupon") {
      return input.couponRule !== null && input.couponRule !== undefined && input.couponRule.id === rule.id;
    }
    return true;
  });

  const applied: TotalsResult["applied"] = [];
  const giftLines: GiftLine[] = [];
  let discountCents = 0;
  let shippingDiscountCents = 0;
  let freeShipping = false;
  let couponApplied = false;
  let couponNotAppliedReason: string | undefined;

  for (const rule of candidates) {
    const isCouponRule =
      input.couponRule !== null && input.couponRule !== undefined && input.couponRule.id === rule.id;
    const eligible = eligibleLines(input, rule);
    const eligibleTotal = linesTotal(eligible);
    const eligibleQty = linesQuantity(eligible);

    // Conditions gate (all AND together).
    if (rule.conditions.minSubtotalCents !== undefined && subtotalCents < rule.conditions.minSubtotalCents) {
      if (isCouponRule) {
        couponNotAppliedReason = `Order subtotal is below the ${rule.conditions.minSubtotalCents}¢ minimum for this code.`;
      }
      continue;
    }
    if (rule.conditions.minQuantity !== undefined && totalQuantity < rule.conditions.minQuantity) {
      if (isCouponRule) {
        couponNotAppliedReason = `This code needs at least ${rule.conditions.minQuantity} items in the order.`;
      }
      continue;
    }
    if (eligible.length === 0) {
      if (isCouponRule) {
        couponNotAppliedReason = "This code does not apply to the items in this order.";
      }
      continue;
    }

    const remaining = subtotalCents - discountCents;
    let amount = 0;
    switch (rule.action.type) {
      case "percent": {
        amount = Math.min(remaining, Math.round((eligibleTotal * rule.action.percent!) / 100));
        break;
      }
      case "fixed_per_item": {
        amount = Math.min(remaining, Math.min(eligibleTotal, rule.action.amountCents! * eligibleQty));
        break;
      }
      case "fixed_whole_cart": {
        amount = Math.min(remaining, rule.action.amountCents!);
        break;
      }
      case "buy_x_get_y": {
        const buyQty = rule.action.buyQty!;
        const getQty = rule.action.getQty!;
        let freeValue = 0;
        for (const line of eligible) {
          freeValue += freeUnitsForLine(line.quantity, buyQty, getQty) * line.unitPriceCents;
        }
        amount = Math.min(remaining, freeValue);
        break;
      }
      case "free_shipping": {
        // Shipping discount, not a subtotal discount — tracked separately
        // so discountCents stays "money off the goods".
        shippingDiscountCents = shippingCents;
        freeShipping = true;
        amount = shippingCents;
        break;
      }
      case "gift": {
        giftLines.push({ productId: rule.action.giftProductId!, quantity: 1 });
        amount = 0;
        break;
      }
    }

    if (rule.action.type !== "free_shipping") {
      discountCents += amount;
    }
    applied.push({
      ruleId: rule.id,
      ruleName: rule.name,
      mechanism: rule.mechanism,
      amountCents: amount,
      description: describeAction(rule),
    });
    if (isCouponRule) couponApplied = true;
    if (rule.stopOtherRules) break;
  }

  // An entered code whose rule never fired gets a reason (unless a more
  // specific one was set above — e.g. an earlier rule's stop-flag cut it
  // off, which is also worth saying).
  if (input.couponCode && input.couponRule && !couponApplied && !couponNotAppliedReason) {
    couponNotAppliedReason =
      "This code did not apply to this order (another discount took priority).";
  }

  const totalCents = Math.max(0, subtotalCents - discountCents) + Math.max(0, shippingCents - shippingDiscountCents);
  return {
    subtotalCents,
    discountCents,
    shippingCents,
    shippingDiscountCents,
    totalCents,
    applied,
    giftLines,
    freeShipping,
    couponApplied,
    couponNotAppliedReason,
  };
}

// ─── Coupon code generation (Bagisto bulk generator) ─────────────────────────

/**
 * Unambiguous alphabets (no 0/O, no 1/I) — a buyer typing a code off a
 * screenshot should not have to guess. Bagisto's charsets are plain
 * A-Z/0-9; the unambiguous sets are a deliberate deviation for that reason.
 */
const CHARSETS: Record<CouponCharset, string> = {
  alphanumeric: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  alphabetic: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  numeric: "23456789",
};

function randomCodePart(
  length: number,
  charset: string,
  rand: (min: number, max: number) => number,
): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += charset[rand(0, charset.length)];
  }
  return out;
}

/**
 * Bulk coupon codes (Bagisto: length 4–30, prefix/suffix, quantity 1–100).
 * `length` is the random middle; prefix/suffix wrap it. Codes are unique
 * within the batch; cross-batch collisions are caught by the DB's unique
 * (orgId, code) index and skipped on insert (createMany skipDuplicates).
 */
export function generateCouponCodes(
  input: GenerateCouponsInput,
  rand: (min: number, max: number) => number = randomInt,
): string[] {
  const prefix = normalizeCouponCode(input.prefix ?? "");
  const suffix = normalizeCouponCode(input.suffix ?? "");
  const charset = CHARSETS[input.charset];
  const codes = new Set<string>();
  let attempts = 0;
  const maxAttempts = input.quantity * 50 + 100;
  while (codes.size < input.quantity) {
    if (++attempts > maxAttempts) {
      throw new Error(
        `Could not generate ${input.quantity} unique codes — the code space is exhausted for this length/charset.`,
      );
    }
    codes.add(`${prefix}${randomCodePart(input.length, charset, rand)}${suffix}`);
  }
  return [...codes];
}

// ─── Coupon validation (fast-fail messaging; the atomic UPDATE decides) ─────

export type CouponCheck =
  | "ok"
  | "inactive"
  | "not_started"
  | "expired"
  | "exhausted"
  | "per_customer_cap";

export interface CouponRowView {
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  usageCount: number;
  maxUses: number | null;
  maxUsesPerCustomer: number | null;
}

/**
 * Read-side check of a coupon row, for the "your code is expired / used up"
 * message BEFORE a Purchase row exists. This is messaging only: the
 * authoritative decision is the atomic UPDATE in redeemCouponAtomic, which
 * re-checks every one of these guards in its WHERE clause — a code can pass
 * this check and still lose the race, and that is correct.
 */
export function checkCoupon(
  coupon: CouponRowView,
  now: Date,
  buyerRedemptionCount: number | null,
): CouponCheck {
  if (!coupon.active) return "inactive";
  if (coupon.startsAt && coupon.startsAt > now) return "not_started";
  if (coupon.endsAt && coupon.endsAt < now) return "expired";
  if (coupon.maxUses !== null && coupon.usageCount >= coupon.maxUses) return "exhausted";
  if (
    coupon.maxUsesPerCustomer !== null &&
    buyerRedemptionCount !== null &&
    buyerRedemptionCount >= coupon.maxUsesPerCustomer
  ) {
    return "per_customer_cap";
  }
  return "ok";
}

// ─── Coupon resolution (shared by the checkout route + seller preview) ─────

/**
 * Buyer-facing error for a failed coupon check. Null when the coupon is
 * usable. The route maps `status` to HTTP, the router to TRPC errors.
 */
export function couponCheckError(check: CouponCheck): {
  code: "COUPON_INVALID" | "COUPON_EXHAUSTED" | "COUPON_ALREADY_USED";
  status: number;
  message: string;
} | null {
  switch (check) {
    case "ok":
      return null;
    case "inactive":
      return { code: "COUPON_INVALID", status: 400, message: "That code is no longer active." };
    case "not_started":
      return { code: "COUPON_INVALID", status: 400, message: "That code is not active yet." };
    case "expired":
      return { code: "COUPON_INVALID", status: 400, message: "That code has expired." };
    case "exhausted":
      return { code: "COUPON_EXHAUSTED", status: 409, message: "That code has been used up." };
    case "per_customer_cap":
      return {
        code: "COUPON_ALREADY_USED",
        status: 409,
        message: "You've already used that code.",
      };
  }
}

export interface CouponRow extends CouponRowView {
  id: string;
  orgId: string;
  ruleId: string;
  code: string;
}

/** Minimal db handle for coupon lookup (structural — see CouponRedeemDb). */
export interface CouponLookupDb {
  coupon: {
    findFirst: (args: { where: { orgId: string; code: string } }) => Promise<CouponRow | null>;
  };
  discountRule: {
    findUnique: (args: { where: { id: string } }) => Promise<unknown>;
  };
  couponRedemption: {
    count: (args: { where: { couponId: string; buyerEmail: string } }) => Promise<number>;
  };
}

/** Thrown when a code can't be used; carries the buyer-facing error. */
export class CouponResolutionError extends Error {
  readonly code: "COUPON_INVALID" | "COUPON_EXHAUSTED" | "COUPON_ALREADY_USED";
  readonly status: number;
  constructor(code: "COUPON_INVALID" | "COUPON_EXHAUSTED" | "COUPON_ALREADY_USED", message: string) {
    super(message);
    this.name = "CouponResolutionError";
    this.code = code;
    this.status = code === "COUPON_INVALID" ? 400 : 409;
  }
}

/**
 * Resolve a buyer-entered code to its coupon + rule, org-scoped, with the
 * fast-fail checks (active / window / caps) for messaging. This is the
 * read side only: the authoritative decision is still the atomic UPDATE in
 * redeemCouponAtomic, which re-checks every guard — a code can pass here
 * and still lose the race, and that is correct.
 */
export async function resolveCoupon(
  db: CouponLookupDb,
  input: { orgId: string; code: string; buyerEmail: string | null; now?: Date },
): Promise<{ coupon: CouponRow; rule: EngineRule }> {
  const now = input.now ?? new Date();
  const normalized = normalizeCouponCode(input.code);
  const coupon = await db.coupon.findFirst({ where: { orgId: input.orgId, code: normalized } });
  if (!coupon) {
    throw new CouponResolutionError("COUPON_INVALID", "That code isn't valid for this seller.");
  }
  const rawRule = await db.discountRule.findUnique({ where: { id: coupon.ruleId } });
  const parsed = discountRuleSchema.safeParse(rawRule);
  if (
    !parsed.success ||
    parsed.data.orgId !== input.orgId ||
    parsed.data.kind !== "cart" ||
    parsed.data.trigger !== "coupon"
  ) {
    throw new CouponResolutionError("COUPON_INVALID", "That code isn't valid for this seller.");
  }
  const rule = parsed.data;
  const buyerRedemptionCount = input.buyerEmail
    ? await db.couponRedemption.count({
        where: { couponId: coupon.id, buyerEmail: input.buyerEmail },
      })
    : null;
  const err = couponCheckError(checkCoupon(coupon, now, buyerRedemptionCount));
  if (err) {
    throw new CouponResolutionError(err.code, err.message);
  }
  return { coupon, rule };
}

// ─── Atomic coupon redemption (Stacks Commerce rule) ─────────────────────────

/**
 * Minimal db handle for the redeem/release pair. Structural on purpose:
 * the real PrismaClient satisfies it, and unit tests pass a stub — so this
 * file never imports @kytelink/db (whose generated client can't be built
 * locally) while the SQL it emits is still tested verbatim.
 */
export interface CouponRedeemDb {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
  $transaction: <T>(
    fn: (
      tx: CouponRedeemDb & {
        couponRedemption: {
          create: (args: {
            data: { couponId: string; orgId: string; buyerEmail: string | null; purchaseId: string | null };
          }) => Promise<unknown>;
          deleteMany: (args: {
            where: { couponId: string; purchaseId: string | null };
          }) => Promise<unknown>;
        };
      },
    ) => Promise<T>,
  ) => Promise<T>;
}

export interface RedeemCouponInput {
  couponId: string;
  orgId: string;
  /** Null for anonymous buyers — the per-customer cap can't attribute them. */
  buyerEmail: string | null;
  purchaseId: string | null;
  now?: Date;
}

/**
 * The atomic redeem statement. Every guard lives in the WHERE clause, so
 * two buyers redeeming the last use of a code simultaneously cannot both
 * succeed: Postgres serializes the two UPDATEs on the row lock, the second
 * sees usageCount already bumped (or the redemption subquery already
 * counted), and its UPDATE matches zero rows.
 *
 * Binding order (positional, $1..$4): couponId, orgId, now, buyerEmail.
 * The fake db in discounts.test.ts decodes them in this order — if you
 * change the order, update the fake too.
 */
export function buildRedeemCouponSql(input: RedeemCouponInput): { text: string; values: unknown[] } {
  const now = input.now ?? new Date();
  const text = [
    `UPDATE "Coupon"`,
    `SET "usageCount" = "usageCount" + 1, "updatedAt" = NOW()`,
    `WHERE "id" = $1`,
    `  AND "orgId" = $2`,
    `  AND "active" = true`,
    `  AND ("startsAt" IS NULL OR "startsAt" <= $3)`,
    `  AND ("endsAt" IS NULL OR "endsAt" >= $3)`,
    `  AND ("maxUses" IS NULL OR "usageCount" < "maxUses")`,
    `  AND ("maxUsesPerCustomer" IS NULL OR $4::text IS NULL OR (`,
    `    SELECT COUNT(*) FROM "CouponRedemption"`,
    `    WHERE "CouponRedemption"."couponId" = $1`,
    `      AND "CouponRedemption"."buyerEmail" = $4`,
    `  ) < "maxUsesPerCustomer")`,
  ].join("\n");
  return { text, values: [input.couponId, input.orgId, now, input.buyerEmail] };
}

/**
 * Redeem one use of a coupon, atomically. Returns true when the use was
 * claimed (usageCount bumped + redemption row written, in one transaction);
 * false when the coupon failed a guard — the caller re-reads the row and
 * classifies the failure with checkCoupon() for the error message. The
 * database decides the race, not read-check-write.
 */
export async function redeemCouponAtomic(
  db: CouponRedeemDb,
  input: RedeemCouponInput,
): Promise<boolean> {
  const { text, values } = buildRedeemCouponSql(input);
  return db.$transaction(async (tx) => {
    const updated = await tx.$executeRawUnsafe(text, ...values);
    if (updated !== 1) return false;
    await tx.couponRedemption.create({
      data: {
        couponId: input.couponId,
        orgId: input.orgId,
        buyerEmail: input.buyerEmail,
        purchaseId: input.purchaseId,
      },
    });
    return true;
  });
}

/**
 * Compensating release: called (best-effort, caller logs failures) when a
 * checkout that already redeemed a coupon then fails — e.g. Stripe session
 * creation throws — so the use goes back to the pool instead of being
 * burned by an order that never existed. Deletes the redemption row for
 * this purchase and decrements usageCount (floored at 0).
 */
export async function releaseCouponRedemption(
  db: CouponRedeemDb,
  input: { couponId: string; orgId: string; purchaseId: string | null },
): Promise<void> {
  const text = [
    `UPDATE "Coupon"`,
    `SET "usageCount" = GREATEST(0, "usageCount" - 1), "updatedAt" = NOW()`,
    `WHERE "id" = $1 AND "orgId" = $2 AND "usageCount" > 0`,
  ].join("\n");
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(text, input.couponId, input.orgId);
    await tx.couponRedemption.deleteMany({
      where: { couponId: input.couponId, purchaseId: input.purchaseId },
    });
  });
}
