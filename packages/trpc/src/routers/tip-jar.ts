import { z } from "zod";
import { kyteProcedure, router } from "../trpc";
import { notImplemented } from "../errors";

// ─── FreeTree Tip Jar contract ───────────────────────────────────────────────
// Seller-side list of tips received on a kyte. The jar itself is configured
// through the normal draft flow (patchDraft with profileContent.tipJar), like
// bookingBlocks — there is no upsert procedure here. Every procedure throws
// notImplemented; the concrete implementation lives in
// apps/api/src/routers/tip-jar.ts and must conform to these shapes.

export const tipSchema = z.object({
  id: z.string(),
  buyerEmail: z.string().nullable(),
  amountCents: z.number().int(),
  feeCents: z.number().int(),
  tipMessage: z.string().nullable(),
  currency: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

export type Tip = z.infer<typeof tipSchema>;

export const tipJarRouter = router({
  // ── Seller: tips received ───────────────────────────────────────────────

  listTips: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      }),
    )
    .output(
      z.object({
        tips: z.array(tipSchema),
        nextCursor: z.string().nullable(),
        totals: z.object({
          grossCents: z.number().int(),
          feesCents: z.number().int(),
          netCents: z.number().int(),
          count: z.number().int(),
        }),
      }),
    )
    .query(() => {
      throw notImplemented("tipJar.listTips");
    }),
});
