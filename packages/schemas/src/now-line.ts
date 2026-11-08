import { z } from "zod";
import { rejectControlChars } from "./content-policy";

// ─── Now line ────────────────────────────────────────────────────────────────
// A short "what I'm up to this week" sentence, with the date it was written.
// Stored as one nullable JSON column on Kyte/PublishedKyte (same pattern as
// tipJar/liveBadge). updatedAt is an ISO date string, stamped by the editor
// when the seller saves the line — the public page renders it as the date the
// line was written, so a stale line is visibly stale. Null = no now line.
export const MAX_NOW_LINE_LENGTH = 280;

export const nowLineSchema = z.object({
  text: rejectControlChars(z.string().trim().min(1).max(MAX_NOW_LINE_LENGTH)),
  updatedAt: z.string().datetime({ offset: true }),
});

export type NowLine = z.infer<typeof nowLineSchema>;
