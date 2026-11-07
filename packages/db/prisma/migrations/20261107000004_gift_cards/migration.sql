-- Gift cards (Saleor model + blamejs ledger + Stacks state machine +
-- Spree remainder-as-new-card + Solidus refund model, rebuilt natively —
-- MODELS ONLY, no platform code copied).
--
-- GiftCard: currency-based balance (Saleor). Only the SHA-256 hash of the
-- 16-char code + a 4-char hint are stored; the plaintext is returned once
-- at creation and is then unrecoverable. Balance changes go through ONE
-- entry point (updateBalance in apps/api/src/commerce/gift-cards.ts) whose
-- single conditional UPDATE enforces the state machine in its WHERE
-- clause — the database decides the race, not read-check-write.
--
-- GiftCardLedger: append-only, one row per balance change with a
-- balance-after snapshot (blamejs's balance_after_minor) for O(1) reads.
--
-- GiftCardRedemption: one row per successful redeem, for the release path
-- (failed/abandoned checkout gives the money back) and for audit.
-- purchaseId is a plain string, not an FK: the purchase row is deleted if
-- Stripe session creation fails and the redemption is released with it.
--
-- Refund + OrderAdjustment (Solidus): a Refund is a separate model from
-- the payment, and it is ALWAYS created together with its OrderAdjustment
-- in one transaction — a bare refund must never leave the order
-- balance_due. A refund of a gift-card-paid order reverses the card's
-- share proportionally (back to the original card when it can take
-- credit, otherwise minted as a NEW card for the buyer).
--
-- Purchase gains giftCardCents / giftCardId so the seller's sales list
-- and the webhook-reconciled row agree with what was actually charged:
-- amountCents is what Stripe charged; amountCents + giftCardCents is the
-- discounted total. A fully gift-card-covered order has amountCents 0 and
-- feeCents 0 — no Stripe charge, no fee.

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL,
    "kyteId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeHint" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "initialBalanceCents" INTEGER NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isReloadable" BOOLEAN NOT NULL DEFAULT false,
    "issuedTo" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardLedger" (
    "id" TEXT NOT NULL,
    "giftCardId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "purchaseId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCardLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardRedemption" (
    "id" TEXT NOT NULL,
    "giftCardId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "buyerEmail" TEXT,
    "purchaseId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'redeemed',
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "GiftCardRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripeRefundId" TEXT,
    "reason" TEXT,
    "giftCardReversedCents" INTEGER NOT NULL DEFAULT 0,
    "giftCardId" TEXT,
    "replacementGiftCardId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAdjustment" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAdjustment_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN "giftCardCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "giftCardId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_orgId_codeHash_key" ON "GiftCard"("orgId", "codeHash");

-- CreateIndex
CREATE INDEX "GiftCard_orgId_status_idx" ON "GiftCard"("orgId", "status");

-- CreateIndex
CREATE INDEX "GiftCard_kyteId_idx" ON "GiftCard"("kyteId");

-- CreateIndex
CREATE INDEX "GiftCardLedger_giftCardId_createdAt_idx" ON "GiftCardLedger"("giftCardId", "createdAt");

-- CreateIndex
CREATE INDEX "GiftCardLedger_orgId_idx" ON "GiftCardLedger"("orgId");

-- CreateIndex
CREATE INDEX "GiftCardRedemption_giftCardId_idx" ON "GiftCardRedemption"("giftCardId");

-- CreateIndex
CREATE INDEX "GiftCardRedemption_purchaseId_idx" ON "GiftCardRedemption"("purchaseId");

-- CreateIndex
CREATE INDEX "GiftCardRedemption_orgId_idx" ON "GiftCardRedemption"("orgId");

-- CreateIndex
CREATE INDEX "Refund_purchaseId_idx" ON "Refund"("purchaseId");

-- CreateIndex
CREATE INDEX "Refund_orgId_idx" ON "Refund"("orgId");

-- CreateIndex
CREATE INDEX "OrderAdjustment_purchaseId_idx" ON "OrderAdjustment"("purchaseId");

-- CreateIndex
CREATE INDEX "OrderAdjustment_orgId_idx" ON "OrderAdjustment"("orgId");

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_kyteId_fkey" FOREIGN KEY ("kyteId") REFERENCES "Kyte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardLedger" ADD CONSTRAINT "GiftCardLedger_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardRedemption" ADD CONSTRAINT "GiftCardRedemption_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
