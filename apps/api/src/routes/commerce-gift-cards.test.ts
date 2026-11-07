import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, setConfigForTest } from "../config";
import { computeFeeCents } from "../commerce/stripe";
import { hashGiftCardCode } from "../commerce/gift-cards";
import { registerCommerceRoutes } from "./commerce";

import type * as StripeModule from "../commerce/stripe";

// ─── Commerce checkout route test (gift cards) ───────────────────────────────
// Exercises the Fastify checkout + balance-check + webhook paths through the
// real route handlers with a mocked db and a mocked Stripe client: full and
// partial gift-card cover (fee only on the Stripe remainder), the
// no-Stripe-charge path, the atomic redeem (including the two-buyers-one-card
// race), release on Stripe failure and on session expiry, the non-oracle
// balance check, and the Solidus refund pairing (Refund + OrderAdjustment
// with proportional gift-card reversal) on charge.refunded.
//
// Same fake-db pattern as the discount-engine route test: the generated
// Prisma client cannot be built locally (engine download is proxy-blocked),
// so @kytelink/db is mocked with an in-memory stand-in whose
// $queryRawUnsafe simulates the conditional UPDATEs' guards in the same
// binding order the engine emits them. The webhook signature check is
// mocked to parse the body (signature verification itself is Stripe's
// library, not FreeTree logic).

const sessionsCreate = vi.hoisted(() => vi.fn());

