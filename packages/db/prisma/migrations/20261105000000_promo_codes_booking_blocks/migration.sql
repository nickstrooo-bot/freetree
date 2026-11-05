-- Promo codes per product + booking blocks on profiles.
-- allowPromoCodes: when true, Stripe Checkout shows a promo-code field for the
-- product. Sellers manage their codes in their own Stripe dashboard.
-- bookingBlocks: JSON array of {url, label, description} rendered as prominent
-- booking buttons on the public profile, following the links JSON pattern.
ALTER TABLE "Product" ADD COLUMN "allowPromoCodes" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Kyte" ADD COLUMN "bookingBlocks" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "PublishedKyte" ADD COLUMN "bookingBlocks" JSONB NOT NULL DEFAULT '[]';
