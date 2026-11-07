import { z } from "zod";
import { getDb } from "@kytelink/db";
import { router } from "@kytelink/trpc";
import { kyte } from "../trpc/procedures";

// ─── FreeTree Tip Jar — concrete tRPC router ────────────────────────────────
// Seller-side list of tips received. The jar is configured through the normal
// draft flow (patchDraft with profileContent.tipJar); the public tip checkout
// lives in apps/api/src/routes/commerce.ts (Fastify) because it needs public
// access. Tips are Purchase rows joined to the kyte's hidden tip Product
// (Product.kind = "tip"); the webhook completes them like any other purchase.

export const tipJarRouter = router({
  listTips: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const k = ctx.access.kyte!;
      const where = {
        kyteId: k.id,
        status: "completed",
        product: { kind: "tip" },
      } as const;

      const rows = await db.purchase.findMany({
        where: {
          ...where,
          ...(input.cursor ? { createdAt: { lt: new Date(input.cursor) } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;

      const totals = await db.purchase.aggregate({
        where,
        _sum: { amountCents: true, feeCents: true },
        _count: { _all: true },
      });
      const gross = totals._sum.amountCents ?? 0;
      const fees = totals._sum.feeCents ?? 0;

      return {
        tips: page.map((t: (typeof page)[number]) => ({
          id: t.id,
          buyerEmail: t.buyerEmail,
          amountCents: t.amountCents,
          feeCents: t.feeCents,
          tipMessage: t.tipMessage,
          currency: t.currency,
          status: t.status,
          createdAt: t.createdAt.toISOString(),
        })),
        nextCursor: hasMore ? page[page.length - 1]!.createdAt.toISOString() : null,
        totals: {
          grossCents: gross,
          feesCents: fees,
          netCents: gross - fees,
          count: totals._count._all,
        },
      };
    }),
});
