import { z } from "zod";
import { rejectControlChars } from "./content-policy";

// ─── About / story block ─────────────────────────────────────────────────────
// The seller's "who I am" — a few lines shown at the top of the public
// profile, above the links, next to the seller photo (the avatar from the
// Design tab — the about block reuses it, there is no second photo upload).
// Stored as a plain nullable TEXT column on Kyte/PublishedKyte (like
// description), not JSON: it is a single string, so it gets the simple shape.
// Null = no about block on this profile.
export const MAX_ABOUT_LENGTH = 1000;

export const aboutSchema = rejectControlChars(z.string().trim().max(MAX_ABOUT_LENGTH));

export type About = z.infer<typeof aboutSchema>;
