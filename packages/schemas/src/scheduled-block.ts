import { z } from "zod";
import { safeWebUrlSchema } from "./content-policy";

// ─── Scheduled blocks ─────────────────────────────────────────────────────────
// A scheduled block is a link button that goes live at a moment (startsAt),
// optionally disappears at another (endsAt), and counts down until it opens.
// Stored as a JSON array on the Kyte, following the bookingBlocks pattern.
// The countdown/unlock behavior is Kitab-Link's countdown-link-card pattern
// (locked card with a live digital countdown, live link after the moment).

export const MAX_SCHEDULED_LABEL_LENGTH = 60;
export const MAX_SCHEDULED_DESCRIPTION_LENGTH = 200;
export const MAX_PROFILE_SCHEDULED_BLOCKS = 20;

export const scheduledBlockSchema = z.object({
  url: safeWebUrlSchema,
  label: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SCHEDULED_LABEL_LENGTH)
    .default("Coming soon"),
  description: z.string().trim().max(MAX_SCHEDULED_DESCRIPTION_LENGTH).optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable().default(null),
  showCountdown: z.boolean().default(true),
});

export type ScheduledBlock = z.infer<typeof scheduledBlockSchema>;
