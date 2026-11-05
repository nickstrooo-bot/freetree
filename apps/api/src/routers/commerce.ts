import { randomBytes } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { z } from "zod";
import { getDb } from "@kytelink/db";
import { router } from "@kytelink/trpc";
import { TRPCError } from "@trpc/server";
import { kyte } from "../trpc/procedures";
import { assertCan } from "../trpc/permissions";
import { kyteIdInput, okSchema } from "./shapes";
import {
  getOrCreateConnectAccount,
  createOnboardingLink as stripeOnboardingLink,
  getStripeClient,
  isStripeConfigured,
  refreshAccountStatus,
} from "../commerce/stripe";

// ─── FreeTree Commerce — concrete tRPC router ───────────────────────────────
// Seller-side product management + Stripe Connect onboarding. Buyer-facing
// checkout, webhooks, and downloads live in apps/api/src/routes/commerce.ts
// (Fastify) because they need public access and raw-body handling.

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB cap on digital deliverables

function filesDir(): string {
  return process.env.COMMERCE_FILES_DIR ?? join(process.cwd(), "data", "commerce-files");
}

function toProductRow(p: any) {
  return {
    id: p.id,
    kyteId: p.kyteId,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    currency: p.currency,
    fileName: p.fileName,
    fileSizeBytes: p.fileSizeBytes,
    hasFile: Boolean(p.fileKey),
    externalUrl: p.externalUrl,
    active: p.active,
    allowPromoCodes: p.allowPromoCodes ?? false,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Write a base64 file payload to local disk. Returns {fileKey, fileSizeBytes}. */
async function storeUploadedFile(productId: string, fileName: string, fileBase64: string): Promise<{ fileKey: string; fileSizeBytes: number }> {
  const buffer = Buffer.from(fileBase64, "base64");
  if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `File must be between 1 byte and ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
    });
  }
  const dir = filesDir();
  await mkdir(dir, { recursive: true });
  const safe = basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
  const fileKey = `${productId}-${randomBytes(8).toString("hex")}-${safe}`;
  await writeFile(join(dir, fileKey), buffer);
  return { fileKey, fileSizeBytes: buffer.length };
}

const createProductInput = z.object({
  kyteId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  priceCents: z.number().int().min(50).max(10000000),
  currency: z.string().trim().toLowerCase().default("usd"),
  fileBase64: z.string().max(35_000_000).optional(),
  fileName: z.string().trim().max(255).optional(),
  externalUrl: z.string().trim().url().max(2048).optional(),
  allowPromoCodes: z.boolean().default(false),
});

const updateProductInput = z.object({
  kyteId: z.string().min(1),
  productId: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  priceCents: z.number().int().min(50).max(10000000).optional(),
  fileBase64: z.string().max(35_000_000).nullable().optional(),
  fileName: z.string().trim().max(255).nullable().optional(),
  externalUrl: z.string().trim().url().max(2048).nullable().optional(),
  active: z.boolean().optional(),
  allowPromoCodes: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const commerceRouter = router({
  listProducts: kyte.input(kyteIdInput).query(async ({ ctx }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const products = await db.product.findMany({
      where: { kyteId: k.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    return { products: products.map(toProductRow) };
  }),

  createProduct: kyte.input(createProductInput).mutation(async ({ ctx, input }) => {
    assertCan(ctx.access.effectiveRole, "edit_draft");
    const db = getDb();
    const k = ctx.access.kyte!;
    const orgId = k.orgId;

    if (!input.fileBase64 && !input.externalUrl) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Provide either an uploaded file or an external download URL.",
      });
    }

    const product = await db.product.create({
      data: {
        kyteId: k.id,
        orgId,
        name: input.name,
        description: input.description ?? null,
        priceCents: input.priceCents,
        currency: input.currency,
        externalUrl: input.externalUrl ?? null,
        allowPromoCodes: input.allowPromoCodes,
      },
    });

    if (input.fileBase64) {
      const { fileKey, fileSizeBytes } = await storeUploadedFile(
        product.id,
        input.fileName ?? "download",
        input.fileBase64,
      );
      const updated = await db.product.update({
        where: { id: product.id },
        data: { fileKey, fileName: input.fileName ?? "download", fileSizeBytes },
      });
      return toProductRow(updated);
    }
    return toProductRow(product);
  }),

  updateProduct: kyte.input(updateProductInput).mutation(async ({ ctx, input }) => {
    assertCan(ctx.access.effectiveRole, "edit_draft");
    const db = getDb();
    const k = ctx.access.kyte!;

    const existing = await db.product.findFirst({
      where: { id: input.productId, kyteId: k.id },
    });
    if (!existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.priceCents !== undefined) data.priceCents = input.priceCents;
    if (input.externalUrl !== undefined) data.externalUrl = input.externalUrl;
    if (input.active !== undefined) data.active = input.active;
    if (input.allowPromoCodes !== undefined) data.allowPromoCodes = input.allowPromoCodes;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    // Replace the stored file when a new one is uploaded.
    if (input.fileBase64) {
      if (existing.fileKey) {
        await unlink(join(filesDir(), existing.fileKey)).catch(() => undefined);
      }
      const { fileKey, fileSizeBytes } = await storeUploadedFile(
        existing.id,
        input.fileName ?? existing.fileName ?? "download",
        input.fileBase64,
      );
      data.fileKey = fileKey;
      data.fileName = input.fileName ?? existing.fileName ?? "download";
      data.fileSizeBytes = fileSizeBytes;
    } else if (input.fileBase64 === null && existing.fileKey) {
      // Explicit null clears the stored file.
      await unlink(join(filesDir(), existing.fileKey)).catch(() => undefined);
      data.fileKey = null;
      data.fileName = null;
      data.fileSizeBytes = null;
    }
    if (input.fileName !== undefined && input.fileName !== null && !input.fileBase64) {
      data.fileName = input.fileName;
    }

    const updated = await db.product.update({ where: { id: existing.id }, data });
    return toProductRow(updated);
  }),

  deleteProduct: kyte
    .input(z.object({ kyteId: z.string().min(1), productId: z.string().min(1) }))
    .output(okSchema)
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const existing = await db.product.findFirst({
        where: { id: input.productId, kyteId: k.id },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
      }
      if (existing.fileKey) {
        await unlink(join(filesDir(), existing.fileKey)).catch(() => undefined);
      }
      await db.product.delete({ where: { id: existing.id } });
      return { ok: true as const };
    }),

  getConnectStatus: kyte.input(kyteIdInput).query(async ({ ctx }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const configured = isStripeConfigured();
    if (!configured) {
      return {
        configured: false,
        connected: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      };
    }
    const record = await db.stripeConnectAccount.findUnique({ where: { orgId: k.orgId } });
    if (!record) {
      return {
        configured: true,
        connected: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
      };
    }
    // Refresh flags from Stripe so the dashboard never shows stale state.
    try {
      const stripe = getStripeClient();
      if (stripe) {
        const status = await refreshAccountStatus(stripe, record.stripeAccountId);
        await db.stripeConnectAccount.update({
          where: { id: record.id },
          data: status,
        });
        return { configured: true, connected: status.detailsSubmitted, ...status };
      }
    } catch {
      // Fall through to stored flags on Stripe API failure.
    }
    return {
      configured: true,
      connected: record.detailsSubmitted,
      chargesEnabled: record.chargesEnabled,
      payoutsEnabled: record.payoutsEnabled,
      detailsSubmitted: record.detailsSubmitted,
    };
  }),

  createOnboardingLink: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        returnUrl: z.string().url(),
        refreshUrl: z.string().url(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const stripe = getStripeClient();
      if (!stripe) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Stripe is not configured. Set STRIPE_SECRET_KEY to enable commerce.",
        });
      }
      const db = getDb();
      const k = ctx.access.kyte!;
      const existing = await db.stripeConnectAccount.findUnique({ where: { orgId: k.orgId } });

      const { stripeAccountId } = await getOrCreateConnectAccount(
        stripe,
        k.orgId,
        ctx.user.email,
        existing?.stripeAccountId ?? null,
      );

      if (!existing) {
        await db.stripeConnectAccount.create({
          data: { orgId: k.orgId, stripeAccountId },
        });
      }

      const url = await stripeOnboardingLink(stripe, stripeAccountId, input.returnUrl, input.refreshUrl);
      return { url };
    }),

  getSales: kyte
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
      const where = { kyteId: k.id, status: "completed" } as const;

      const rows = await db.purchase.findMany({
        where: {
          ...where,
          ...(input.cursor ? { createdAt: { lt: new Date(input.cursor) } } : {}),
        },
        include: { product: { select: { name: true } } },
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
        sales: page.map((s: (typeof page)[number]) => ({
          id: s.id,
          productId: s.productId,
          productName: s.product.name,
          buyerEmail: s.buyerEmail,
          amountCents: s.amountCents,
          feeCents: s.feeCents,
          currency: s.currency,
          status: s.status,
          createdAt: s.createdAt.toISOString(),
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
