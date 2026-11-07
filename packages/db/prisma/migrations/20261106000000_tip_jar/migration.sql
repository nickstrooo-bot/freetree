-- Tip jar: a "leave a tip" block on a seller's public profile.
-- tipJar: nullable JSON config on Kyte + PublishedKyte, mirroring
-- profileContent.tipJar (same JSON pattern as bookingBlocks). Null = no jar.
-- Product.kind: "digital" (default) or "tip". A tip jar's backing row is a
-- hidden Product with kind "tip" (one per kyte, active=false so it never
-- appears in the store); tip Purchases carry the chosen preset amount.
-- Purchase.tipMessage: optional message the buyer left with a tip.

ALTER TABLE "Kyte" ADD COLUMN "tipJar" JSONB;

ALTER TABLE "PublishedKyte" ADD COLUMN "tipJar" JSONB;

ALTER TABLE "Product" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'digital';

ALTER TABLE "Purchase" ADD COLUMN "tipMessage" TEXT;
