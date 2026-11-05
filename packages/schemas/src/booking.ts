import { z } from "zod";
import { safeWebUrlSchema } from "./content-policy";

// ─── Booking blocks ─────────────────────────────────────────────────────────
// A booking block is a prominent "Book now" button pointing at the seller's
// external scheduling page (Calendly, Cal.com, etc.). Stored as a JSON array
// on the Kyte, following the links pattern.

export const MAX_BOOKING_LABEL_LENGTH = 60;
export const MAX_BOOKING_DESCRIPTION_LENGTH = 200;
export const MAX_PROFILE_BOOKING_BLOCKS = 20;

export const bookingBlockSchema = z.object({
  url: safeWebUrlSchema,
  label: z.string().trim().min(1).max(MAX_BOOKING_LABEL_LENGTH).default("Book now"),
  description: z.string().trim().max(MAX_BOOKING_DESCRIPTION_LENGTH).optional(),
});

export type BookingBlock = z.infer<typeof bookingBlockSchema>;
