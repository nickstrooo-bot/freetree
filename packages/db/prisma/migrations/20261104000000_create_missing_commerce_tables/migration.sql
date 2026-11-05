-- Create the tables for the commerce + email-capture models that exist in
-- schema.prisma but never got a migration upstream (they were created with
-- `db push` during development). Without these, the later
-- 20261105000000_promo_codes_booking_blocks migration fails with
-- `relation "Product" does not exist`. Timestamped before it so it applies first.
-- FreeTree, Nov 5 2026.

-- CreateTable
CREATE TABLE "EmailCaptureBlock" (
    "id" TEXT NOT NULL,
    "kyteId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "heading" TEXT NOT NULL DEFAULT 'Join my email list',
    "description" TEXT,
    "buttonText" TEXT NOT NULL DEFAULT 'Subscribe',
    "pendingText" TEXT NOT NULL DEFAULT 'Check your inbox to confirm your subscription.',
    "successText" TEXT NOT NULL DEFAULT 'You''re in! Thanks for subscribing.',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailCaptureBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSubscriber" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "kyteId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmToken" TEXT,
    "unsubscribeToken" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSubscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "kyteId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "fileKey" TEXT,
    "fileName" TEXT,
    "fileSizeBytes" INTEGER,
    "externalUrl" TEXT,
    "coverAssetId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kyteId" TEXT NOT NULL,
    "buyerEmail" TEXT,
    "stripeSessionId" TEXT NOT NULL,
    "stripePaymentIntent" TEXT,
    "amountCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "downloadToken" TEXT NOT NULL,
    "downloadExpiresAt" TIMESTAMP(3),
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeConnectAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeConnectAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailCaptureBlock_kyteId_key" ON "EmailCaptureBlock"("kyteId");

-- CreateIndex
CREATE INDEX "EmailCaptureBlock_orgId_idx" ON "EmailCaptureBlock"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSubscriber_confirmToken_key" ON "EmailSubscriber"("confirmToken");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSubscriber_unsubscribeToken_key" ON "EmailSubscriber"("unsubscribeToken");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSubscriber_blockId_email_key" ON "EmailSubscriber"("blockId", "email");

-- CreateIndex
CREATE INDEX "EmailSubscriber_kyteId_status_idx" ON "EmailSubscriber"("kyteId", "status");

-- CreateIndex
CREATE INDEX "EmailSubscriber_orgId_idx" ON "EmailSubscriber"("orgId");

-- CreateIndex
CREATE INDEX "Product_kyteId_active_sortOrder_idx" ON "Product"("kyteId", "active", "sortOrder");

-- CreateIndex
CREATE INDEX "Product_orgId_idx" ON "Product"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_stripeSessionId_key" ON "Purchase"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_downloadToken_key" ON "Purchase"("downloadToken");

-- CreateIndex
CREATE INDEX "Purchase_productId_idx" ON "Purchase"("productId");

-- CreateIndex
CREATE INDEX "Purchase_kyteId_idx" ON "Purchase"("kyteId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeConnectAccount_orgId_key" ON "StripeConnectAccount"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeConnectAccount_stripeAccountId_key" ON "StripeConnectAccount"("stripeAccountId");

-- AddForeignKey
ALTER TABLE "EmailCaptureBlock" ADD CONSTRAINT "EmailCaptureBlock_kyteId_fkey" FOREIGN KEY ("kyteId") REFERENCES "Kyte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSubscriber" ADD CONSTRAINT "EmailSubscriber_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "EmailCaptureBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_kyteId_fkey" FOREIGN KEY ("kyteId") REFERENCES "Kyte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
