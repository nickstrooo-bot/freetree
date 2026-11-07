import { describe, expect, it } from "vitest";
import type { DiscountRule } from "@kytelink/schemas";
import {
  applyCatalogRules,
  buildRedeemCouponSql,
  checkCoupon,
  collectTotals,
  couponCheckError,
  CouponResolutionError,
  generateCouponCodes,
  redeemCouponAtomic,
  releaseCouponRedemption,
  resolveCoupon,
  STRIPE_MINIMUM_CHARGE_CENTS,
  type CouponLookupDb,
  type CouponRedeemDb,
  type EngineRule,
} from "./discounts";

const NOW = new Date("2026-11-07T12:00:00Z");

function rule(partial: Partial<DiscountRule> & { id: string }): EngineRule {
  return {
    kyteId: "kyte_1",
    orgId: "org_1",
    name: "Rule",
    kind: "cart",
    mechanism: "order",
    trigger: "automatic",
    active: true,
    priority: 0,
    stopOtherRules: false,
    startsAt: null,
    endsAt: null,
    target: "entire_order",
    conditions: {},
    action: { type: "percent", percent: 10 },
    ...partial,
  } as EngineRule;
}

const line = (productId: string, unitPriceCents: number, quantity = 1) => ({
  productId,
  unitPriceCents,
  quantity,
});

// ─── Catalog rules (read-time sale pricing) ──────────────────────────────────

describe("applyCatalogRules", () => {
  it("returns the list price unchanged with no rules", () => {
    const result = applyCatalogRules({ id: "p1", priceCents: 2000 }, [], NOW);
    expect(result.priceCents).toBe(2000);
    expect(result.applied).toEqual([]);
  });

  it("applies a percent catalog rule at read time", () => {
    const result = applyCatalogRules(
      { id: "p1", priceCents: 2000 },
      [rule({ id: "r1", kind: "catalog", mechanism: "catalogue", action: { type: "percent", percent: 25 } })],
      NOW,
    );
    expect(result.priceCents).toBe(1500);
    expect(result.applied).toEqual([{ ruleId: "r1", ruleName: "Rule", amountCents: 500 }]);
  });

  it("applies a fixed catalog rule and never goes below zero", () => {
    const result = applyCatalogRules(
      { id: "p1", priceCents: 300 },
      [rule({ id: "r1", kind: "catalog", mechanism: "catalogue", action: { type: "fixed_per_item", amountCents: 500 } })],
      NOW,
    );
    expect(result.priceCents).toBe(0);
  });

  it("compounds rules in priority order and honors the stop flag", () => {
    const rules = [
      rule({ id: "r-low", kind: "catalog", mechanism: "catalogue", priority: 10, action: { type: "percent", percent: 50 } }),
      rule({ id: "r-high", kind: "catalog", mechanism: "catalogue", priority: 1, stopOtherRules: true, action: { type: "percent", percent: 10 } }),
    ];
    const result = applyCatalogRules({ id: "p1", priceCents: 1000 }, rules, NOW);
    // 10% off first (1000 -> 900), then the stop flag ends processing.
    expect(result.priceCents).toBe(900);
    expect(result.applied.map((a) => a.ruleId)).toEqual(["r-high"]);
  });

  it("ignores inactive and out-of-window rules, and rules scoped to other products", () => {
    const rules = [
      rule({ id: "r-inactive", kind: "catalog", mechanism: "catalogue", active: false, action: { type: "percent", percent: 90 } }),
      rule({ id: "r-future", kind: "catalog", mechanism: "catalogue", startsAt: new Date("2026-12-01"), action: { type: "percent", percent: 90 } }),
      rule({ id: "r-past", kind: "catalog", mechanism: "catalogue", endsAt: new Date("2026-11-01"), action: { type: "percent", percent: 90 } }),
      rule({ id: "r-other", kind: "catalog", mechanism: "catalogue", conditions: { productIds: ["p2"] }, action: { type: "percent", percent: 90 } }),
    ];
    expect(applyCatalogRules({ id: "p1", priceCents: 1000 }, rules, NOW).priceCents).toBe(1000);
  });

  it("does not let a cart rule change the listing price", () => {
    const result = applyCatalogRules(
      { id: "p1", priceCents: 1000 },
      [rule({ id: "r1", action: { type: "percent", percent: 50 } })],
      NOW,
    );
    expect(result.priceCents).toBe(1000);
  });
});

