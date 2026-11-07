import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, setConfigForTest } from "../config";
import { computeFeeCents } from "../commerce/stripe";
import { registerCommerceRoutes } from "./commerce";

import type * as StripeModule from "../commerce/stripe";

// ─── Commerce checkout route test (discount engine) ──────────────────────────
// Exercises the Fastify checkout + product listing through the real route
// handlers with a mocked db and a mocked Stripe client: catalog sale
// pricing at read time, collectTotals as the choke-point, the fee computed
// on the DISCOUNTED total at both sites (Purchase row + Stripe session),
// Stripe promo-code mutual exclusion, the atomic coupon redeem (including
// the two-buyers-one-use race), and the release path when Stripe fails.
//
// The generated Prisma client cannot be built locally (engine download is
// proxy-blocked), so @kytelink/db is mocked with an in-memory stand-in
// whose $executeRawUnsafe simulates the conditional UPDATE's guards in the
// same binding order the engine emits them.

const sessionsCreate = vi.hoisted(() => vi.fn());

const { fakeDb } = vi.hoisted(() => {
  const rules: any[] = [];
  const coupons: any[] = [];
  const redemptions: any[] = [];
  const purchases: any[] = [];
  const products: any[] = [];

  function matches(row: any, where: any): boolean {
    if (!where) return true;
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (row[key] !== value) return false;
    }
    return true;
  }

  const couponById = (id: string) => coupons.find((c) => c.id === id);

  const fakeDb: any = {
    rules,
    coupons,
    redemptions,
    purchases,
    products,
    kyte: {
      findFirst: async ({ where }: any) => {
        if (where.username === "seller") {
          return { id: "kyte_1", orgId: "org_1", username: "seller" };
        }
        return null;
      },
    },
    product: {
      findMany: async ({ where }: any) => products.filter((p) => matches(p, where)),
      findFirst: async ({ where, include }: any) => {
        const row = products.find((p) => matches(p, where)) ?? null;
        if (!row) return null;
        // Prisma's include: { kyte: ... } joins the kyte; the route reads
        // product.kyte.orgId, so the fake must attach it too.
        if (include?.kyte) {
          return { ...row, kyte: { id: "kyte_1", orgId: "org_1", username: "seller" } };
        }
        return row;
      },
    },
    discountRule: {
      findMany: async ({ where }: any) => rules.filter((r) => matches(r, where)),
      findUnique: async ({ where }: any) => rules.find((r) => matches(r, where)) ?? null,
    },
    coupon: {
      findFirst: async ({ where }: any) => coupons.find((c) => matches(c, where)) ?? null,
      findUnique: async ({ where }: any) => coupons.find((c) => matches(c, where)) ?? null,
    },
    couponRedemption: {
      count: async ({ where }: any) => redemptions.filter((r) => matches(r, where)).length,
      create: async ({ data }: any) => {
        const row = { ...data, id: `red_${redemptions.length + 1}`, redeemedAt: new Date() };
        redemptions.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (let i = redemptions.length - 1; i >= 0; i--) {
          if (matches(redemptions[i], where)) {
            redemptions.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    },
    stripeConnectAccount: {
      findUnique: async ({ where }: any) =>
        where.orgId === "org_1"
          ? { orgId: "org_1", stripeAccountId: "acct_1", chargesEnabled: true }
          : null,
    },
    purchase: {
      create: async ({ data }: any) => {
        const row = { ...data, id: `pur_${purchases.length + 1}`, createdAt: new Date() };
        purchases.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        if (!row) throw new Error("purchase not found");
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: any) => {
        const i = purchases.findIndex((p) => p.id === where.id);
        if (i >= 0) purchases.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      },
    },
    // Simulates the atomic conditional UPDATE: guards checked and the bump
    // applied synchronously inside the call — the same serialization the
    // Postgres row lock gives the real statement.
    $executeRawUnsafe: async (text: string, ...values: unknown[]) => {
      if (text.includes(`"usageCount" = "usageCount" + 1`)) {
        const [couponId, orgId, now, buyerEmail] = values as [string, string, Date, string | null];
        const coupon = couponById(couponId);
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
        const coupon = couponById(couponId);
        if (!coupon || coupon.orgId !== orgId || coupon.usageCount <= 0) return 0;
        coupon.usageCount -= 1;
        return 1;
      }
      throw new Error(`stub: unexpected SQL: ${text.slice(0, 60)}`);
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(fakeDb),
  };
  return { fakeDb };
});

vi.mock("@kytelink/db", () => ({
  getDb: () => fakeDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

vi.mock("../redis", () => ({ getRedis: () => null }));

vi.mock("../commerce/stripe", async (importActual) => ({
  ...(await importActual<typeof StripeModule>()),
  getStripeClient: () => ({
    checkout: { sessions: { create: sessionsCreate } },
  }),
  isStripeConfigured: () => true,
}));

let app: FastifyInstance;

async function buildTestApp() {
  const instance = Fastify();
  registerCommerceRoutes(instance);
  await instance.ready();
  return instance;
}

function seedProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod_1",
    kyteId: "kyte_1",
    orgId: "org_1",
    name: "Ebook",
    description: "A very good ebook.",
    priceCents: 2000,
    currency: "usd",
    kind: "digital",
    active: true,
    allowPromoCodes: true,
    fileKey: null,
    fileName: null,
    externalUrl: "https://example.com/ebook.pdf",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function seedRule(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `rule_${fakeDb.rules.length + 1}`,
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
    action: { type: "percent", percent: 20 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  fakeDb.rules.push(row);
  return row;
}

function seedCoupon(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `cpn_${fakeDb.coupons.length + 1}`,
    kyteId: "kyte_1",
    orgId: "org_1",
    ruleId: "rule_v",
    code: "SAVE10",
    usageCount: 0,
    maxUses: null,
    maxUsesPerCustomer: null,
    startsAt: null,
    endsAt: null,
    active: true,
    generated: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  fakeDb.coupons.push(row);
  return row;
}

beforeEach(async () => {
  setConfigForTest(
    loadConfig({ ...process.env, WEB_BASE_URL: "http://localhost:3000", API_BASE_URL: "http://localhost:3001" }),
  );
  fakeDb.rules.length = 0;
  fakeDb.coupons.length = 0;
  fakeDb.redemptions.length = 0;
  fakeDb.purchases.length = 0;
  fakeDb.products.length = 0;
  fakeDb.products.push(
    seedProduct(),
    seedProduct({ id: "prod_gift", name: "Sticker", priceCents: 500 }),
  );
  sessionsCreate.mockReset();
  sessionsCreate.mockImplementation(async () => ({
    id: "cs_test_123",
    url: "https://checkout.stripe.test/pay/cs_test_123",
  }));
  app = await buildTestApp();
});

async function checkout(body: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/commerce/checkout",
    payload: body,
  });
  return { status: response.statusCode, body: response.json() as any };
}

describe("GET /commerce/products/:username", () => {
  it("shows the list price and the catalog sale price", async () => {
    seedRule({
      kind: "catalog",
      mechanism: "catalogue",
      action: { type: "percent", percent: 25 },
    });
    const response = await app.inject({ method: "GET", url: "/commerce/products/seller" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ebook = body.products.find((p: any) => p.id === "prod_1");
    expect(ebook.priceCents).toBe(2000);
    expect(ebook.salePriceCents).toBe(1500);
    expect(ebook.onSale).toBe(true);
  });

  it("shows no sale when no catalog rule applies", async () => {
    const response = await app.inject({ method: "GET", url: "/commerce/products/seller" });
    const ebook = response.json().products.find((p: any) => p.id === "prod_1");
    expect(ebook.salePriceCents).toBe(2000);
    expect(ebook.onSale).toBe(false);
  });
});

describe("POST /commerce/checkout", () => {
  it("charges the list price with no rules, fee on the full amount, Stripe coupons allowed", async () => {
    const { status, body } = await checkout({ productId: "prod_1" });
    expect(status).toBe(200);
    expect(body.totalCents).toBe(2000);
    expect(body.discountCents).toBe(0);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const params = sessionsCreate.mock.calls[0]![0];
    expect(params.line_items[0].price_data.unit_amount).toBe(2000);
    expect(params.payment_intent_data.application_fee_amount).toBe(computeFeeCents(2000));
    expect(params.allow_promotion_codes).toBe(true);
    // Seller preview (Purchase row) agrees with the charge.
    expect(fakeDb.purchases).toHaveLength(1);
    expect(fakeDb.purchases[0]).toMatchObject({
      amountCents: 2000,
      feeCents: computeFeeCents(2000),
      discountCents: 0,
      status: "pending",
    });
  });

  it("charges the DISCOUNTED total and the fee on the DISCOUNTED total, and disables Stripe coupons", async () => {
    seedRule({ action: { type: "percent", percent: 20 } });
    const { status, body } = await checkout({ productId: "prod_1" });
    expect(status).toBe(200);
    expect(body.totalCents).toBe(1600);
    expect(body.discountCents).toBe(400);
    const params = sessionsCreate.mock.calls[0]![0];
    expect(params.line_items[0].price_data.unit_amount).toBe(1600);
    expect(params.payment_intent_data.application_fee_amount).toBe(computeFeeCents(1600));
    // A FreeTree discount means no Stripe promo-code field: no double-dipping.
    expect(params.allow_promotion_codes).toBe(false);
    expect(fakeDb.purchases[0]).toMatchObject({
      amountCents: 1600,
      feeCents: computeFeeCents(1600),
      discountCents: 400,
    });
    expect(fakeDb.purchases[0].discountBreakdown.applied).toHaveLength(1);
  });

  it("redeems a coupon atomically and records it on the purchase", async () => {
    seedRule({
      id: "rule_v",
      mechanism: "voucher",
      trigger: "coupon",
      action: { type: "percent", percent: 10 },
    });
    seedCoupon({ ruleId: "rule_v", maxUses: 2, maxUsesPerCustomer: 1 });
    const { status, body } = await checkout({
      productId: "prod_1",
      couponCode: "save10",
      buyerEmail: "buyer@example.com",
    });
    expect(status).toBe(200);
    expect(body.totalCents).toBe(1800);
    expect(body.discountCents).toBe(200);
    const coupon = fakeDb.coupons[0];
    expect(coupon.usageCount).toBe(1);
    expect(fakeDb.redemptions).toHaveLength(1);
    expect(fakeDb.redemptions[0]).toMatchObject({
      couponId: coupon.id,
      buyerEmail: "buyer@example.com",
    });
    expect(fakeDb.purchases[0]).toMatchObject({ couponCode: "SAVE10", discountCents: 200 });
    const params = sessionsCreate.mock.calls[0]![0];
    expect(params.metadata.freetree_coupon_code).toBe("SAVE10");
    expect(params.metadata.freetree_discount_cents).toBe("200");
  });

  it("rejects an unknown code and an exhausted code without creating an order", async () => {
    const unknown = await checkout({ productId: "prod_1", couponCode: "NOPE" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("COUPON_INVALID");
    expect(fakeDb.purchases).toHaveLength(0);
    expect(sessionsCreate).not.toHaveBeenCalled();

    seedRule({
      id: "rule_v",
      mechanism: "voucher",
      trigger: "coupon",
      action: { type: "percent", percent: 10 },
    });
    seedCoupon({ ruleId: "rule_v", usageCount: 1, maxUses: 1 });
    const exhausted = await checkout({ productId: "prod_1", couponCode: "SAVE10" });
    expect(exhausted.status).toBe(409);
    expect(exhausted.body.error).toBe("COUPON_EXHAUSTED");
    expect(fakeDb.purchases).toHaveLength(0);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("refuses a 100%-off order: Stripe cannot charge below its minimum", async () => {
    seedRule({ action: { type: "percent", percent: 100 } });
    const { status, body } = await checkout({ productId: "prod_1" });
    expect(status).toBe(400);
    expect(body.error).toBe("TOTAL_BELOW_MINIMUM");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("adds a zero-priced gift line to the Stripe session for a GIFT rule", async () => {
    seedRule({
      conditions: { minSubtotalCents: 1000 },
      action: { type: "gift", giftProductId: "prod_gift" },
    });
    const { status } = await checkout({ productId: "prod_1" });
    expect(status).toBe(200);
    const params = sessionsCreate.mock.calls[0]![0];
    expect(params.line_items).toHaveLength(2);
    expect(params.line_items[1]).toMatchObject({
      price_data: { unit_amount: 0 },
      quantity: 1,
    });
    expect(params.line_items[1].price_data.product_data.name).toBe("Sticker");
    expect(params.allow_promotion_codes).toBe(false);
    expect(fakeDb.purchases[0].discountBreakdown.giftProductIds).toEqual(["prod_gift"]);
  });

  it("releases the coupon use when Stripe session creation fails", async () => {
    seedRule({
      id: "rule_v",
      mechanism: "voucher",
      trigger: "coupon",
      action: { type: "percent", percent: 10 },
    });
    seedCoupon({ ruleId: "rule_v", maxUses: 1 });
    sessionsCreate.mockRejectedValueOnce(new Error("stripe is down"));
    const { status, body } = await checkout({ productId: "prod_1", couponCode: "SAVE10" });
    expect(status).toBe(502);
    expect(body.error).toBe("CHECKOUT_FAILED");
    expect(fakeDb.purchases).toHaveLength(0);
    expect(fakeDb.coupons[0].usageCount).toBe(0);
    expect(fakeDb.redemptions).toHaveLength(0);
  });

  it("lets only one of two simultaneous checkouts redeem the last use", async () => {
    seedRule({
      id: "rule_v",
      mechanism: "voucher",
      trigger: "coupon",
      action: { type: "percent", percent: 10 },
    });
    seedCoupon({ ruleId: "rule_v", maxUses: 1 });
    const [a, b] = await Promise.all([
      checkout({ productId: "prod_1", couponCode: "SAVE10", buyerEmail: "a@example.com" }),
      checkout({ productId: "prod_1", couponCode: "SAVE10", buyerEmail: "b@example.com" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(fakeDb.coupons[0].usageCount).toBe(1);
    expect(fakeDb.redemptions).toHaveLength(1);
    expect(fakeDb.purchases).toHaveLength(1);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });
});
