-- Scheduled blocks: link buttons that go live at startsAt, optionally expire
-- at endsAt, and count down until they open. Same JSON-array pattern as
-- bookingBlocks (see 20261105000000_promo_codes_booking_blocks): one JSONB
-- column on Kyte (draft) and one on PublishedKyte (mirrored at publish time).
-- Evaluation happens at render time (see packages/schemas/src/scheduled-data.ts),
-- so no stored visibility state is needed.
ALTER TABLE "Kyte" ADD COLUMN "scheduledBlocks" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "PublishedKyte" ADD COLUMN "scheduledBlocks" JSONB NOT NULL DEFAULT '[]';
