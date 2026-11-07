import { describe, expect, it } from "vitest";
import {
  couponCodeSchema,
  createCouponInputSchema,
  discountActionSchema,
  discountRuleInputSchema,
  discountRuleSchema,
  generateCouponsInputSchema,
  mechanismForRule,
  normalizeCouponCode,
} from "./discounts";

describe("normalizeCouponCode", () => {
  it("trims and uppercases", () => {
    expect(normalizeCouponCode("  welcome10 ")).toBe("WELCOME10");
    expect(normalizeCouponCode("Summer-Sale_25")).toBe("SUMMER-SALE_25");
  });
});

describe("couponCodeSchema", () => {
  it("accepts and normalizes a plain code", () => {
    expect(couponCodeSchema.parse("save20")).toBe("SAVE20");
  });

  it("rejects codes shorter than 4 or longer than 30", () => {
    expect(couponCodeSchema.safeParse("ABC").success).toBe(false);
    expect(couponCodeSchema.safeParse("A".repeat(31)).success).toBe(false);
  });

  it("rejects spaces and symbols inside the code", () => {
    expect(couponCodeSchema.safeParse("SAVE 20").success).toBe(false);
    expect(couponCodeSchema.safeParse("SAVE!").success).toBe(false);
  });
});

describe("discountActionSchema", () => {
  it("requires percent for a percent action", () => {
    expect(discountActionSchema.safeParse({ type: "percent" }).success).toBe(false);
    expect(discountActionSchema.safeParse({ type: "percent", percent: 25 }).success).toBe(true);
  });

  it("rejects percent outside 1–100", () => {
    expect(discountActionSchema.safeParse({ type: "percent", percent: 0 }).success).toBe(false);
    expect(discountActionSchema.safeParse({ type: "percent", percent: 101 }).success).toBe(false);
  });

  it("requires buyQty/getQty for Buy-X-Get-Y and a gift product for gift", () => {
    expect(discountActionSchema.safeParse({ type: "buy_x_get_y", buyQty: 2 }).success).toBe(false);
    expect(
      discountActionSchema.safeParse({ type: "buy_x_get_y", buyQty: 2, getQty: 1 }).success,
    ).toBe(true);
    expect(discountActionSchema.safeParse({ type: "gift" }).success).toBe(false);
    expect(
      discountActionSchema.safeParse({ type: "gift", giftProductId: "prod_1" }).success,
    ).toBe(true);
  });

  it("accepts free_shipping with no extra fields", () => {
    expect(discountActionSchema.safeParse({ type: "free_shipping" }).success).toBe(true);
  });
});

describe("mechanismForRule", () => {
  it("maps kind + trigger to Saleor's three mechanisms", () => {
    expect(mechanismForRule("catalog", "automatic")).toBe("catalogue");
    expect(mechanismForRule("cart", "automatic")).toBe("order");
    expect(mechanismForRule("cart", "coupon")).toBe("voucher");
  });
});

describe("discountRuleInputSchema", () => {
  const base = { name: "Summer sale", action: { type: "percent", percent: 20 } } as const;

  it("defaults kind cart, trigger automatic, target entire_order", () => {
    const parsed = discountRuleInputSchema.parse(base);
    expect(parsed.kind).toBe("cart");
    expect(parsed.trigger).toBe("automatic");
    expect(parsed.target).toBe("entire_order");
    expect(parsed.active).toBe(true);
    expect(parsed.priority).toBe(0);
  });

  it("rejects whole-cart / gift / free-shipping actions on catalog rules", () => {
    for (const action of [
      { type: "fixed_whole_cart", amountCents: 500 },
      { type: "buy_x_get_y", buyQty: 2, getQty: 1 },
      { type: "free_shipping" },
      { type: "gift", giftProductId: "prod_1" },
    ]) {
      expect(
        discountRuleInputSchema.safeParse({ ...base, kind: "catalog", action }).success,
      ).toBe(false);
    }
    expect(
      discountRuleInputSchema.safeParse({
        ...base,
        kind: "catalog",
        action: { type: "fixed_per_item", amountCents: 100 },
      }).success,
    ).toBe(true);
  });

  it("rejects an end date before the start date", () => {
    expect(
      discountRuleInputSchema.safeParse({
        ...base,
        startsAt: new Date("2026-12-10"),
        endsAt: new Date("2026-12-01"),
      }).success,
    ).toBe(false);
  });
});

describe("discountRuleSchema", () => {
  const row = {
    id: "rule_1",
    kyteId: "kyte_1",
    orgId: "org_1",
    name: "Welcome code",
    kind: "cart",
    mechanism: "voucher",
    trigger: "coupon",
    active: true,
    priority: 0,
    stopOtherRules: false,
    startsAt: null,
    endsAt: null,
    target: "entire_order",
    conditions: {},
    action: { type: "percent", percent: 10 },
  };

  it("accepts a consistent voucher row", () => {
    expect(discountRuleSchema.safeParse(row).success).toBe(true);
  });

  it("rejects a mechanism that disagrees with kind + trigger", () => {
    expect(discountRuleSchema.safeParse({ ...row, mechanism: "order" }).success).toBe(false);
    expect(
      discountRuleSchema.safeParse({ ...row, kind: "catalog", mechanism: "catalogue" }).success,
    ).toBe(true);
  });
});

describe("createCouponInputSchema", () => {
  it("normalizes the code and defaults active", () => {
    const parsed = createCouponInputSchema.parse({ code: "welcome10" });
    expect(parsed.code).toBe("WELCOME10");
    expect(parsed.active).toBe(true);
  });
});

describe("generateCouponsInputSchema", () => {
  it("accepts a normal bulk request", () => {
    expect(
      generateCouponsInputSchema.safeParse({ quantity: 10, length: 8 }).success,
    ).toBe(true);
  });

  it("rejects quantity outside 1–100 and length outside 4–30", () => {
    expect(generateCouponsInputSchema.safeParse({ quantity: 0, length: 8 }).success).toBe(false);
    expect(generateCouponsInputSchema.safeParse({ quantity: 101, length: 8 }).success).toBe(false);
    expect(generateCouponsInputSchema.safeParse({ quantity: 5, length: 3 }).success).toBe(false);
    expect(generateCouponsInputSchema.safeParse({ quantity: 5, length: 31 }).success).toBe(false);
  });

  it("rejects prefix + code + suffix over 30 characters total", () => {
    expect(
      generateCouponsInputSchema.safeParse({
        quantity: 5,
        length: 20,
        prefix: "SUMMER2026",
        suffix: "VIP",
      }).success,
    ).toBe(false);
  });
});