// ─── collectTotals — the choke-point ─────────────────────────────────────────

describe("collectTotals", () => {
  it("is the identity with no rules: subtotal == total, no discount", () => {
    const t = collectTotals({ lines: [line("p1", 2000), line("p2", 500, 2)] }, [], NOW);
    expect(t).toMatchObject({ subtotalCents: 3000, discountCents: 0, totalCents: 3000 });
    expect(t.applied).toEqual([]);
    expect(t.giftLines).toEqual([]);
  });

  it("applies a percent cart rule to the whole cart", () => {
    const t = collectTotals(
      { lines: [line("p1", 1000, 2)] },
      [rule({ id: "r1", action: { type: "percent", percent: 20 } })],
      NOW,
    );
    expect(t.discountCents).toBe(400);
    expect(t.totalCents).toBe(1600);
    expect(t.applied[0]).toMatchObject({ ruleId: "r1", amountCents: 400 });
  });

  it("applies fixed-per-item and fixed-whole-cart actions", () => {
    const perItem = collectTotals(
      { lines: [line("p1", 1000, 3)] },
      [rule({ id: "r1", action: { type: "fixed_per_item", amountCents: 250 } })],
      NOW,
    );
    expect(perItem.discountCents).toBe(750);
    expect(perItem.totalCents).toBe(2250);

    const wholeCart = collectTotals(
      { lines: [line("p1", 1000, 3)] },
      [rule({ id: "r1", action: { type: "fixed_whole_cart", amountCents: 500 } })],
      NOW,
    );
    expect(wholeCart.discountCents).toBe(500);
    expect(wholeCart.totalCents).toBe(2500);
  });

  it("caps fixed discounts at the subtotal — the total never goes negative", () => {
    const t = collectTotals(
      { lines: [line("p1", 400)] },
      [rule({ id: "r1", action: { type: "fixed_whole_cart", amountCents: 99999 } })],
      NOW,
    );
    expect(t.discountCents).toBe(400);
    expect(t.totalCents).toBe(0);
  });

  it("stacks rules in priority order and stops at End Other Rules", () => {
    const rules = [
      rule({ id: "r-second", priority: 20, action: { type: "percent", percent: 50 } }),
      rule({ id: "r-first", priority: 10, stopOtherRules: true, action: { type: "percent", percent: 10 } }),
    ];
    const t = collectTotals({ lines: [line("p1", 1000)] }, rules, NOW);
    expect(t.discountCents).toBe(100);
    expect(t.applied.map((a) => a.ruleId)).toEqual(["r-first"]);
  });

  it("enforces a min-subtotal order predicate (Saleor minSpent)", () => {
    const t = collectTotals(
      { lines: [line("p1", 499)] },
      [rule({ id: "r1", conditions: { minSubtotalCents: 500 }, action: { type: "percent", percent: 10 } })],
      NOW,
    );
    expect(t.discountCents).toBe(0);
    expect(t.applied).toEqual([]);

    const ok = collectTotals(
      { lines: [line("p1", 500)] },
      [rule({ id: "r1", conditions: { minSubtotalCents: 500 }, action: { type: "percent", percent: 10 } })],
      NOW,
    );
    expect(ok.discountCents).toBe(50);
  });

  it("scopes specific-product rules to their products only", () => {
    const t = collectTotals(
      { lines: [line("p1", 1000), line("p2", 1000)] },
      [
        rule({
          id: "r1",
          target: "specific_product",
          conditions: { productIds: ["p1"] },
          action: { type: "percent", percent: 50 },
        }),
      ],
      NOW,
    );
    expect(t.discountCents).toBe(500);
    expect(t.totalCents).toBe(1500);
  });

  it("does Buy-X-Get-Y with complete and partial sets", () => {
    const buy2get1 = rule({ id: "r1", action: { type: "buy_x_get_y", buyQty: 2, getQty: 1 } });
    const cases: Array<[number, number]> = [
      [1, 0],
      [2, 0],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 2],
      [8, 2],
      [9, 3],
    ];
    for (const [qty, free] of cases) {
      const t = collectTotals({ lines: [line("p1", 1000, qty)] }, [buy2get1], NOW);
      expect(t.discountCents).toBe(free * 1000);
      expect(t.totalCents).toBe(qty * 1000 - free * 1000);
    }
  });

  it("applies free shipping without touching the goods subtotal", () => {
    const t = collectTotals(
      { lines: [line("p1", 1000)], shippingCents: 499 },
      [rule({ id: "r1", action: { type: "free_shipping" } })],
      NOW,
    );
    expect(t.shippingDiscountCents).toBe(499);
    expect(t.discountCents).toBe(0);
    expect(t.totalCents).toBe(1000);
    expect(t.freeShipping).toBe(true);
  });

  it("adds a zero-priced gift line for a GIFT reward (Saleor)", () => {
    const t = collectTotals(
      { lines: [line("p1", 2000)] },
      [rule({ id: "r1", action: { type: "gift", giftProductId: "gift_1" } })],
      NOW,
    );
    expect(t.giftLines).toEqual([{ productId: "gift_1", quantity: 1 }]);
    expect(t.totalCents).toBe(2000);
    expect(t.applied[0]).toMatchObject({ ruleId: "r1", amountCents: 0 });
  });

  it("applies a coupon rule only when its code was entered — one coupon per cart", () => {
    const couponRule = rule({
      id: "r-coupon",
      mechanism: "voucher",
      trigger: "coupon",
      action: { type: "percent", percent: 10 },
    });
    const otherCouponRule = rule({
      id: "r-other",
      mechanism: "voucher",
      trigger: "coupon",
      action: { type: "percent", percent: 90 },
    });
    const noCode = collectTotals(
      { lines: [line("p1", 1000)] },
      [couponRule, otherCouponRule],
      NOW,
    );
    expect(noCode.discountCents).toBe(0);
    expect(noCode.couponApplied).toBe(false);

    const withCode = collectTotals(
      { lines: [line("p1", 1000)], couponCode: "SAVE10", couponRule },
      [couponRule, otherCouponRule],
      NOW,
    );
    expect(withCode.discountCents).toBe(100);
    expect(withCode.couponApplied).toBe(true);
    expect(withCode.applied.map((a) => a.ruleId)).toEqual(["r-coupon"]);
  });

  it("reports why an entered coupon did not apply", () => {
    const couponRule = rule({
      id: "r-coupon",
      mechanism: "voucher",
      trigger: "coupon",
      conditions: { minSubtotalCents: 5000 },
      action: { type: "percent", percent: 10 },
    });
    const t = collectTotals(
      { lines: [line("p1", 1000)], couponCode: "SAVE10", couponRule },
      [couponRule],
      NOW,
    );
    expect(t.couponApplied).toBe(false);
    expect(t.couponNotAppliedReason).toMatch(/below the 5000/);
  });

  it("lets an automatic rule and a coupon rule stack (coupon is the one-code limit, not the only rule)", () => {
    const auto = rule({ id: "r-auto", priority: 1, action: { type: "percent", percent: 10 } });
    const couponRule = rule({
      id: "r-coupon",
      priority: 2,
      mechanism: "voucher",
      trigger: "coupon",
      action: { type: "fixed_whole_cart", amountCents: 100 },
    });
    const t = collectTotals(
      { lines: [line("p1", 1000)], couponCode: "SAVE", couponRule },
      [auto, couponRule],
      NOW,
    );
    expect(t.discountCents).toBe(200);
    expect(t.totalCents).toBe(800);
  });

  it("throws on an empty cart or a zero-quantity line", () => {
    expect(() => collectTotals({ lines: [] }, [], NOW)).toThrow(/at least one cart line/);
    expect(() => collectTotals({ lines: [line("p1", 1000, 0)] }, [], NOW)).toThrow(/quantity >= 1/);
  });
});

