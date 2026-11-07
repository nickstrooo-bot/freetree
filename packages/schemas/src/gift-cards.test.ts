import { describe, expect, it } from "vitest";
import {
  giftCardIssueInputSchema,
  giftCardReloadInputSchema,
  giftCardSchema,
  giftCardStatusSchema,
} from "./gift-cards";

describe("giftCardIssueInputSchema", () => {
  it("accepts a minimal single issue and fills defaults", () => {
    const parsed = giftCardIssueInputSchema.safeParse({ amountCents: 2500 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.currency).toBe("usd");
      expect(parsed.data.quantity).toBe(1);
      expect(parsed.data.isReloadable).toBe(false);
      expect(parsed.data.expiresAt ?? null).toBeNull();
    }
  });

  it("accepts a bulk issue", () => {
    const parsed = giftCardIssueInputSchema.safeParse({
      amountCents: 1000,
      quantity: 25,
      currency: "USD",
      issuedTo: "buyer@example.com",
      expiresAt: new Date(Date.now() + 86_400_000),
      isReloadable: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.currency).toBe("usd");
      expect(parsed.data.quantity).toBe(25);
    }
  });

  it("rejects amounts below the Stripe minimum and above the cap", () => {
    expect(giftCardIssueInputSchema.safeParse({ amountCents: 49 }).success).toBe(false);
    expect(giftCardIssueInputSchema.safeParse({ amountCents: 0 }).success).toBe(false);
    expect(giftCardIssueInputSchema.safeParse({ amountCents: 100_000_001 }).success).toBe(false);
  });

  it("rejects quantity outside 1–100", () => {
    expect(giftCardIssueInputSchema.safeParse({ amountCents: 1000, quantity: 0 }).success).toBe(false);
    expect(giftCardIssueInputSchema.safeParse({ amountCents: 1000, quantity: 101 }).success).toBe(false);
  });

  it("rejects a bad currency and a past expiry", () => {
    expect(giftCardIssueInputSchema.safeParse({ amountCents: 1000, currency: "US" }).success).toBe(false);
    expect(
      giftCardIssueInputSchema.safeParse({
        amountCents: 1000,
        expiresAt: new Date(Date.now() - 1000),
      }).success,
    ).toBe(false);
  });
});

describe("giftCardReloadInputSchema", () => {
  it("accepts a positive top-up and rejects zero", () => {
    expect(giftCardReloadInputSchema.safeParse({ amountCents: 500 }).success).toBe(true);
    expect(giftCardReloadInputSchema.safeParse({ amountCents: 0 }).success).toBe(false);
  });
});

describe("giftCardSchema", () => {
  it("parses a stored row and rejects a short hash", () => {
    const row = {
      id: "gc_1",
      kyteId: "kyte_1",
      orgId: "org_1",
      codeHash: "a".repeat(64),
      codeHint: "WXYZ",
      currency: "usd",
      initialBalanceCents: 2500,
      balanceCents: 2500,
      status: "ACTIVE",
      isReloadable: false,
      issuedTo: null,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(giftCardSchema.safeParse(row).success).toBe(true);
    expect(giftCardSchema.safeParse({ ...row, codeHash: "abc" }).success).toBe(false);
    expect(giftCardStatusSchema.safeParse("BURNED").success).toBe(false);
  });
});
