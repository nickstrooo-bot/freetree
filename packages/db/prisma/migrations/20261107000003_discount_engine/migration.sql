-- Discount engine (Bagisto Cart/Catalog Rules + Saleor three-mechanism model,
-- rebuilt natively — MODELS ONLY, no platform code copied).
--
-- DiscountRule: one row per rule. kind "catalog" = automatic sale pricing
-- applied AT READ TIME by the engine (never a stored sale price, never a
-- reindex — Bagisto's reindex-on-save gotcha is the thing this avoids).
-- kind "cart" = checkout discount via the collectTotals() choke-point.
-- mechanism mirrors Saleor's shape: catalogue | order | voucher.
-- conditions/action are JSON so new condition/action types don't need a
-- migration; validated by discountRuleSchema in @kytelink/schemas.
--
-- Coupon: codes belong to a cart rule with trigger "coupon". usageCount is
-- bumped ONLY by the atomic conditional UPDATE in redeemCouponAtomic
-- (max_uses / is_active / date window / per-customer cap all in the WHERE
-- clause) — never read-check-write.
--
-- CouponRedemption: one row per successful redeem, for the per-customer cap
-- subquery and for audit. purchaseId is a plain string, not an FK: the
-- purchase row is deleted if Stripe session creation fails and the
-- redemption is released with it.
--
-- Purchase gains discountCents / couponCode / discountBreakdown so the
-- seller's sales list and the webhook-reconciled row agree with what the
-- buyer was actually charged (the DISCOUNTED total, not the list price).

-- CreateTable
CREATE TABLE "DiscountRule" (
    "id" TEXT NOT NULL,
    "kyteId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'cart',
    "mechanism" TEXT NOT NULL DEFAULT 'order',
    "trigger" TEXT NOT NULL DEFAULT 'automatic',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stopOtherRules" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "target" TEXT NOT NULL DEFAULT 'entire_order',
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "action" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "kyteId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,
    "maxUsesPerCustomer" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "generated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "buyerEmail" TEXT,
    "purchaseId" TEXT,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "couponCode" TEXT,
ADD COLUMN "discountBreakdown" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_orgId_code_key" ON "Coupon"("orgId", "code");

-- CreateIndex
CREATE INDEX "DiscountRule_orgId_active_idx" ON "DiscountRule"("orgId", "active");

-- CreateIndex
CREATE INDEX "DiscountRule_kyteId_kind_idx" ON "DiscountRule"("kyteId", "kind");

-- CreateIndex
CREATE INDEX "Coupon_ruleId_idx" ON "Coupon"("ruleId");

-- CreateIndex
CREATE INDEX "Coupon_orgId_active_idx" ON "Coupon"("orgId", "active");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_buyerEmail_idx" ON "CouponRedemption"("couponId", "buyerEmail");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_idx" ON "CouponRedemption"("couponId");

-- CreateIndex
CREATE INDEX "CouponRedemption_orgId_idx" ON "CouponRedemption"("orgId");

-- AddForeignKey
ALTER TABLE "DiscountRule" ADD CONSTRAINT "DiscountRule_kyteId_fkey" FOREIGN KEY ("kyteId") REFERENCES "Kyte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "DiscountRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