// ─── Coupon code generation ──────────────────────────────────────────────────

describe("generateCouponCodes", () => {
  it("generates the requested quantity of unique codes with prefix/suffix", () => {
    const codes = generateCouponCodes({
      quantity: 5,
      length: 6,
      prefix: "SUMMER",
      suffix: "25",
      charset: "alphanumeric",
    });
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
    for (const code of codes) {
      expect(code.startsWith("SUMMER")).toBe(true);
      expect(code.endsWith("25")).toBe(true);
      expect(code).toHaveLength(6 + 6 + 2);
      expect(code).toMatch(/^[A-Z0-9]+$/);
    }
  });

  it("is deterministic with a seeded rand (cycling through the charset)", () => {
    let n = 0;
    const cycling = (_min: number, max: number) => (n++) % max;
    const codes = generateCouponCodes(
      { quantity: 3, length: 4, charset: "alphabetic" },
      cycling,
    );
    // Alphabetic charset is A–Z minus O/I: indices 0..3 = ABCD, 4..7 = EFGH,
    // 8..11 = JKLM.
    expect(codes).toEqual(["ABCD", "EFGH", "JKLM"]);
  });

  it("uses only unambiguous characters (no 0/O/1/I)", () => {
    const codes = generateCouponCodes({ quantity: 50, length: 12, charset: "alphanumeric" });
    for (const code of codes) {
      expect(code).not.toMatch(/[0O1I]/);
    }
  });

  it("throws instead of looping forever when the code space is exhausted", () => {
    // Numeric charset of length 1 over an 8-char alphabet: 8 possible codes.
    expect(() =>
      generateCouponCodes({ quantity: 9, length: 1, charset: "numeric" }),
    ).toThrow(/exhausted/);
  });
});

