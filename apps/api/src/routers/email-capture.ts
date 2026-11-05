import { z } from "zod";
import { getDb } from "@kytelink/db";
import { router } from "@kytelink/trpc";
import { TRPCError } from "@trpc/server";
import { kyte } from "../trpc/procedures";
import { assertCan } from "../trpc/permissions";
import { kyteIdInput, okSchema } from "./shapes";

// ─── FreeTree Email Capture — concrete tRPC router ──────────────────────────
// Owner-side block management + subscriber list + CSV export.
// Public signup, double opt-in confirmation, and unsubscribe live in
// apps/api/src/routes/email-capture.ts (Fastify) — they need public access.

const upsertBlockInput = z.object({
  kyteId: z.string().min(1),
  heading: z.string().trim().min(1).max(120).default("Join my email list"),
  description: z.string().trim().max(2000).nullable().optional(),
  buttonText: z.string().trim().min(1).max(40).default("Subscribe"),
  pendingText: z.string().trim().min(1).max(500).optional(),
  successText: z.string().trim().min(1).max(500).optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const listSubscribersInput = z.object({
  kyteId: z.string().min(1),
  status: z.enum(["pending", "confirmed", "unsubscribed", "all"]).default("confirmed"),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

function toBlockRow(b: any, subscriberCount: number) {
  return {
    id: b.id,
    kyteId: b.kyteId,
    heading: b.heading,
    description: b.description,
    buttonText: b.buttonText,
    pendingText: b.pendingText,
    successText: b.successText,
    active: b.active,
    sortOrder: b.sortOrder,
    subscriberCount,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

function toSubscriberRow(s: any) {
  return {
    id: s.id,
    email: s.email,
    status: s.status,
    confirmedAt: s.confirmedAt ? s.confirmedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  };
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export const emailCaptureRouter = router({
  getBlock: kyte.input(kyteIdInput).query(async ({ ctx }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const block = await db.emailCaptureBlock.findUnique({ where: { kyteId: k.id } });
    if (!block) return { block: null };
    const subscriberCount = await db.emailSubscriber.count({
      where: { blockId: block.id, status: "confirmed" },
    });
    return { block: toBlockRow(block, subscriberCount) };
  }),

  upsertBlock: kyte.input(upsertBlockInput).mutation(async ({ ctx, input }) => {
    assertCan(ctx.access.effectiveRole, "edit_draft");
    const db = getDb();
    const k = ctx.access.kyte!;
    const block = await db.emailCaptureBlock.upsert({
      where: { kyteId: k.id },
      create: {
        kyteId: k.id,
        orgId: k.orgId,
        heading: input.heading,
        description: input.description ?? null,
        buttonText: input.buttonText,
        pendingText: input.pendingText ?? "Check your inbox to confirm your subscription.",
        successText: input.successText ?? "You're in! Thanks for subscribing.",
        active: input.active,
        sortOrder: input.sortOrder,
      },
      update: {
        heading: input.heading,
        description: input.description ?? null,
        buttonText: input.buttonText,
        pendingText: input.pendingText ?? "Check your inbox to confirm your subscription.",
        successText: input.successText ?? "You're in! Thanks for subscribing.",
        active: input.active,
        sortOrder: input.sortOrder,
      },
    });
    const subscriberCount = await db.emailSubscriber.count({
      where: { blockId: block.id, status: "confirmed" },
    });
    return toBlockRow(block, subscriberCount);
  }),

  deleteBlock: kyte.input(kyteIdInput).mutation(async ({ ctx }) => {
    assertCan(ctx.access.effectiveRole, "edit_draft");
    const db = getDb();
    const k = ctx.access.kyte!;
    // Subscribers cascade-delete with the block (Prisma onDelete: Cascade).
    await db.emailCaptureBlock.deleteMany({ where: { kyteId: k.id } });
    return okSchema.parse({ ok: true });
  }),

  listSubscribers: kyte.input(listSubscribersInput).query(async ({ ctx, input }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const block = await db.emailCaptureBlock.findUnique({ where: { kyteId: k.id } });
    if (!block) return { subscribers: [], nextCursor: null };

    const where: any = { blockId: block.id };
    if (input.status !== "all") where.status = input.status;

    const rows = await db.emailSubscriber.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      subscribers: page.map(toSubscriberRow),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }),

  deleteSubscriber: kyte
    .input(z.object({ kyteId: z.string().min(1), subscriberId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const block = await db.emailCaptureBlock.findUnique({ where: { kyteId: k.id } });
      if (!block) throw new TRPCError({ code: "NOT_FOUND", message: "No email block." });
      await db.emailSubscriber.deleteMany({
        where: { id: input.subscriberId, blockId: block.id },
      });
      return okSchema.parse({ ok: true });
    }),

  exportCsv: kyte.input(kyteIdInput).query(async ({ ctx }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const block = await db.emailCaptureBlock.findUnique({ where: { kyteId: k.id } });
    if (!block) throw new TRPCError({ code: "NOT_FOUND", message: "No email block." });

    // Only confirmed subscribers export — pending ones never opted in.
    // Each row includes a one-click unsubscribe URL the owner can merge
    // into their email campaigns (we don't send campaigns ourselves).
    const subs = await db.emailSubscriber.findMany({
      where: { blockId: block.id, status: "confirmed" },
      orderBy: { confirmedAt: "asc" },
      select: { email: true, confirmedAt: true, unsubscribeToken: true },
    });

    const webBase = (
      process.env.PUBLIC_WEB_URL ??
      process.env.NEXT_PUBLIC_WEB_URL ??
      "https://freetree.link"
    ).replace(/\/$/, "");
    const lines = ["email,subscribed_at,unsubscribe_url"];
    for (const s of subs) {
      lines.push(
        [
          csvEscape(s.email),
          csvEscape(s.confirmedAt?.toISOString() ?? ""),
          csvEscape(`${webBase}/email/unsubscribe/${s.unsubscribeToken}`),
        ].join(","),
      );
    }
    const safeName = (k.username ?? "freetree").replace(/[^a-zA-Z0-9_-]/g, "_");
    return { csv: lines.join("\n"), filename: `${safeName}-subscribers.csv` };
  }),
});
