import { z } from "zod";
import { rejectControlChars } from "./content-policy";

// ─── Milestone meter ─────────────────────────────────────────────────────────
// A goal bar ("help me reach 100 supporters"). The goal is the ONLY thing
// stored. The count is NEVER stored and NEVER seller-typed: it is computed at
// read time from completed purchases (product sales + tips) for the kyte, so
// the number on the bar is always the real one. A kyte with no completed
// purchases reads 0 — that is correct and honest, not a bug.
// Null = no milestone meter on this profile.
export const MIN_MILESTONE_GOAL = 1;
export const MAX_MILESTONE_GOAL = 100_000;
export const MAX_MILESTONE_LABEL_LENGTH = 120;

export const milestoneSchema = z.object({
  goal: z.number().int().min(MIN_MILESTONE_GOAL).max(MAX_MILESTONE_GOAL),
  /** Optional label ("supporters", "sales", "cups of coffee"). Defaults to "supporters". */
  label: rejectControlChars(z.string().trim().min(1).max(MAX_MILESTONE_LABEL_LENGTH)).optional(),
});

export type Milestone = z.infer<typeof milestoneSchema>;