// ─── Coupon checks ───────────────────────────────────────────────────────────

describe("checkCoupon", () => {
  const base = {
    active: true,
    startsAt: null,
    endsAt: null,
    usageCount: 0,
    maxUses: null,
    maxUsesPerCustomer: null,
  };

  it("passes a live, unlimited coupon", () => {
    expect(checkCoupon(base, NOW, 0)).toBe("ok");
  });

  it("classifies inactive / not-started / expired / exhausted / per-customer", () => {
    expect(checkCoupon({ ...base, active: false }, NOW, 0)).toBe("inactive");
    expect(
      checkCoupon({ ...base, startsAt: new Date("2026-12-01") }, NOW, 0),
    ).toBe("not_started");
    expect(checkCoupon({ ...base, endsAt: new Date("2026-11-01") }, NOW, 0)).toBe("expired");
    expect(checkCoupon({ ...base, usageCount: 5, maxUses: 5 }, NOW, 0)).toBe("exhausted");
    expect(checkCoupon({ ...base, maxUsesPerCustomer: 1 }, NOW, 1)).toBe("per_customer_cap");
    // Anonymous buyers (null count) skip the per-customer check.
    expect(checkCoupon({ ...base, maxUsesPerCustomer: 1 }, NOW, null)).toBe("ok");
  });
});

// ─── Coupon resolution (shared by checkout route + seller preview) ─────────

describe("couponCheckError", () => {
  it("returns null for ok and the right code/status otherwise", () => {
    expect(couponCheckError("ok")).toBeNull();
    expect(couponCheckError("expired")).toMatchObject({ code: "COUPON_INVALID", status: 400 });
    expect(couponCheckError("exhausted")).toMatchObject({ code: "COUPON_EXHAUSTED", status: 409 });
    expect(couponCheckError("per_customer_cap")).toMatchObject({
      code: "COUPON_ALREADY_USED",
      status: 409,
    });
  });
});

function makeLookupDb() {
  const voucherRule = rule({
    id: "rule_v",
    kind: "cart",
    mechanism: "voucher",
    trigger: "coupon",
    action: { type: "percent", percent: 10 },
  });
  const coupons: Record<string, any> = {
    SAVE10: {
      id: "cpn_1", orgId: "org_1", ruleId: "rule_v", code: "SAVE10",
      active: true, startsAt: null, endsAt: null,
      usageCount: 0, maxUses: 2, maxUsesPerCustomer: 1,
    },
  };
  const redemptionCounts: Record<string, number> = { "cpn_1:a@example.com": 1 };
  const db: CouponLookupDb = {
    coupon: {
      findFirst: async ({ where }) =>
        Object.values(coupons).find((c) => c.orgId === where.orgId && c.code === where.code) ?? null,
    },
    discountRule: {
      findUnique: async ({ where }) => (where.id === "rule_v" ? voucherRule : null),
    },
    couponRedemption: {
      count: async ({ where }) =>
        redemptionCounts[`${where.couponId}:${where.buyerEmail}`] ?? 0,
    },
  };
  return { db, coupons, voucherRule };
}

