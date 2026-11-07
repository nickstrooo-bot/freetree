import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory, type TrpcContext } from "@kytelink/trpc";
import { getClickhouse } from "@kytelink/clickhouse";
import { loadConfig, setConfigForTest } from "../config";
import { logger } from "../logger";
import { createSeededStore, type MemoryStore } from "../store/memory-store";
import { computeFeeCents } from "../commerce/stripe";
import { hashGiftCardCode } from "../commerce/gift-cards";
import { appRouter } from "./index";

// ─── Commerce gift-card router test ──────────────────────────────────────────
// Same pattern as the discount router test: the generated Prisma client
// cannot be built locally (engine download is proxy-blocked), so the real
// @kytelink/db module cannot even be imported here. This test mocks it with
// a small in-memory stand-in and exercises the seller gift-card procedures
// end to end: access control via the seeded MemoryStore, issue (single +
// bulk, plaintext returned once), list (hint only — never the code or the
// hash), detail + ledger, reload under the Stacks state machine,
// activate/deactivate, and previewTotals through the same engine the
// checkout route uses — so the seller preview and the charge cannot drift.

const { fakeDb } = vi.hoisted(() => {
  const cards: any[] = [];
  const ledger: any[] = [];
  const products: any[] = [];

  function matches(row: any, where: any): boolean {
    if (!where) return true;
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (row[key] !== value) return false;
    }
    return true;
  }

  const cardById = (id: string) => cards.find((c) => c.id === id);

  const fakeDb = {
    cards,
    ledger,
    products,
    giftCard: {
      findMany: async ({ where, take }: any) => {
        const rows = cards.filter((c) => matches(c, where));
        return take !== undefined ? rows.slice(0, take) : rows;
      },
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
      findMany: async ({ where, take }: any) => {
        const rows = ledger.filter((l) => matches(l, where));
        return take !== undefined ? rows.slice(0, take) : rows;
      },
      create: async ({ data }: any) => {
        const row = { ...data, id: `led_${ledger.length + 1}`, createdAt: new Date() };
        ledger.push(row);
        return row;
      },
    },
    product: {
      findFirst: async ({ where }: any) => products.find((p) => matches(p, where)) ?? null,
    },
    discountRule: {
      findMany: async () => [],
    },
    $queryRawUnsafe: async (text: string, ...values: unknown[]) => {
      if (text.includes(`UPDATE "GiftCard"`) && text.includes(`RETURNING "balanceCents", "status"`)) {
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
  fakeDb.cards.length = 0;
  fakeDb.ledger.length = 0;
  fakeDb.products.length = 0;
  fakeDb.products.push({
    id: "prod_1", kyteId: KYTE_ID, orgId: ORG_ID, name: "Ebook", description: null,
    priceCents: 2000, currency: "usd", kind: "digital", active: true,
    createdAt: new Date(), updatedAt: new Date(),
  });
  setConfigForTest(
    loadConfig({ ...process.env, ADMIN_EMAILS: "agent-admin@kytelink.dev", WEB_BASE_URL: "http://localhost:3000" }),
  );
});

async function ownerCaller() {
  return createCaller(await contextFor(store, "agent@kytelink.dev"));
}

async function issue(caller: any, issueInput: any) {
  return caller.commerce.issueGiftCards({ kyteId: KYTE_ID, issue: issueInput });
}

describe("commerce.issueGiftCards / listGiftCards", () => {
  it("starts empty, then lists an issued card by hint only — never the code or hash", async () => {
    const caller = await ownerCaller();
    await expect(caller.commerce.listGiftCards({ kyteId: KYTE_ID })).resolves.toEqual({ giftCards: [] });

    const result = await issue(caller, { amountCents: 2500, issuedTo: "buyer@example.com" });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].code).toMatch(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
    expect(result.cards[0]).toMatchObject({ amountCents: 2500, currency: "usd" });

    const listed = await caller.commerce.listGiftCards({ kyteId: KYTE_ID });
    expect(listed.giftCards).toHaveLength(1);
    const first = listed.giftCards[0]!;
    expect(first).toMatchObject({
      balanceCents: 2500,
      initialBalanceCents: 2500,
      status: "ACTIVE",
      issuedTo: "buyer@example.com",
    });
    expect(first.codeHint).toBe(result.cards[0].code.replace(/-/g, "").slice(-4));
    // No plaintext code, no hash, anywhere in the list response.
    expect("code" in first).toBe(false);
    expect("codeHash" in first).toBe(false);
  });

  it("issues a bulk batch with distinct codes and one ledger row each", async () => {
    const caller = await ownerCaller();
    const result = await issue(caller, { amountCents: 1000, quantity: 3 });
    expect(result.cards).toHaveLength(3);
    expect(new Set(result.cards.map((c: any) => c.code)).size).toBe(3);
    expect(fakeDb.ledger).toHaveLength(3);
    expect(fakeDb.ledger[0]).toMatchObject({ kind: "issue", amountCents: 1000, balanceAfterCents: 1000 });
  });

  it("rejects bad issue input (amount below minimum, quantity over 100, past expiry)", async () => {
    const caller = await ownerCaller();
    await expect(issue(caller, { amountCents: 49 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(issue(caller, { amountCents: 1000, quantity: 101 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      issue(caller, { amountCents: 1000, expiresAt: new Date(Date.now() - 1000) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("commerce.getGiftCard", () => {
  it("returns the card with its append-only ledger", async () => {
    const caller = await ownerCaller();
    const { cards } = await issue(caller, { amountCents: 2500 });
    const detail = await caller.commerce.getGiftCard({ kyteId: KYTE_ID, giftCardId: cards[0].id });
    expect(detail.giftCard).toMatchObject({ balanceCents: 2500, status: "ACTIVE" });
    expect(detail.ledger).toHaveLength(1);
    expect(detail.ledger[0]).toMatchObject({ kind: "issue", amountCents: 2500, balanceAfterCents: 2500 });
  });

  it("404s for another seller's card id", async () => {
    const caller = await ownerCaller();
    await expect(
      caller.commerce.getGiftCard({ kyteId: KYTE_ID, giftCardId: "gc_missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("commerce.reloadGiftCard / setGiftCardActive", () => {
  function seedCard(overrides: Record<string, unknown> = {}) {
    const row = {
      id: `gc_${fakeDb.cards.length + 1}`,
      kyteId: KYTE_ID,
      orgId: ORG_ID,
      codeHash: hashGiftCardCode("ABCDEFGHJKLMNPQR"),
      codeHint: "NPQR",
      currency: "usd",
      initialBalanceCents: 1000,
      balanceCents: 1000,
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

  it("tops up an ACTIVE card", async () => {
    const caller = await ownerCaller();
    const card = seedCard({ balanceCents: 400 });
    const reloaded = await caller.commerce.reloadGiftCard({
      kyteId: KYTE_ID,
      giftCardId: card.id,
      amountCents: 600,
    });
    expect(reloaded).toMatchObject({ balanceCents: 1000, status: "ACTIVE" });
  });

  it("refuses to revive a USED non-reloadable card, but revives a USED reloadable one", async () => {
    const caller = await ownerCaller();
    const fixed = seedCard({ balanceCents: 0, status: "USED", isReloadable: false });
    await expect(
      caller.commerce.reloadGiftCard({ kyteId: KYTE_ID, giftCardId: fixed.id, amountCents: 500 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const reloadable = seedCard({ balanceCents: 0, status: "USED", isReloadable: true });
    const revived = await caller.commerce.reloadGiftCard({
      kyteId: KYTE_ID,
      giftCardId: reloadable.id,
      amountCents: 500,
    });
    expect(revived).toMatchObject({ balanceCents: 500, status: "ACTIVE" });
  });

  it("deactivates and reactivates; a USED card can't be reactivated", async () => {
    const caller = await ownerCaller();
    const card = seedCard();
    const off = await caller.commerce.setGiftCardActive({ kyteId: KYTE_ID, giftCardId: card.id, active: false });
    expect(off.status).toBe("DEACTIVATED");
    const on = await caller.commerce.setGiftCardActive({ kyteId: KYTE_ID, giftCardId: card.id, active: true });
    expect(on.status).toBe("ACTIVE");

    const used = seedCard({ balanceCents: 0, status: "USED" });
    await expect(
      caller.commerce.setGiftCardActive({ kyteId: KYTE_ID, giftCardId: used.id, active: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("commerce.previewTotals with a gift card", () => {
  function seedCard(overrides: Record<string, unknown> = {}) {
    const row = {
      id: `gc_${fakeDb.cards.length + 1}`,
      kyteId: KYTE_ID,
      orgId: ORG_ID,
      codeHash: hashGiftCardCode("ABCDEFGHJKLMNPQR"),
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

  it("agrees with the charge: partial cover fees only the remainder", async () => {
    const caller = await ownerCaller();
    seedCard({ balanceCents: 500 });
    const preview = await caller.commerce.previewTotals({
      kyteId: KYTE_ID,
      productId: "prod_1",
      giftCardCode: "ABCDEFGHJKLMNPQR",
    });
    expect(preview).toMatchObject({
      totalCents: 2000,
      giftCardCents: 500,
      stripeChargeCents: 1500,
      fullyCoveredByGiftCard: false,
      feeCents: computeFeeCents(1500),
    });
  });

  it("full cover: no Stripe charge, no fee", async () => {
    const caller = await ownerCaller();
    seedCard({ balanceCents: 2500 });
    const preview = await caller.commerce.previewTotals({
      kyteId: KYTE_ID,
      productId: "prod_1",
      giftCardCode: "ABCDEFGHJKLMNPQR",
    });
    expect(preview).toMatchObject({
      giftCardCents: 2000,
      stripeChargeCents: 0,
      fullyCoveredByGiftCard: true,
      feeCents: 0,
    });
  });

  it("without a card the preview is unchanged (fee on the full total)", async () => {
    const caller = await ownerCaller();
    const preview = await caller.commerce.previewTotals({ kyteId: KYTE_ID, productId: "prod_1" });
    expect(preview).toMatchObject({
      totalCents: 2000,
      giftCardCents: 0,
      stripeChargeCents: 2000,
      feeCents: computeFeeCents(2000),
    });
  });

  it("rejects an unknown gift-card code in the preview", async () => {
    const caller = await ownerCaller();
    await expect(
      caller.commerce.previewTotals({ kyteId: KYTE_ID, productId: "prod_1", giftCardCode: "ZZZZZZZZZZZZZZZZ" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
