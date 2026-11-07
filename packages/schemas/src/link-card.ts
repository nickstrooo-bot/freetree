import { z } from "zod";
import { hasControlChars, safeWebUrlSchema } from "./content-policy";

// ─── Photo link-card (LinkPage pattern, BSD-2-Clause) ────────────────────────
// LinkPage (github.com/rhnvrm/linkpage, LICENSE file: BSD-2-Clause — its
// README wrongly says MIT) auto-fetches a pasted URL's OpenGraph metadata and
// pre-fills a rich link card. LinkPage is Go — wrong stack for FreeTree — so
// only the *logic* is rebuilt here: the fetch + parse live in
// apps/api/src/link-card/open-graph.ts, the editor endpoint is the
// linkCard.fetch tRPC mutation, and this file is the stored shape.
//
// A card is OpenGraph metadata captured at link-add time and stored on the
// Link itself (links are a JSON array on Kyte — no new table, no migration).
// The og:image is rendered as an <img src> in the *visitor's* browser, never
// fetched server-side after capture, so it carries no SSRF surface; it is
// still validated as an http(s) URL here. At least one of title /
// description / image must be present — an empty card is no card at all.

export const MAX_LINK_CARD_TITLE_LENGTH = 200;
export const MAX_LINK_CARD_DESCRIPTION_LENGTH = 300;

const linkCardTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_LINK_CARD_TITLE_LENGTH)
  .refine((value) => !hasControlChars(value), {
    message: "must not contain control characters",
  });

const linkCardDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_LINK_CARD_DESCRIPTION_LENGTH)
  .refine((value) => !hasControlChars(value), {
    message: "must not contain control characters",
  });

export const linkCardSchema = z
  .object({
    /** og:title (or <title> fallback) as fetched, truncated to 200 chars. */
    title: linkCardTitleSchema.optional(),
    /** og:description (or meta description fallback), truncated to 300 chars. */
    description: linkCardDescriptionSchema.optional(),
    /** og:image, resolved to an absolute http(s) URL at fetch time. */
    image: safeWebUrlSchema.optional(),
    /** When the metadata was fetched (ISO 8601) — for future refresh/staleness. */
    fetchedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine(
    (card) =>
      card.title !== undefined ||
      card.description !== undefined ||
      card.image !== undefined,
    { message: "link card must carry at least a title, a description, or an image" },
  );

export type LinkCard = z.infer<typeof linkCardSchema>;

/** Input to the linkCard.fetch mutation: the URL the seller pasted. */
export const linkCardFetchInputSchema = z.object({
  url: safeWebUrlSchema,
});

export type LinkCardFetchInput = z.infer<typeof linkCardFetchInputSchema>;

/**
 * Output of linkCard.fetch. `card` is null when the URL fetched but carried
 * no usable OpenGraph metadata (or the fetch failed — the editor treats a
 * missing preview as "keep the manual title", never as a save error).
 * `fetchedUrl` is the final URL after redirects, so the editor can show
 * where the card actually came from.
 */
export const linkCardFetchResultSchema = z.object({
  card: linkCardSchema.nullable(),
  fetchedUrl: z.string(),
});

export type LinkCardFetchResult = z.infer<typeof linkCardFetchResultSchema>;