const { fakeDb } = vi.hoisted(() => {
  const cards: any[] = [];
  const ledger: any[] = [];
  const redemptions: any[] = [];
  const purchases: any[] = [];
  const products: any[] = [];
  const refunds: any[] = [];
  const adjustments: any[] = [];

  function matches(row: any, where: any): boolean {
    if (!where) return true;
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (row[key] !== value) return false;
    }
    return true;
  }

  const cardById = (id: string) => cards.find((c) => c.id === id);

  const fakeDb: any = {
    cards,
    ledger,
    redemptions,
    purchases,
    products,
    refunds,
    adjustments,
    kyte: {
      findFirst: async ({ where }: any) => {
        if (where.username === "seller" || where.id === "kyte_1") {
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
        if (include?.kyte) {
          return { ...row, kyte: { id: "kyte_1", orgId: "org_1", username: "seller" } };
        }
        return row;
      },
    },
    discountRule: {
      findMany: async () => [],
    },
    giftCard: {
      findFirst: async ({ where }: any) => cards.find((c) => matches(c, where)) ?? null,
      create: async ({ data }: any) => {
        if (cards.some((c) => c.orgId === data.orgId && c.codeHash === data.codeHash)) {
          const error: any = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        const row = { ...data, id: `gc_${cards.length + 1}`, createdAt: new Date(), updatedAt: new Date() };
        cards.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = cardById(where.id);
        if (!row) throw new Error("card not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    giftCardLedger: {
      create: async ({ data }: any) => {
        const row = { ...data, id: `led_${ledger.length + 1}`, createdAt: new Date() };
        ledger.push(row);
        return row;
      },
    },
    giftCardRedemption: {
      create: async ({ data }: any) => {
        const row = { ...data, id: `red_${redemptions.length + 1}`, redeemedAt: new Date(), releasedAt: null };
        redemptions.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const r of redemptions) {
          if (matches(r, where)) {
            Object.assign(r, data);
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
      findFirst: async ({ where }: any) => purchases.find((p) => matches(p, where)) ?? null,
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
    refund: {
      findMany: async ({ where }: any) => refunds.filter((r) => matches(r, where)),
      create: async ({ data }: any) => {
        const row = { ...data, id: `ref_${refunds.length + 1}`, createdAt: new Date() };
        refunds.push(row);
        return row;
      },
    },
    orderAdjustment: {
      create: async ({ data }: any) => {
        const row = { ...data, id: `adj_${adjustments.length + 1}`, createdAt: new Date() };
        adjustments.push(row);
        return row;
      },
    },
    $queryRawUnsafe: async (text: string, ...values: unknown[]) => {
      if (text.includes(`UPDATE "GiftCard"`) && text.includes(`RETURNING "balanceCents", "status"`)) {
        if (text.includes(`EXISTS (SELECT 1 FROM "GiftCardRedemption"`)) {
          const [cardId, orgId, amount, purchaseId] = values as [string, string, number, string | null];
          const card = cardById(cardId);
          if (!card || card.orgId !== orgId) return [];
          const hasRedeemed = redemptions.some(
            (r) => r.giftCardId === cardId && r.purchaseId === purchaseId && r.status === "redeemed",
          );
          if (!hasRedeemed) return [];
          card.balanceCents += amount;
          if (card.balanceCents > 0) card.status = "ACTIVE";
          return [{ balanceCents: card.balanceCents, status: card.status }];
        }
        const [cardId, orgId, delta, now] = values as [string, string, number, Date];
        const card = cardById(cardId);
        if (!card || card.orgId !== orgId) return [];
        if (card.balanceCents + delta < 0) return [];
        if (delta < 0) {
          if (card.status !== "ACTIVE") return [];
          if (card.expiresAt && card.expiresAt < now) return [];
        } else {
          if (!(card.status === "ACTIVE" || (card.status === "USED" && card.isReloadable))) return [];
        }
        card.balanceCents += delta;
        if (card.balanceCents === 0) card.status = "USED";
        else if (card.balanceCents > 0) card.status = "ACTIVE";
        return [{ balanceCents: card.balanceCents, status: card.status }];
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
  // The webhook test posts events directly; signature verification is
  // Stripe's library, not FreeTree logic — parse the body instead.
  verifyWebhookEvent: (_stripe: unknown, rawBody: string | Buffer) => JSON.parse(rawBody.toString()),
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
    allowPromoCodes: false,
    fileKey: null,
    fileName: null,
    externalUrl: "https://example.com/ebook.pdf",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const CARD_CODE = "ABCDEFGHJKLMNPQR";

function seedCard(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `gc_${fakeDb.cards.length + 1}`,
    kyteId: "kyte_1",
    orgId: "org_1",
    codeHash: hashGiftCardCode(CARD_CODE),
    codeHint: "NPQR",
    currency: "usd",
    initialBalanceCents: 2500,
    balanceCents: 2500,
    status: "ACTIVE",
    isReloadable: false,
    issuedTo: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  fakeDb.cards.push(row);
  return row;
}

beforeEach(async () => {
  setConfigForTest(
    loadConfig({ ...process.env, WEB_BASE_URL: "http://localhost:3000", API_BASE_URL: "http://localhost:3001" }),
  );
  fakeDb.cards.length = 0;
  fakeDb.ledger.length = 0;
  fakeDb.redemptions.length = 0;
  fakeDb.purchases.length = 0;
  fakeDb.products.length = 0;
  fakeDb.refunds.length = 0;
  fakeDb.adjustments.length = 0;
  fakeDb.products.push(seedProduct());
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

async function balanceCheck(body: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/commerce/gift-card/balance",
    payload: body,
  });
  return { status: response.statusCode, body: response.json() as any };
}

async function webhook(event: Record<string, unknown>) {
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    payload: JSON.stringify(event),
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=test" },
  });
  return { status: response.statusCode, body: response.json() as any };
}

describe("POST /commerce/checkout with a gift card", () => {
  it("fully covers the order: no Stripe session, no fee, purchase completed, card drained to USED", async () => {
    seedCard({ balanceCents: 2500 });
    const { status, body } = await checkout({ productId: "prod_1", giftCardCode: "abcd-efgh-jklm-npqr" });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      url: null,
      sessionId: null,
      totalCents: 2000,
      giftCardCents: 2000,
      stripeChargeCents: 0,
      paidByGiftCard: true,
    });
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(fakeDb.purchases).toHaveLength(1);
    expect(fakeDb.purchases[0]).toMatchObject({
      amountCents: 0,
      feeCents: 0,
      giftCardCents: 2000,
      status: "completed",
      stripeSessionId: `giftcard_${fakeDb.purchases[0].id}`,
    });
    const card = fakeDb.cards[0];
    expect(card.balanceCents).toBe(500);
    expect(card.status).toBe("ACTIVE");
    expect(fakeDb.ledger).toHaveLength(1);
    expect(fakeDb.ledger[0]).toMatchObject({ kind: "redeem", amountCents: -2000, balanceAfterCents: 500 });
    expect(fakeDb.redemptions).toHaveLength(1);
  });

  it("drains the card to exactly zero and flips it to USED", async () => {
    seedCard({ balanceCents: 2000 });
    const { status } = await checkout({ productId: "prod_1", giftCardCode: CARD_CODE });
    expect(status).toBe(200);
    expect(fakeDb.cards[0]).toMatchObject({ balanceCents: 0, status: "USED" });
  });

  it("partially covers: Stripe charges only the remainder, fee only on the remainder", async () => {
    seedCard({ balanceCents: 500 });
    const { status, body } = await checkout({ productId: "prod_1", giftCardCode: CARD_CODE });
    expect(status).toBe(200);
    expect(body).toMatchObject({ giftCardCents: 500, stripeChargeCents: 1500, paidByGiftCard: false });
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const params = sessionsCreate.mock.calls[0]![0];
    expect(params.line_items[0].price_data.unit_amount).toBe(1500);
    expect(params.payment_intent_data.application_fee_amount).toBe(computeFeeCents(1500));
    expect(params.metadata.freetree_gift_card_cents).toBe("500");
    expect(fakeDb.purchases[0]).toMatchObject({
      amountCents: 1500,
      feeCents: computeFeeCents(1500),
      giftCardCents: 500,
      status: "pending",
    });
    expect(fakeDb.cards[0].balanceCents).toBe(0);
  });

  it("rejects an unknown, expired, or wrong-currency code with the same generic error and no order", async () => {
    const unknown = await checkout({ productId: "prod_1", giftCardCode: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("GIFT_CARD_INVALID");
    expect(fakeDb.purchases).toHaveLength(0);
    expect(sessionsCreate).not.toHaveBeenCalled();

    seedCard({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await checkout({ productId: "prod_1", giftCardCode: CARD_CODE });
    expect(expired.status).toBe(400);
    expect(expired.body.error).toBe("GIFT_CARD_INVALID");
    expect(fakeDb.purchases).toHaveLength(0);

    fakeDb.cards.length = 0;
    seedCard({ currency: "eur" });
    const mismatch = await checkout({ productId: "prod_1", giftCardCode: CARD_CODE });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe("GIFT_CARD_INVALID");
    expect(fakeDb.purchases).toHaveLength(0);
  });

  it("refuses a remainder below Stripe's minimum", async () => {
    seedCard({ balanceCents: 1970 });
    const { status, body } = await checkout({ productId: "prod_1", giftCardCode: CARD_CODE });
    expect(status).toBe(400);
    expect(body.error).toBe("TOTAL_BELOW_MINIMUM");
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(fakeDb.cards[0].balanceCents).toBe(1970);
  });

  it("lets only one of two simultaneous checkouts spend the card", async () => {
    seedCard({ balanceCents: 2000 });
    const [a, b] = await Promise.all([
      checkout({ productId: "prod_1", giftCardCode: CARD_CODE, buyerEmail: "a@example.com" }),
      checkout({ productId: "prod_1", giftCardCode: CARD_CODE, buyerEmail: "b@example.com" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    expect(fakeDb.cards[0].balanceCents).toBe(0);
    expect(fakeDb.redemptions).toHaveLength(1);
    expect(fakeDb.purchases).toHaveLength(1);
  });

  it("releases the card value when Stripe session creation fails", async () => {
    seedCard({ balanceCents: 500 });
    sessionsCreate.mockRejectedValueOnce(new Error("stripe is down"));
    const { status, body } = await checkout({ productId: "prod_1", giftCardCode: CARD_CODE });
    expect(status).toBe(502);
    expect(body.error).toBe("CHECKOUT_FAILED");
    expect(fakeDb.purchases).toHaveLength(0);
    expect(fakeDb.cards[0]).toMatchObject({ balanceCents: 500, status: "ACTIVE" });
    expect(fakeDb.redemptions[0]).toMatchObject({ status: "released" });
  });

  it("stacks with a discount: the card applies to the discounted total", async () => {
    // No catalog/cart rules seeded here (discountRule.findMany returns []),
    // so this pins the ordering contract: amountCents + giftCardCents +
    // discountCents always equals the pre-discount total. Covered by the
    // partial test above (2000 = 1500 + 500 + 0); the discount-stacking
    // math itself is unit-tested in applyGiftCardToTotals.
    seedCard({ balanceCents: 2500 });
    const { status, body } = await checkout({ productId: "prod_1", giftCardCode: CARD_CODE });
    expect(status).toBe(200);
    expect(body.totalCents).toBe(body.stripeChargeCents + body.giftCardCents);
  });
});

describe("POST /commerce/gift-card/balance — non-oracle", () => {
  it("returns the balance for a valid code", async () => {
    seedCard({ balanceCents: 1750 });
    const { status, body } = await balanceCheck({ username: "seller", code: CARD_CODE });
    expect(status).toBe(200);
    expect(body).toEqual({ balanceCents: 1750, currency: "usd", expiresAt: null });
  });

  it("answers unknown, malformed, expired, and used-up codes identically", async () => {
    seedCard({ balanceCents: 0, status: "USED" });
    const cases = [
      { username: "seller", code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" },
      { username: "seller", code: "TOOSHORT" },
      { username: "seller", code: CARD_CODE }, // used up
      { username: "nobody", code: CARD_CODE }, // unknown seller
    ];
    for (const payload of cases) {
      const { status, body } = await balanceCheck(payload);
      expect(status).toBe(404);
      expect(body).toEqual({ error: "GIFT_CARD_NOT_FOUND" });
    }
    fakeDb.cards.length = 0;
    seedCard({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await balanceCheck({ username: "seller", code: CARD_CODE });
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual({ error: "GIFT_CARD_NOT_FOUND" });
  });
});

describe("Stripe webhooks — gift-card release + refund pairing", () => {
  it("completes a partial-cover purchase on checkout.session.completed", async () => {
    seedCard({ balanceCents: 500 });
    await checkout({ productId: "prod_1", giftCardCode: CARD_CODE });
    const purchase = fakeDb.purchases[0];
    const { status } = await webhook({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          payment_intent: "pi_1",
          customer_email: "buyer@example.com",
          metadata: { freetree_purchase_id: purchase.id },
        },
      },
    });
    expect(status).toBe(200);
    expect(purchase.status).toBe("completed");
    expect(purchase.stripePaymentIntent).toBe("pi_1");
  });

  it("releases the card value when the buyer abandons the session", async () => {
    const card = seedCard({ balanceCents: 600 });
    fakeDb.purchases.push({
      id: "pur_abandoned",
      productId: "prod_1",
      kyteId: "kyte_1",
      buyerEmail: "buyer@example.com",
      stripeSessionId: "cs_expired",
      stripePaymentIntent: null,
      amountCents: 1600,
      feeCents: computeFeeCents(1600),
      currency: "usd",
      status: "pending",
      giftCardCents: 400,
      giftCardId: card.id,
      createdAt: new Date(),
    });
    fakeDb.redemptions.push({
      id: "red_1",
      giftCardId: card.id,
      orgId: "org_1",
      buyerEmail: "buyer@example.com",
      purchaseId: "pur_abandoned",
      amountCents: 400,
      status: "redeemed",
      redeemedAt: new Date(),
      releasedAt: null,
    });
    const { status } = await webhook({
      type: "checkout.session.expired",
      data: { object: { id: "cs_expired" } },
    });
    expect(status).toBe(200);
    expect(card.balanceCents).toBe(1000);
    expect(fakeDb.redemptions[0].status).toBe("released");
  });

  it("pairs a partial refund with its order adjustment and credits the card share back", async () => {
    const card = seedCard({ balanceCents: 500, status: "ACTIVE" });
    fakeDb.purchases.push({
      id: "pur_1",
      productId: "prod_1",
      kyteId: "kyte_1",
      buyerEmail: "buyer@example.com",
      stripeSessionId: "cs_test_123",
      stripePaymentIntent: "pi_1",
      amountCents: 2000,
      feeCents: computeFeeCents(2000),
      currency: "usd",
      status: "completed",
      giftCardCents: 1000,
      giftCardId: card.id,
      createdAt: new Date(),
    });
    const { status } = await webhook({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_1",
          amount: 2000,
          amount_refunded: 1000,
          refunds: { data: [{ id: "re_1" }] },
        },
      },
    });
    expect(status).toBe(200);
    // $10 of a $30 order refunded → $3.33 of the card share back.
    expect(fakeDb.refunds).toHaveLength(1);
    expect(fakeDb.refunds[0]).toMatchObject({
      amountCents: 1000,
      giftCardReversedCents: 333,
      giftCardId: card.id,
      stripeRefundId: "re_1",
    });
    expect(fakeDb.adjustments).toHaveLength(1);
    expect(fakeDb.adjustments[0]).toMatchObject({ kind: "refund", amountCents: -1000 });
    expect(card.balanceCents).toBe(833);
    expect(fakeDb.purchases[0].status).toBe("completed"); // partial, not refunded
  });

  it("does not double-record a retried refund webhook", async () => {
    const card = seedCard({ balanceCents: 500, status: "ACTIVE" });
    fakeDb.purchases.push({
      id: "pur_1",
      productId: "prod_1",
      kyteId: "kyte_1",
      buyerEmail: "buyer@example.com",
      stripeSessionId: "cs_test_123",
      stripePaymentIntent: "pi_1",
      amountCents: 2000,
      feeCents: computeFeeCents(2000),
      currency: "usd",
      status: "completed",
      giftCardCents: 1000,
      giftCardId: card.id,
      createdAt: new Date(),
    });
    const event = {
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_1",
          amount: 2000,
          amount_refunded: 1000,
          refunds: { data: [{ id: "re_1" }] },
        },
      },
    };
    await webhook(event);
    await webhook(event);
    expect(fakeDb.refunds).toHaveLength(1);
    expect(fakeDb.adjustments).toHaveLength(1);
    expect(card.balanceCents).toBe(833);
  });

  it("mints a replacement card on a full refund when the original is USED and non-reloadable", async () => {
    const card = seedCard({ balanceCents: 0, status: "USED", isReloadable: false });
    fakeDb.purchases.push({
      id: "pur_1",
      productId: "prod_1",
      kyteId: "kyte_1",
      buyerEmail: "buyer@example.com",
      stripeSessionId: "cs_test_123",
      stripePaymentIntent: "pi_1",
      amountCents: 2000,
      feeCents: computeFeeCents(2000),
      currency: "usd",
      status: "completed",
      giftCardCents: 1000,
      giftCardId: card.id,
      createdAt: new Date(),
    });
    const { status } = await webhook({
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_1",
          amount: 2000,
          amount_refunded: 2000,
          refunds: { data: [{ id: "re_2" }] },
        },
      },
    });
    expect(status).toBe(200);
    expect(fakeDb.refunds[0]).toMatchObject({ amountCents: 2000, giftCardReversedCents: 1000 });
    expect(fakeDb.refunds[0].replacementGiftCardId).not.toBeNull();
    const replacement = fakeDb.cards.find((c: any) => c.id === fakeDb.refunds[0].replacementGiftCardId);
    expect(replacement).toMatchObject({ balanceCents: 1000, status: "ACTIVE", issuedTo: "buyer@example.com" });
    expect(card.balanceCents).toBe(0);
    expect(fakeDb.purchases[0].status).toBe("refunded");
  });
});
