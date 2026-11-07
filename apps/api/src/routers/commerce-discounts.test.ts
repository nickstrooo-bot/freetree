import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory, type TrpcContext } from "@kytelink/trpc";
import { getClickhouse } from "@kytelink/clickhouse";
import { loadConfig, setConfigForTest } from "../config";
import { logger } from "../logger";
import { createSeededStore, type MemoryStore } from "../store/memory-store";
import { computeFeeCents } from "../commerce/stripe";
import { appRouter } from "./index";

// ─── Commerce discount router test ───────────────────────────────────────────
// Same pattern as the forms router test: the generated Prisma client cannot
// be built locally (engine download is proxy-blocked), so the real
// @kytelink/db module cannot even be imported here. This test mocks it with
// a small in-memory stand-in and exercises the discount procedures end to
// end: access control via the seeded MemoryStore, rule CRUD, coupon
// create/generate/toggle, and previewTotals through the same engine the
// checkout route uses — so the seller preview and the charge cannot drift.

const { fakeDb } = vi.hoisted(() => {
  const rules: any[] = [];
  const coupons: any[] = [];
  const redemptions: any[] = [];
  const products: any[] = [];

  function matches(row: any, where: any): boolean {
    if (!where) return true;
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (row[key] !== value) return false;
    }
    return true;
  }

  const fakeDb = {
    rules,
    coupons,
    redemptions,
    products,
    discountRule: {
      findMany: async ({ where }: any) => rules.filter((r) => matches(r, where)),
      findFirst: async ({ where }: any) => rules.find((r) => matches(r, where)) ?? null,
      findUnique: async ({ where }: any) => rules.find((r) => matches(r, where)) ?? null,
      create: async ({ data }: any) => {
        const row = {
          ...data,
          id: `rule_${rules.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rules.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rules.find((r) => r.id === where.id);
        if (!row) throw new Error("rule not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      delete: async ({ where }: any) => {
        const i = rules.findIndex((r) => r.id === where.id);
        if (i < 0) throw new Error("rule not found");
        const [row] = rules.splice(i, 1);
        for (let j = coupons.length - 1; j >= 0; j--) {
          if (coupons[j]!.ruleId === row!.id) coupons.splice(j, 1);
        }
        return row;
      },
      count: async ({ where }: any) => rules.filter((r) => matches(r, where)).length,
    },
    coupon: {
      findMany: async ({ where, take }: any) => {
        const rows = coupons.filter((c) => matches(c, where));
        return take !== undefined ? rows.slice(0, take) : rows;
      },
      findFirst: async ({ where }: any) => coupons.find((c) => matches(c, where)) ?? null,
      count: async ({ where }: any) => coupons.filter((c) => matches(c, where)).length,
      create: async ({ data }: any) => {
        if (coupons.some((c) => c.orgId === data.orgId && c.code === data.code)) {
          const error: any = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const row = { ...data, id: `cpn_${coupons.length + 1}`, usageCount: 0, createdAt: new Date(), updatedAt: new Date() };
        coupons.push(row);
        return row;
      },
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const item of data) {
          if (
            skipDuplicates &&
            coupons.some((c) => c.orgId === item.orgId && c.code === item.code)
          ) {
            continue;
          }
          coupons.push({
            ...item,
            id: `cpn_${coupons.length + 1}`,
            usageCount: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          count++;
        }
        return { count };
      },
      update: async ({ where, data }: any) => {
        const row = coupons.find((c) => c.id === where.id);
        if (!row) throw new Error("coupon not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    couponRedemption: {
      count: async ({ where }: any) => redemptions.filter((r) => matches(r, where)).length,
    },
    product: {
      findFirst: async ({ where }: any) => products.find((p) => matches(p, where)) ?? null,
    },
    purchase: {
      findMany: async () => [],
      aggregate: async () => ({ _sum: { amountCents: 0, feeCents: 0 }, _count: { _all: 0 } }),
    },
  };
  return { fakeDb };
});

vi.mock("@kytelink/db", () => ({
  getDb: () => fakeDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

const createCaller = createCallerFactory(appRouter);
const KYTE_ID = "kyte_agent_draft";
const ORG_ID = "org_agent_personal";

async function contextFor(store: MemoryStore, email: string): Promise<TrpcContext> {
  const user = await store.userByEmail(email);
  if (!user) throw new Error(`no fixture user ${email}`);
  return {
    session: {
      userId: user.id,
      email: user.email,
      isAdmin: user.role === "ADMIN",
      status: user.status,
    },
    user: { id: user.id, email: user.email },
    ip: "127.0.0.1",
    redis: null,
    db: store,
    ch: getClickhouse(),
    log: logger,
  };
}

let store: MemoryStore;

beforeEach(() => {
  store = createSeededStore();
  fakeDb.rules.length = 0;
  fakeDb.coupons.length = 0;
  fakeDb.redemptions.length = 0;
  fakeDb.products.length = 0;
  fakeDb.products.push(
    {
      id: "prod_1", kyteId: KYTE_ID, orgId: ORG_ID, name: "Ebook", description: null,
      priceCents: 2000, currency: "usd", kind: "digital", active: true,
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      id: "prod_gift", kyteId: KYTE_ID, orgId: ORG_ID, name: "Sticker", description: null,
      priceCents: 500, currency: "usd", kind: "digital", active: true,
      createdAt: new Date(), updatedAt: new Date(),
    },
  );
  setConfigForTest(
    loadConfig({ ...process.env, ADMIN_EMAILS: "agent-admin@kytelink.dev", WEB_BASE_URL: "http://localhost:3000" }),
  );
});

async function ownerCaller() {
  return createCaller(await contextFor(store, "agent@kytelink.dev"));
}

async function createRule(caller: any, rule: any) {
  return caller.commerce.createDiscountRule({ kyteId: KYTE_ID, rule });
}

describe("commerce.listDiscountRules / createDiscountRule", () => {
  it("starts empty, then lists a created rule with its Saleor mechanism", async () => {
    const caller = await ownerCaller();
    await expect(caller.commerce.listDiscountRules({ kyteId: KYTE_ID })).resolves.toEqual({
      rules: [],
    });

    const created = await createRule(caller, {
      name: "Summer 20%",
      action: { type: "percent", percent: 20 },
    });
    expect(created.mechanism).toBe("order");
    expect(created.kind).toBe("cart");
    expect(created.trigger).toBe("automatic");
    expect(created.couponCount).toBe(0);

    const listed = await caller.commerce.listDiscountRules({ kyteId: KYTE_ID });
    expect(listed.rules).toHaveLength(1);
    expect(listed.rules[0]!.name).toBe("Summer 20%");
  });

  it("derives catalogue for catalog rules and voucher for coupon rules", async () => {
    const caller = await ownerCaller();
    const catalog = await createRule(caller, {
      name: "Clearance",
      kind: "catalog",
      action: { type: "percent", percent: 25 },
    });
    expect(catalog.mechanism).toBe("catalogue");

    const voucher = await createRule(caller, {
      name: "Welcome code",
      trigger: "coupon",
      action: { type: "percent", percent: 10 },
    });
    expect(voucher.mechanism).toBe("voucher");
  });

  it("rejects checkout-only actions on catalog rules", async () => {
    const caller = await ownerCaller();
    await expect(
      createRule(caller, {
        name: "Bad catalog",
        kind: "catalog",
        action: { type: "buy_x_get_y", buyQty: 2, getQty: 1 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a gift rule whose gift product does not exist", async () => {
    const caller = await ownerCaller();
    await expect(
      createRule(caller, {
        name: "Gift with purchase",
        action: { type: "gift", giftProductId: "prod_missing" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts a gift rule pointing at the seller's own product", async () => {
    const caller = await ownerCaller();
    const created = await createRule(caller, {
      name: "Free sticker",
      conditions: { minSubtotalCents: 1000 },
      action: { type: "gift", giftProductId: "prod_gift" },
    });
    expect(created.action).toEqual({ type: "gift", giftProductId: "prod_gift" });
  });
});

describe("commerce.updateDiscountRule / deleteDiscountRule", () => {
  it("updates the percent and active flag, and recomputes the mechanism on kind change", async () => {
    const caller = await ownerCaller();
    const created = await createRule(caller, {
      name: "Sale",
      action: { type: "percent", percent: 10 },
    });
    const updated = await caller.commerce.updateDiscountRule({
      kyteId: KYTE_ID,
      ruleId: created.id,
      patch: { action: { type: "percent", percent: 30 }, active: false },
    });
    expect(updated.action.percent).toBe(30);
    expect(updated.active).toBe(false);

    const asCatalog = await caller.commerce.updateDiscountRule({
      kyteId: KYTE_ID,
      ruleId: created.id,
      patch: { kind: "catalog", active: true },
    });
    expect(asCatalog.mechanism).toBe("catalogue");
  });

  it("rejects an update that would make a catalog rule carry a gift action", async () => {
    const caller = await ownerCaller();
    const created = await createRule(caller, {
      name: "Sale",
      action: { type: "percent", percent: 10 },
    });
    await expect(
      caller.commerce.updateDiscountRule({
        kyteId: KYTE_ID,
        ruleId: created.id,
        patch: { kind: "catalog", action: { type: "gift", giftProductId: "prod_gift" } },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("deletes the rule and its coupons", async () => {
    const caller = await ownerCaller();
    const created = await createRule(caller, {
      name: "Welcome code",
      trigger: "coupon",
      action: { type: "percent", percent: 10 },
    });
    await caller.commerce.createCoupon({
      kyteId: KYTE_ID,
      ruleId: created.id,
      coupon: { code: "WELCOME10" },
    });
    await expect(
      caller.commerce.deleteDiscountRule({ kyteId: KYTE_ID, ruleId: created.id }),
    ).resolves.toEqual({ ok: true });
    await expect(caller.commerce.listDiscountRules({ kyteId: KYTE_ID })).resolves.toEqual({
      rules: [],
    });
    await expect(
      caller.commerce.listCoupons({ kyteId: KYTE_ID }),
    ).resolves.toEqual({ coupons: [] });
  });
});

describe("commerce.createCoupon / generateCoupons / listCoupons / setCouponActive", () => {
  async function voucherRule(caller: any) {
    return createRule(caller, {
      name: "Welcome code",
      trigger: "coupon",
      action: { type: "percent", percent: 10 },
    });
  }

  it("normalizes a hand-typed code and rejects a duplicate (P2002 -> CONFLICT)", async () => {
    const caller = await ownerCaller();
    const rule = await voucherRule(caller);
    const created = await caller.commerce.createCoupon({
      kyteId: KYTE_ID,
      ruleId: rule.id,
      coupon: { code: "welcome10", maxUses: 5, maxUsesPerCustomer: 1 },
    });
    expect(created.code).toBe("WELCOME10");
    expect(created.maxUses).toBe(5);
    expect(created.maxUsesPerCustomer).toBe(1);
    expect(created.generated).toBe(false);

    await expect(
      caller.commerce.createCoupon({
        kyteId: KYTE_ID,
        ruleId: rule.id,
        coupon: { code: "WELCOME10" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses to attach a coupon to an automatic rule", async () => {
    const caller = await ownerCaller();
    const auto = await createRule(caller, {
      name: "Auto sale",
      action: { type: "percent", percent: 10 },
    });
    await expect(
      caller.commerce.createCoupon({
        kyteId: KYTE_ID,
        ruleId: auto.id,
        coupon: { code: "SAVE10" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("bulk-generates unique codes with prefix/suffix and reports collisions", async () => {
    const caller = await ownerCaller();
    const rule = await voucherRule(caller);
    const batch = await caller.commerce.generateCoupons({
      kyteId: KYTE_ID,
      ruleId: rule.id,
      options: { quantity: 5, length: 6, prefix: "SUMMER", suffix: "25", charset: "alphanumeric" },
    });
    expect(batch.requested).toBe(5);
    expect(batch.created).toBe(5);
    expect(batch.collisions).toBe(0);
    expect(new Set(batch.codes).size).toBe(5);
    for (const code of batch.codes) {
      expect(code.startsWith("SUMMER")).toBe(true);
      expect(code.endsWith("25")).toBe(true);
    }
    const listed = await caller.commerce.listCoupons({ kyteId: KYTE_ID, ruleId: rule.id });
    expect(listed.coupons).toHaveLength(5);
    expect(listed.coupons[0]!.ruleName).toBe("Welcome code");
    expect(listed.coupons.every((c: any) => c.generated)).toBe(true);
  });

  it("toggles a coupon off and on", async () => {
    const caller = await ownerCaller();
    const rule = await voucherRule(caller);
    const created = await caller.commerce.createCoupon({
      kyteId: KYTE_ID,
      ruleId: rule.id,
      coupon: { code: "SAVE10" },
    });
    const off = await caller.commerce.setCouponActive({
      kyteId: KYTE_ID,
      couponId: created.id,
      active: false,
    });
    expect(off.active).toBe(false);
    const on = await caller.commerce.setCouponActive({
      kyteId: KYTE_ID,
      couponId: created.id,
      active: true,
    });
    expect(on.active).toBe(true);
  });
});

describe("commerce.previewTotals", () => {
  it("previews the discounted total and the fee on the DISCOUNTED total", async () => {
    const caller = await ownerCaller();
    await createRule(caller, {
      name: "Summer 20%",
      action: { type: "percent", percent: 20 },
    });
    const preview = await caller.commerce.previewTotals({ kyteId: KYTE_ID, productId: "prod_1" });
    expect(preview.listPriceCents).toBe(2000);
    expect(preview.salePriceCents).toBe(2000);
    expect(preview.subtotalCents).toBe(2000);
    expect(preview.discountCents).toBe(400);
    expect(preview.totalCents).toBe(1600);
    // The seller preview must agree with the charge: same fee input.
    expect(preview.feeCents).toBe(computeFeeCents(1600));
    expect(preview.applied).toHaveLength(1);
  });

  it("applies a catalog rule to the sale price first, then cart rules on top", async () => {
    const caller = await ownerCaller();
    await createRule(caller, {
      name: "Clearance",
      kind: "catalog",
      action: { type: "percent", percent: 25 },
    });
    await createRule(caller, {
      name: "Extra 10%",
      action: { type: "percent", percent: 10 },
    });
    const preview = await caller.commerce.previewTotals({ kyteId: KYTE_ID, productId: "prod_1" });
    expect(preview.salePriceCents).toBe(1500);
    expect(preview.discountCents).toBe(150);
    expect(preview.totalCents).toBe(1350);
    expect(preview.feeCents).toBe(computeFeeCents(1350));
  });

  it("applies an entered coupon code in the preview, and rejects an unknown one", async () => {
    const caller = await ownerCaller();
    const rule = await createRule(caller, {
      name: "Welcome code",
      trigger: "coupon",
      action: { type: "percent", percent: 10 },
    });
    await caller.commerce.createCoupon({
      kyteId: KYTE_ID,
      ruleId: rule.id,
      coupon: { code: "WELCOME10" },
    });
    const preview = await caller.commerce.previewTotals({
      kyteId: KYTE_ID,
      productId: "prod_1",
      couponCode: "welcome10",
    });
    expect(preview.couponApplied).toBe(true);
    expect(preview.discountCents).toBe(200);
    expect(preview.totalCents).toBe(1800);

    await expect(
      caller.commerce.previewTotals({ kyteId: KYTE_ID, productId: "prod_1", couponCode: "NOPE" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
