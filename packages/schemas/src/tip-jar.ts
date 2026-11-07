import { z } from "zod";

// ─── Tip jar ─────────────────────────────────────────────────────────────────
// A tip jar is a "leave a tip" block on a seller's public profile: preset
// amounts ($3/$5/$10 by default) that a visitor can send with no product file
// and no download. It is the thinnest extension of FreeTree Commerce — a tip
// reuses the existing Stripe Checkout path unchanged, with the same 4%-on-net
// fee (computeFeeCents) as a product sale.
//
// Storage follows the bookingBlocks pattern: one nullable `tipJar` field on
// profileContent, mirrored to a `tipJar` JSON column on Kyte and PublishedKyte.
// The seller edits it through the normal draft flow (patchDraft); there is no
// separate upsert procedure. Tips received are listed via the tipJar tRPC
// router, which reads Purchase rows joined to the kyte's hidden tip Product.
//
// Open-core note: the tip jar is a NEW money-making differentiator. Everything
// tip-specific lives in its own files (this schema, the tip-jar tRPC router +
// API router, the tip-jar UI block, tip-fetch.ts) plus small hooks in the
// commerce routes / profile view / products tab, so it can be split into the
// closed layer later if Nick decides that. No licensing call is made here.

export const MIN_TIP_CENTS = 50; // $0.50 — Stripe's minimum for a Checkout session
export const MAX_TIP_CENTS = 1_000_000; // $10,000
export const MAX_TIP_AMOUNTS = 5;
export const MAX_TIP_HEADING_LENGTH = 120;
export const MAX_TIP_MESSAGE_LENGTH = 500;

/** Default presets: $3 / $5 / $10. */
export const DEFAULT_TIP_AMOUNTS_CENTS = [300, 500, 1000] as const;

export const tipJarSchema = z.object({
  heading: z.string().trim().min(1).max(MAX_TIP_HEADING_LENGTH).default("Leave a tip"),
  /** Optional note shown under the heading ("Support my work", etc.). */
  message: z.string().trim().max(MAX_TIP_MESSAGE_LENGTH).optional(),
  /** Preset amounts in cents. Sorted ascending, unique, 1–5 entries. */
  amountsCents: z
    .array(z.number().int().min(MIN_TIP_CENTS).max(MAX_TIP_CENTS))
    .min(1)
    .max(MAX_TIP_AMOUNTS)
    .default([...DEFAULT_TIP_AMOUNTS_CENTS])
    .refine((amounts) => new Set(amounts).size === amounts.length, {
      message: "Tip amounts must be unique.",
    })
    .refine((amounts) => amounts.every((a, i) => i === 0 || a > amounts[i - 1]!), {
      message: "Tip amounts must be sorted ascending.",
    }),
  active: z.boolean().default(true),
});

export type TipJar = z.infer<typeof tipJarSchema>;

/** A tip jar with defaults applied — what the editor starts from. */
export function emptyTipJar(): TipJar {
  return tipJarSchema.parse({});
}