describe("resolveCoupon", () => {
  it("resolves a live code to its coupon + rule (normalizing case)", async () => {
    const { db } = makeLookupDb();
    const resolved = await resolveCoupon(db, {
      orgId: "org_1",
      code: "save10",
      buyerEmail: "new@example.com",
      now: NOW,
    });
    expect(resolved.coupon.code).toBe("SAVE10");
    expect(resolved.rule.id).toBe("rule_v");
  });

  it("throws COUPON_INVALID for an unknown code or a wrong-org code", async () => {
    const { db } = makeLookupDb();
    await expect(
      resolveCoupon(db, { orgId: "org_1", code: "NOPE", buyerEmail: null, now: NOW }),
    ).rejects.toMatchObject({ code: "COUPON_INVALID", status: 400 });
    await expect(
      resolveCoupon(db, { orgId: "org_2", code: "SAVE10", buyerEmail: null, now: NOW }),
    ).rejects.toMatchObject({ code: "COUPON_INVALID" });
  });

  it("throws COUPON_ALREADY_USED when this buyer already used the code", async () => {
    const { db } = makeLookupDb();
    await expect(
      resolveCoupon(db, { orgId: "org_1", code: "SAVE10", buyerEmail: "a@example.com", now: NOW }),
    ).rejects.toBeInstanceOf(CouponResolutionError);
    await expect(
      resolveCoupon(db, { orgId: "org_1", code: "SAVE10", buyerEmail: "a@example.com", now: NOW }),
    ).rejects.toMatchObject({ code: "COUPON_ALREADY_USED", status: 409 });
  });

  it("throws COUPON_EXHAUSTED when the coupon is used up", async () => {
    const { db, coupons } = makeLookupDb();
    coupons.SAVE10.usageCount = 2;
    await expect(
      resolveCoupon(db, { orgId: "org_1", code: "SAVE10", buyerEmail: "new@example.com", now: NOW }),
    ).rejects.toMatchObject({ code: "COUPON_EXHAUSTED", status: 409 });
  });
});

// ─── Atomic redemption ───────────────────────────────────────────────────────

interface StubCoupon {
  id: string;
  orgId: string;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  usageCount: number;
  maxUses: number | null;
  maxUsesPerCustomer: number | null;
}

/**
 * In-memory stand-in for Postgres: $executeRawUnsafe applies the guards in
 * the SQL's binding order ([couponId, orgId, now, buyerEmail]) and bumps
 * usageCount synchronously inside the call — the same serialization the
 * row lock gives the real UPDATE — so two concurrent redeems of the last
 * use behave the way the database would.
 */
