import { describe, expect, it } from "vitest";
import type { TotalsResult } from "./discounts";
import {
  applyGiftCardToTotals,
  buildReleaseSql,
  buildUpdateBalanceSql,
  checkGiftCard,
  computeGiftCardRefundShare,
  formatGiftCardCode,
  generateGiftCardCode,
  GiftCardResolutionError,
  hashGiftCardCode,
  issueGiftCards,
  normalizeGiftCardCode,
  recordGiftCardRefund,
  redeemGiftCardAtomic,
  releaseGiftCardRedemption,
  resolveGiftCardByCode,
  updateGiftCardBalance,
} from "./gift-cards";

// ─── Gift-card engine test ───────────────────────────────────────────────────
// Same pattern as the discount-engine test: the generated Prisma client
// cannot be built locally (engine download is proxy-blocked), so this file
// never imports @kytelink/db. The fake db simulates the conditional
// UPDATEs' guards in the same binding order the builders emit them, and
// $transaction just runs the callback (no real rollback — tests assert the
// per-statement outcomes, not tx rollback).

const { fakeDb } = (() => {
  const cards: any[] = [];
  const ledger: any[] = [];
  const redemptions: any[] = [];
  const purchases: any[] = [];
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
    refunds,
    adjustments,
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
    purchase: {
      findFirst: async ({ where }: any) => purchases.find((p) => matches(p, where)) ?? null,
      update: async ({ where, data }: any) => {
        const row = purchases.find((p) => p.id === where.id);
        if (!row) throw new Error("purchase not found");
        Object.assign(row, data);
        return row;
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
    // Simulates the conditional UPDATEs: guards checked and the balance
    // move applied synchronously inside the call — the same serialization
    // the Postgres row lock gives the real statements.
    $queryRawUnsafe: async (text: string, ...values: unknown[]) => {
      if (text.includes(`UPDATE "GiftCard"`) && text.includes(`RETURNING "balanceCents", "status"`)) {
        if (text.includes(`EXISTS (SELECT 1 FROM "GiftCardRedemption"`)) {
          // Release statement: $1 cardId, $2 orgId, $3 amount, $4 purchaseId.
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
        // updateBalance statement: $1 cardId, $2 orgId, $3 delta, $4 now.
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
})();

function seedCard(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `gc_${fakeDb.cards.length + 1}`,
    kyteId: "kyte_1",
    orgId: "org_1",
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

function reset() {
  fakeDb.cards.length = 0;
  fakeDb.ledger.length = 0;
  fakeDb.redemptions.length = 0;
  fakeDb.purchases.length = 0;
  fakeDb.refunds.length = 0;
  fakeDb.adjustments.length = 0;
}

function totals(totalCents: number): TotalsResult {
  return {
    subtotalCents: totalCents,
    discountCents: 0,
    shippingCents: 0,
    shippingDiscountCents: 0,
    totalCents,
    applied: [],
    giftLines: [],
    freeShipping: false,
    couponApplied: false,
  };
}

describe("codes: generate / normalize / hash", () => {
  it("generates 16 unambiguous chars and round-trips through display form", () => {
    const code = generateGiftCardCode();
    expect(code).toHaveLength(16);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/);
    const displayed = formatGiftCardCode(code);
    expect(displayed).toMatch(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
    expect(normalizeGiftCardCode(displayed)).toBe(code);
    expect(normalizeGiftCardCode(`  ${displayed.toLowerCase()} `)).toBe(code);
  });

  it("hashes deterministically; the hint is the last 4 chars", () => {
    const code = "ABCDEFGHJKLMNPQR";
    expect(hashGiftCardCode(code)).toBe(hashGiftCardCode(code));
    expect(hashGiftCardCode(code)).toHaveLength(64);
    expect(hashGiftCardCode(code)).not.toBe(hashGiftCardCode("ABCDEFGHJKLMNPQS"));
    expect(code.slice(-4)).toBe("NPQR");
  });
});

describe("applyGiftCardToTotals", () => {
  it("fully covers a smaller order: no Stripe charge, no fee input", () => {
    const result = applyGiftCardToTotals(totals(2000), 2500);
    expect(result.giftCardCents).toBe(2000);
    expect(result.stripeChargeCents).toBe(0);
    expect(result.fullyCoveredByGiftCard).toBe(true);
  });

  it("partially covers: remainder goes to Stripe", () => {
    const result = applyGiftCardToTotals(totals(2000), 500);
    expect(result.giftCardCents).toBe(500);
    expect(result.stripeChargeCents).toBe(1500);
    expect(result.fullyCoveredByGiftCard).toBe(false);
  });

  it("zero balance covers nothing; a zero total needs no card — and is not 'fully covered'", () => {
    expect(applyGiftCardToTotals(totals(2000), 0).giftCardCents).toBe(0);
    const zeroTotal = applyGiftCardToTotals(totals(0), 2500);
    expect(zeroTotal.stripeChargeCents).toBe(0);
    expect(zeroTotal.giftCardCents).toBe(0);
    expect(zeroTotal.fullyCoveredByGiftCard).toBe(false);
  });
});

describe("checkGiftCard", () => {
  it("ok only for ACTIVE with balance and no expiry breach", () => {
    const now = new Date();
    expect(checkGiftCard({ status: "ACTIVE", balanceCents: 100, expiresAt: null, currency: "usd" }, now)).toBe("ok");
    expect(checkGiftCard({ status: "USED", balanceCents: 0, expiresAt: null, currency: "usd" }, now)).toBe("invalid");
    expect(checkGiftCard({ status: "ACTIVE", balanceCents: 0, expiresAt: null, currency: "usd" }, now)).toBe("invalid");
    expect(checkGiftCard({ status: "DEACTIVATED", balanceCents: 100, expiresAt: null, currency: "usd" }, now)).toBe("invalid");
    expect(
      checkGiftCard({ status: "ACTIVE", balanceCents: 100, expiresAt: new Date(now.getTime() - 1000), currency: "usd" }, now),
    ).toBe("invalid");
  });
});

describe("resolveGiftCardByCode", () => {
  it("resolves by hash and rejects every failure mode with the same error", async () => {
    reset();
    seedCard();
    const card = await resolveGiftCardByCode(fakeDb, { orgId: "org_1", code: "abcd-efgh-jklm-npqr" });
    expect(card.id).toBe("gc_1");

    // Unknown code, malformed code, wrong org: all the same error.
    await expect(resolveGiftCardByCode(fakeDb, { orgId: "org_1", code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" })).rejects.toBeInstanceOf(
      GiftCardResolutionError,
    );
    await expect(resolveGiftCardByCode(fakeDb, { orgId: "org_1", code: "SHORT" })).rejects.toBeInstanceOf(
      GiftCardResolutionError,
    );
    await expect(resolveGiftCardByCode(fakeDb, { orgId: "org_2", code: "abcd-efgh-jklm-npqr" })).rejects.toBeInstanceOf(
      GiftCardResolutionError,
    );

    // Expired and used-up cards: same error again (non-oracle).
    reset();
    seedCard({ expiresAt: new Date(Date.now() - 1000) });
    await expect(resolveGiftCardByCode(fakeDb, { orgId: "org_1", code: "ABCDEFGHJKLMNPQR" })).rejects.toBeInstanceOf(
      GiftCardResolutionError,
    );
    reset();
    seedCard({ balanceCents: 0, status: "USED" });
    await expect(resolveGiftCardByCode(fakeDb, { orgId: "org_1", code: "ABCDEFGHJKLMNPQR" })).rejects.toBeInstanceOf(
      GiftCardResolutionError,
    );
  });
});

describe("updateGiftCardBalance — Stacks state machine", () => {
  it("redeems partially and stays ACTIVE; redeeming to zero flips to USED in the same statement", async () => {
    reset();
    const card = seedCard({ balanceCents: 1000 });
    const afterPartial = await updateGiftCardBalance(fakeDb, {
      giftCardId: card.id,
      orgId: "org_1",
      deltaCents: -400,
      kind: "redeem",
    });
    expect(afterPartial).toEqual({ balanceCents: 600, status: "ACTIVE" });
    const afterZero = await updateGiftCardBalance(fakeDb, {
      giftCardId: card.id,
      orgId: "org_1",
      deltaCents: -600,
      kind: "redeem",
    });
    expect(afterZero).toEqual({ balanceCents: 0, status: "USED" });
    // Ledger has both entries with balance-after snapshots.
    expect(fakeDb.ledger).toHaveLength(2);
    expect(fakeDb.ledger[0]).toMatchObject({ kind: "redeem", amountCents: -400, balanceAfterCents: 600 });
    expect(fakeDb.ledger[1]).toMatchObject({ kind: "redeem", amountCents: -600, balanceAfterCents: 0 });
  });

  it("refuses to overdraw and refuses a redeem from a USED card", async () => {
    reset();
    const card = seedCard({ balanceCents: 100 });
    expect(
      await updateGiftCardBalance(fakeDb, { giftCardId: card.id, orgId: "org_1", deltaCents: -101, kind: "redeem" }),
    ).toBeNull();
    expect(card.balanceCents).toBe(100);
    await updateGiftCardBalance(fakeDb, { giftCardId: card.id, orgId: "org_1", deltaCents: -100, kind: "redeem" });
    expect(
      await updateGiftCardBalance(fakeDb, { giftCardId: card.id, orgId: "org_1", deltaCents: -1, kind: "redeem" }),
    ).toBeNull();
  });

  it("reloads an ACTIVE card; a USED non-reloadable card cannot be revived, a USED reloadable one can", async () => {
    reset();
    const fixed = seedCard({ balanceCents: 0, status: "USED", isReloadable: false });
    expect(
      await updateGiftCardBalance(fakeDb, { giftCardId: fixed.id, orgId: "org_1", deltaCents: 500, kind: "reload" }),
    ).toBeNull();
    expect(fixed.balanceCents).toBe(0);

    reset();
    const reloadable = seedCard({ balanceCents: 0, status: "USED", isReloadable: true });
    const revived = await updateGiftCardBalance(fakeDb, {
      giftCardId: reloadable.id,
      orgId: "org_1",
      deltaCents: 500,
      kind: "reload",
    });
    expect(revived).toEqual({ balanceCents: 500, status: "ACTIVE" });
  });

  it("refuses a redeem on an expired card", async () => {
    reset();
    const card = seedCard({ expiresAt: new Date(Date.now() - 1000) });
    expect(
      await updateGiftCardBalance(fakeDb, { giftCardId: card.id, orgId: "org_1", deltaCents: -100, kind: "redeem" }),
    ).toBeNull();
  });

  it("emits SQL with the guards in the WHERE clause (binding order $1..$4)", () => {
    const { text, values } = buildUpdateBalanceSql({
      giftCardId: "gc_1",
      orgId: "org_1",
      deltaCents: -500,
      kind: "redeem",
      now: new Date("2026-11-07T00:00:00Z"),
    });
    expect(text).toContain(`"balanceCents" + $3 >= 0`);
    expect(text).toContain(`"status" = 'ACTIVE'`);
    expect(text).toContain(`"isReloadable" = true`);
    expect(text).toContain(`RETURNING "balanceCents", "status"`);
    expect(values[0]).toBe("gc_1");
    expect(values[1]).toBe("org_1");
    expect(values[2]).toBe(-500);
  });
});

describe("redeemGiftCardAtomic", () => {
  it("deducts, writes ledger + redemption; a second redeem for more than the remainder fails", async () => {
    reset();
    const card = seedCard({ balanceCents: 1000 });
    expect(
      await redeemGiftCardAtomic(fakeDb, {
        giftCardId: card.id,
        orgId: "org_1",
        amountCents: 700,
        buyerEmail: "guest@example.com",
        purchaseId: "pur_1",
      }),
    ).toBe(true);
    expect(card.balanceCents).toBe(300);
    expect(fakeDb.redemptions).toHaveLength(1);
    expect(fakeDb.redemptions[0]).toMatchObject({ giftCardId: card.id, amountCents: 700, status: "redeemed" });
    expect(
      await redeemGiftCardAtomic(fakeDb, {
        giftCardId: card.id,
        orgId: "org_1",
        amountCents: 400,
        buyerEmail: "other@example.com",
        purchaseId: "pur_2",
      }),
    ).toBe(false);
    expect(card.balanceCents).toBe(300);
    expect(fakeDb.redemptions).toHaveLength(1);
  });

  it("lets only one of two simultaneous redeems take the last of the balance", async () => {
    reset();
    const card = seedCard({ balanceCents: 1000 });
    const [a, b] = await Promise.all([
      redeemGiftCardAtomic(fakeDb, { giftCardId: card.id, orgId: "org_1", amountCents: 1000, buyerEmail: "a@example.com", purchaseId: "pur_a" }),
      redeemGiftCardAtomic(fakeDb, { giftCardId: card.id, orgId: "org_1", amountCents: 1000, buyerEmail: "b@example.com", purchaseId: "pur_b" }),
    ]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(card.balanceCents).toBe(0);
    expect(card.status).toBe("USED");
    expect(fakeDb.redemptions).toHaveLength(1);
  });
});

describe("releaseGiftCardRedemption", () => {
  it("credits the balance back and revives a USED non-reloadable card (undo, not reload)", async () => {
    reset();
    const card = seedCard({ balanceCents: 1000 });
    await redeemGiftCardAtomic(fakeDb, {
      giftCardId: card.id,
      orgId: "org_1",
      amountCents: 1000,
      buyerEmail: null,
      purchaseId: "pur_1",
    });
    expect(card.status).toBe("USED");
    expect(
      await releaseGiftCardRedemption(fakeDb, {
        giftCardId: card.id,
        orgId: "org_1",
        amountCents: 1000,
        purchaseId: "pur_1",
      }),
    ).toBe(true);
    expect(card.balanceCents).toBe(1000);
    expect(card.status).toBe("ACTIVE");
    expect(fakeDb.redemptions[0]).toMatchObject({ status: "released" });
    expect(fakeDb.ledger.at(-1)).toMatchObject({ kind: "release", amountCents: 1000, balanceAfterCents: 1000 });
  });

  it("cannot double-release: the second release finds no redeemed row", async () => {
    reset();
    const card = seedCard({ balanceCents: 1000 });
    await redeemGiftCardAtomic(fakeDb, {
      giftCardId: card.id,
      orgId: "org_1",
      amountCents: 400,
      buyerEmail: null,
      purchaseId: "pur_1",
    });
    expect(await releaseGiftCardRedemption(fakeDb, { giftCardId: card.id, orgId: "org_1", amountCents: 400, purchaseId: "pur_1" })).toBe(true);
    expect(await releaseGiftCardRedemption(fakeDb, { giftCardId: card.id, orgId: "org_1", amountCents: 400, purchaseId: "pur_1" })).toBe(false);
    expect(card.balanceCents).toBe(1000);
  });

  it("emits the EXISTS guard on the redemption row", () => {
    const { text, values } = buildReleaseSql({ giftCardId: "gc_1", orgId: "org_1", amountCents: 400, purchaseId: "pur_1" });
    expect(text).toContain(`EXISTS (SELECT 1 FROM "GiftCardRedemption"`);
    expect(text).toContain(`"status" = 'redeemed'`);
    expect(values).toEqual(["gc_1", "org_1", 400, "pur_1"]);
  });
});

describe("issueGiftCards", () => {
  it("mints one card, stores only hash+hint, returns the plaintext once, appends an issue ledger row", async () => {
    reset();
    const issued = await issueGiftCards(fakeDb, {
      kyteId: "kyte_1",
      orgId: "org_1",
      issue: { amountCents: 2500, currency: "usd", quantity: 1, issuedTo: "buyer@example.com" },
    });
    expect(issued).toHaveLength(1);
    expect(issued[0]!.code).toMatch(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
    const stored = fakeDb.cards[0];
    expect(stored.codeHash).toBe(hashGiftCardCode(normalizeGiftCardCode(issued[0]!.code)));
    expect(stored.codeHint).toBe(normalizeGiftCardCode(issued[0]!.code).slice(-4));
    expect(stored).toMatchObject({ balanceCents: 2500, initialBalanceCents: 2500, status: "ACTIVE", issuedTo: "buyer@example.com" });
    expect(fakeDb.ledger).toHaveLength(1);
    expect(fakeDb.ledger[0]).toMatchObject({ kind: "issue", amountCents: 2500, balanceAfterCents: 2500 });
  });

  it("mints a bulk batch with distinct codes", async () => {
    reset();
    const issued = await issueGiftCards(fakeDb, {
      kyteId: "kyte_1",
      orgId: "org_1",
      issue: { amountCents: 1000, currency: "usd", quantity: 5 },
    });
    expect(issued).toHaveLength(5);
    expect(new Set(issued.map((c) => c.code)).size).toBe(5);
    expect(fakeDb.cards).toHaveLength(5);
    expect(fakeDb.ledger).toHaveLength(5);
  });
});

describe("computeGiftCardRefundShare", () => {
  it("reverses proportionally: half the order refunded reverses half the card share", () => {
    // Order $30: $20 Stripe + $10 card. Refund $15 (half) → $5 card share.
    expect(computeGiftCardRefundShare({ refundAmountCents: 1500, stripeChargedCents: 2000, giftCardCents: 1000 })).toBe(500);
    // Full Stripe refund ($20) → the whole card share comes back ($10):
    // a full cash refund means the whole order is refunded.
    expect(computeGiftCardRefundShare({ refundAmountCents: 2000, stripeChargedCents: 2000, giftCardCents: 1000 })).toBe(1000);
    // No card on the order → no share. No Stripe charge → no share.
    expect(computeGiftCardRefundShare({ refundAmountCents: 1000, stripeChargedCents: 1000, giftCardCents: 0 })).toBe(0);
    expect(computeGiftCardRefundShare({ refundAmountCents: 0, stripeChargedCents: 2000, giftCardCents: 1000 })).toBe(0);
  });
});

describe("recordGiftCardRefund — Refund + OrderAdjustment pairing", () => {
  function seedPurchase(overrides: Record<string, unknown> = {}) {
    const row = {
      id: "pur_1",
      kyteId: "kyte_1",
      buyerEmail: "buyer@example.com",
      amountCents: 2000,
      giftCardCents: 1000,
      giftCardId: null as string | null,
      currency: "usd",
      status: "completed",
      ...overrides,
    };
    fakeDb.purchases.push(row);
    return row;
  }

  it("pairs Refund + OrderAdjustment, credits the share back to the original card, keeps a partial refund completed", async () => {
    reset();
    const card = seedCard({ balanceCents: 0, status: "USED" });
    // Card was spent to zero by the order; it is ACTIVE again only via
    // release — here it is USED non-reloadable, so the refund must mint a
    // new card instead. First prove the credit-back path with an ACTIVE card:
    card.status = "ACTIVE";
    card.balanceCents = 500;
    seedPurchase({ giftCardId: card.id });
    const result = await recordGiftCardRefund(fakeDb, {
      purchaseId: "pur_1",
      orgId: "org_1",
      amountCents: 1000,
      stripeRefundId: "re_test_1",
    });
    expect(result.giftCardReversedCents).toBe(333); // 1000 * 1000/3000
    expect(result.replacementGiftCardCode).toBeNull();
    expect(card.balanceCents).toBe(833);
    expect(fakeDb.refunds).toHaveLength(1);
    expect(fakeDb.refunds[0]).toMatchObject({ amountCents: 1000, giftCardReversedCents: 333, giftCardId: card.id });
    expect(fakeDb.adjustments).toHaveLength(1);
    expect(fakeDb.adjustments[0]).toMatchObject({ kind: "refund", amountCents: -1000 });
    expect(fakeDb.purchases[0].status).toBe("completed"); // partial, not refunded
    expect(fakeDb.ledger.at(-1)).toMatchObject({ kind: "refund", amountCents: 333 });
  });

  it("mints the share as a NEW card when the original cannot take credit (Spree remainder-as-new-card)", async () => {
    reset();
    const card = seedCard({ balanceCents: 0, status: "USED", isReloadable: false });
    seedPurchase({ giftCardId: card.id });
    const result = await recordGiftCardRefund(fakeDb, {
      purchaseId: "pur_1",
      orgId: "org_1",
      amountCents: 2000,
      stripeRefundId: "re_test_2",
    });
    // Full Stripe refund: 2000 * 1000/3000 would be 667, but a full cash
    // refund means the whole order is refunded, so the whole $10 share
    // comes back as a new card.
    expect(result.giftCardReversedCents).toBe(1000);
    expect(result.replacementGiftCardCode).toMatch(/^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
    expect(result.replacementGiftCardId).not.toBeNull();
    const replacement = fakeDb.cards.find((c: any) => c.id === result.replacementGiftCardId);
    expect(replacement).toMatchObject({ balanceCents: 1000, status: "ACTIVE", issuedTo: "buyer@example.com" });
    expect(card.balanceCents).toBe(0); // original untouched
    expect(fakeDb.purchases[0].status).toBe("refunded"); // full refund
  });

  it("records a plain refund with no gift-card share and no replacement", async () => {
    reset();
    seedPurchase({ giftCardCents: 0, giftCardId: null });
    const result = await recordGiftCardRefund(fakeDb, {
      purchaseId: "pur_1",
      orgId: "org_1",
      amountCents: 500,
    });
    expect(result.giftCardReversedCents).toBe(0);
    expect(result.replacementGiftCardCode).toBeNull();
    expect(fakeDb.refunds[0]).toMatchObject({ amountCents: 500, giftCardReversedCents: 0 });
    expect(fakeDb.adjustments[0]).toMatchObject({ amountCents: -500 });
  });
});