function makeStubDb(coupons: StubCoupon[]) {
  const redemptions: Array<{ couponId: string; buyerEmail: string | null; purchaseId: string | null }> = [];
  const store = new Map(coupons.map((c) => [c.id, { ...c }]));

  const stub: CouponRedeemDb = {
    $executeRawUnsafe: async (text: string, ...values: unknown[]) => {
      if (text.includes(`"usageCount" = "usageCount" + 1`)) {
        const [couponId, orgId, now, buyerEmail] = values as [string, string, Date, string | null];
        const coupon = store.get(couponId);
        if (!coupon || coupon.orgId !== orgId) return 0;
        if (!coupon.active) return 0;
        if (coupon.startsAt && coupon.startsAt > now) return 0;
        if (coupon.endsAt && coupon.endsAt < now) return 0;
        if (coupon.maxUses !== null && coupon.usageCount >= coupon.maxUses) return 0;
        if (coupon.maxUsesPerCustomer !== null && buyerEmail !== null) {
          const prior = redemptions.filter(
            (r) => r.couponId === couponId && r.buyerEmail === buyerEmail,
          ).length;
          if (prior >= coupon.maxUsesPerCustomer) return 0;
        }
        coupon.usageCount += 1;
        return 1;
      }
      if (text.includes(`"usageCount" = GREATEST(0, "usageCount" - 1)`)) {
        const [couponId, orgId] = values as [string, string];
        const coupon = store.get(couponId);
        if (!coupon || coupon.orgId !== orgId || coupon.usageCount <= 0) return 0;
        coupon.usageCount -= 1;
        return 1;
      }
      throw new Error(`stub: unexpected SQL: ${text.slice(0, 60)}`);
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(stub as any),
  };
  (stub as any).couponRedemption = {
    create: async ({ data }: any) => {
      redemptions.push({ ...data });
      return data;
    },
    deleteMany: async ({ where }: any) => {
      const before = redemptions.length;
      for (let i = redemptions.length - 1; i >= 0; i--) {
        if (
          redemptions[i]!.couponId === where.couponId &&
          redemptions[i]!.purchaseId === where.purchaseId
        ) {
          redemptions.splice(i, 1);
        }
      }
      return { count: before - redemptions.length };
    },
  };
  return {
    db: stub,
    redemptions,
    usageCount: (id: string) => store.get(id)?.usageCount,
  };
}

describe("buildRedeemCouponSql", () => {
  it("enforces every guard in the WHERE clause — the database decides the race", () => {
    const { text, values } = buildRedeemCouponSql({
      couponId: "cpn_1",
      orgId: "org_1",
      buyerEmail: "buyer@example.com",
      purchaseId: "pur_1",
      now: NOW,
    });
    // The decision must be one conditional UPDATE, not read-check-write.
    expect(text).toMatch(/^UPDATE "Coupon"/);
    expect(text).toContain(`SET "usageCount" = "usageCount" + 1`);
    expect(text).toContain(`"active" = true`);
    expect(text).toContain(`("startsAt" IS NULL OR "startsAt" <= $3)`);
    expect(text).toContain(`("endsAt" IS NULL OR "endsAt" >= $3)`);
    expect(text).toContain(`("maxUses" IS NULL OR "usageCount" < "maxUses")`);
    expect(text).toContain(`"maxUsesPerCustomer" IS NULL`);
    expect(text).toContain(`SELECT COUNT(*) FROM "CouponRedemption"`);
    expect(text).toContain(`"CouponRedemption"."buyerEmail" = $4`);
    expect(values).toEqual(["cpn_1", "org_1", NOW, "buyer@example.com"]);
  });

  it("binds a null buyerEmail so anonymous buyers skip the per-customer cap", () => {
    const { values } = buildRedeemCouponSql({
      couponId: "cpn_1",
      orgId: "org_1",
      buyerEmail: null,
      purchaseId: null,
    });
    expect(values[3]).toBeNull();
  });
});

describe("redeemCouponAtomic", () => {
  it("claims a use and writes the redemption row", async () => {
    const { db, redemptions, usageCount } = makeStubDb([
      {
        id: "cpn_1", orgId: "org_1", active: true, startsAt: null, endsAt: null,
        usageCount: 0, maxUses: 2, maxUsesPerCustomer: null,
      },
    ]);
    const ok = await redeemCouponAtomic(db, {
      couponId: "cpn_1", orgId: "org_1", buyerEmail: "a@example.com", purchaseId: "pur_1", now: NOW,
    });
    expect(ok).toBe(true);
    expect(usageCount("cpn_1")).toBe(1);
    expect(redemptions).toEqual([
      { couponId: "cpn_1", orgId: "org_1", buyerEmail: "a@example.com", purchaseId: "pur_1" },
    ]);
  });

  it("refuses the last use twice — the second redeem fails the guard", async () => {
    const { db, usageCount } = makeStubDb([
      {
        id: "cpn_1", orgId: "org_1", active: true, startsAt: null, endsAt: null,
        usageCount: 0, maxUses: 1, maxUsesPerCustomer: null,
      },
    ]);
    const first = await redeemCouponAtomic(db, {
      couponId: "cpn_1", orgId: "org_1", buyerEmail: "a@example.com", purchaseId: "pur_1", now: NOW,
    });
    const second = await redeemCouponAtomic(db, {
      couponId: "cpn_1", orgId: "org_1", buyerEmail: "b@example.com", purchaseId: "pur_2", now: NOW,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(usageCount("cpn_1")).toBe(1);
  });

  it("lets only one of two SIMULTANEOUS redeems of the last use succeed", async () => {
    const { db, redemptions, usageCount } = makeStubDb([
      {
        id: "cpn_1", orgId: "org_1", active: true, startsAt: null, endsAt: null,
        usageCount: 0, maxUses: 1, maxUsesPerCustomer: null,
      },
    ]);
    const [a, b] = await Promise.all([
      redeemCouponAtomic(db, {
        couponId: "cpn_1", orgId: "org_1", buyerEmail: "a@example.com", purchaseId: "pur_1", now: NOW,
      }),
      redeemCouponAtomic(db, {
        couponId: "cpn_1", orgId: "org_1", buyerEmail: "b@example.com", purchaseId: "pur_2", now: NOW,
      }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(usageCount("cpn_1")).toBe(1);
    expect(redemptions).toHaveLength(1);
  });

  it("enforces the per-customer cap (applyOncePerCustomer = 1)", async () => {
    const { db } = makeStubDb([
      {
        id: "cpn_1", orgId: "org_1", active: true, startsAt: null, endsAt: null,
        usageCount: 0, maxUses: 100, maxUsesPerCustomer: 1,
      },
    ]);
    const input = { couponId: "cpn_1", orgId: "org_1", now: NOW };
    expect(
      await redeemCouponAtomic(db, { ...input, buyerEmail: "a@example.com", purchaseId: "pur_1" }),
    ).toBe(true);
    expect(
      await redeemCouponAtomic(db, { ...input, buyerEmail: "a@example.com", purchaseId: "pur_2" }),
    ).toBe(false);
    expect(
      await redeemCouponAtomic(db, { ...input, buyerEmail: "b@example.com", purchaseId: "pur_3" }),
    ).toBe(true);
  });

  it("refuses expired, inactive, and wrong-org coupons", async () => {
    const { db } = makeStubDb([
      { id: "cpn_exp", orgId: "org_1", active: true, startsAt: null, endsAt: new Date("2026-11-01"), usageCount: 0, maxUses: null, maxUsesPerCustomer: null },
      { id: "cpn_off", orgId: "org_1", active: false, startsAt: null, endsAt: null, usageCount: 0, maxUses: null, maxUsesPerCustomer: null },
    ]);
    for (const couponId of ["cpn_exp", "cpn_off", "cpn_missing"]) {
      expect(
        await redeemCouponAtomic(db, {
          couponId, orgId: "org_1", buyerEmail: null, purchaseId: "pur_1", now: NOW,
        }),
      ).toBe(false);
    }
    // Right code, wrong org: must not redeem another seller's coupon.
    expect(
      await redeemCouponAtomic(db, {
        couponId: "cpn_off", orgId: "org_2", buyerEmail: null, purchaseId: "pur_1", now: NOW,
      }),
    ).toBe(false);
  });
});

describe("releaseCouponRedemption", () => {
  it("gives the use back and removes the redemption row", async () => {
    const { db, redemptions, usageCount } = makeStubDb([
      {
        id: "cpn_1", orgId: "org_1", active: true, startsAt: null, endsAt: null,
        usageCount: 0, maxUses: 1, maxUsesPerCustomer: null,
      },
    ]);
    await redeemCouponAtomic(db, {
      couponId: "cpn_1", orgId: "org_1", buyerEmail: "a@example.com", purchaseId: "pur_1", now: NOW,
    });
    expect(usageCount("cpn_1")).toBe(1);
    await releaseCouponRedemption(db, { couponId: "cpn_1", orgId: "org_1", purchaseId: "pur_1" });
    expect(usageCount("cpn_1")).toBe(0);
    expect(redemptions).toHaveLength(0);
    // The freed use can be redeemed again.
    expect(
      await redeemCouponAtomic(db, {
        couponId: "cpn_1", orgId: "org_1", buyerEmail: "b@example.com", purchaseId: "pur_2", now: NOW,
      }),
    ).toBe(true);
  });
});

describe("STRIPE_MINIMUM_CHARGE_CENTS", () => {
  it("is 50¢", () => {
    expect(STRIPE_MINIMUM_CHARGE_CENTS).toBe(50);
  });
});
