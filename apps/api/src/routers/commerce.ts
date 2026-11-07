import { randomBytes } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { z } from "zod";
import { getDb } from "@kytelink/db";
import {
  createCouponInputSchema,
  discountActionSchema,
  discountConditionsSchema,
  discountRuleInputSchema,
  discountRuleKindSchema,
  discountRuleSchema,
  discountTargetSchema,
  discountTriggerSchema,
  generateCouponsInputSchema,
  giftCardIssueInputSchema,
  giftCardReloadInputSchema,
  MAX_RULE_NAME_LENGTH,
  MAX_RULE_PRIORITY,
  mechanismForRule,
} from "@kytelink/schemas";
import { router } from "@kytelink/trpc";
import { TRPCError } from "@trpc/server";
import { kyte } from "../trpc/procedures";
import { assertCan } from "../trpc/permissions";
import { kyteIdInput, okSchema } from "./shapes";
import {
  computeFeeCents,
  getOrCreateConnectAccount,
  createOnboardingLink as stripeOnboardingLink,
  getStripeClient,
  isStripeConfigured,
  refreshAccountStatus,
} from "../commerce/stripe";
import {
  applyCatalogRules,
  collectTotals,
  CouponResolutionError,
  generateCouponCodes,
  resolveCoupon,
} from "../commerce/discounts";
import {
  applyGiftCardToTotals,
  GiftCardResolutionError,
  issueGiftCards,
  resolveGiftCardByCode,
  updateGiftCardBalance,
} from "../commerce/gift-cards";

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
    kind: p.kind ?? "digital",
    active: p.active,
    allowPromoCodes: p.allowPromoCodes ?? false,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// ─── Gift cards — row serializers ────────────────────────────────────────────
// The plaintext code is NEVER serialized: only the 4-char hint leaves the
// server (the full code exists only in the issue mutation's response).

function toGiftCardRow(c: any) {
  return {
    id: c.id,
    kyteId: c.kyteId,
    orgId: c.orgId,
    codeHint: c.codeHint,
    currency: c.currency,
    initialBalanceCents: c.initialBalanceCents,
    balanceCents: c.balanceCents,
    status: c.status,
    isReloadable: c.isReloadable,
    issuedTo: c.issuedTo ?? null,
    expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function toGiftCardLedgerRow(l: any) {
  return {
    id: l.id,
    giftCardId: l.giftCardId,
    kind: l.kind,
    amountCents: l.amountCents,
    balanceAfterCents: l.balanceAfterCents,
    purchaseId: l.purchaseId ?? null,
    note: l.note ?? null,
    createdAt: l.createdAt.toISOString(),
  };
}

// ─── Discount engine — row serializers + guards ──────────────────────────────

function toDiscountRuleRow(r: any, couponCount: number) {
  return {
    id: r.id,
    kyteId: r.kyteId,
    orgId: r.orgId,
    name: r.name,
    kind: r.kind,
    mechanism: r.mechanism,
    trigger: r.trigger,
    active: r.active,
    priority: r.priority,
    stopOtherRules: r.stopOtherRules,
    startsAt: r.startsAt ? r.startsAt.toISOString() : null,
    endsAt: r.endsAt ? r.endsAt.toISOString() : null,
    target: r.target,
    conditions: r.conditions,
    action: r.action,
    couponCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toCouponRow(c: any) {
  return {
    id: c.id,
    kyteId: c.kyteId,
    orgId: c.orgId,
    ruleId: c.ruleId,
    code: c.code,
    usageCount: c.usageCount,
    maxUses: c.maxUses,
    maxUsesPerCustomer: c.maxUsesPerCustomer,
    startsAt: c.startsAt ? c.startsAt.toISOString() : null,
    endsAt: c.endsAt ? c.endsAt.toISOString() : null,
    active: c.active,
    generated: c.generated,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Coupons only attach to cart rules with trigger "coupon" (Saleor vouchers). */
async function requireCouponRule(db: any, orgId: string, ruleId: string): Promise<any> {
  const rule = await db.discountRule.findFirst({ where: { id: ruleId, orgId } });
  if (!rule) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Discount rule not found." });
  }
  if (rule.kind !== "cart" || rule.trigger !== "coupon") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Coupons can only be added to a cart rule with trigger \"coupon\".",
    });
  }
  return rule;
}

/** A GIFT reward must point at a real digital product of the same seller. */
async function assertGiftProduct(db: any, orgId: string, action: any): Promise<void> {
  if (action?.type !== "gift") return;
  const gift = await db.product.findFirst({
    where: { id: action.giftProductId, orgId, kind: "digital" },
  });
  if (!gift) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Gift product not found for this seller.",
    });
  }
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
      // The tip jar's hidden backing row (kind "tip") is managed through the
      // tip jar, never through the product editor — keep it out of this list.
      where: { kyteId: k.id, kind: "digital" },
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

  // ── Discount engine — seller-side rules, coupons, and preview ─────────────
  // Bagisto Cart/Catalog Rules + Saleor's catalogue/order/voucher shape,
  // rebuilt natively. Catalog rules price products at READ time (the
  // listing + checkout both run applyCatalogRules); cart rules discount at
  // checkout via collectTotals(), the one totals choke-point. Everything
  // here is org-scoped: a seller can only ever touch their own rules.

  listDiscountRules: kyte.input(kyteIdInput).query(async ({ ctx }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const rules = await db.discountRule.findMany({
      where: { orgId: k.orgId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
    const coupons = await db.coupon.findMany({
      where: { orgId: k.orgId },
      select: { ruleId: true },
    });
    const counts = new Map<string, number>();
    for (const c of coupons) counts.set(c.ruleId, (counts.get(c.ruleId) ?? 0) + 1);
    return { rules: rules.map((r: any) => toDiscountRuleRow(r, counts.get(r.id) ?? 0)) };
  }),

  createDiscountRule: kyte
    .input(z.object({ kyteId: z.string().min(1), rule: discountRuleInputSchema }))
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const r = input.rule;
      // Cross-field checks (mechanism consistency, catalog-action limits,
      // date order) run on the full row candidate, not just the input.
      const candidate = {
        id: "new",
        kyteId: k.id,
        orgId: k.orgId,
        name: r.name,
        kind: r.kind,
        mechanism: mechanismForRule(r.kind, r.trigger),
        trigger: r.trigger,
        active: r.active,
        priority: r.priority,
        stopOtherRules: r.stopOtherRules,
        startsAt: r.startsAt ?? null,
        endsAt: r.endsAt ?? null,
        target: r.target,
        conditions: r.conditions,
        action: r.action,
      };
      const checked = discountRuleSchema.safeParse(candidate);
      if (!checked.success) {
        throw new TRPCError({ code: "BAD_REQUEST", message: checked.error.issues[0]?.message ?? "Invalid rule." });
      }
      await assertGiftProduct(db, k.orgId, r.action);
      const created = await db.discountRule.create({
        data: {
          kyteId: k.id,
          orgId: k.orgId,
          name: r.name,
          kind: r.kind,
          mechanism: candidate.mechanism,
          trigger: r.trigger,
          active: r.active,
          priority: r.priority,
          stopOtherRules: r.stopOtherRules,
          startsAt: r.startsAt ?? null,
          endsAt: r.endsAt ?? null,
          target: r.target,
          conditions: r.conditions,
          action: r.action,
        },
      });
      return toDiscountRuleRow(created, 0);
    }),

  updateDiscountRule: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        ruleId: z.string().min(1),
        patch: z.object({
          name: z.string().trim().min(1).max(MAX_RULE_NAME_LENGTH).optional(),
          kind: discountRuleKindSchema.optional(),
          trigger: discountTriggerSchema.optional(),
          active: z.boolean().optional(),
          priority: z.number().int().min(0).max(MAX_RULE_PRIORITY).optional(),
          stopOtherRules: z.boolean().optional(),
          startsAt: z.date().nullable().optional(),
          endsAt: z.date().nullable().optional(),
          target: discountTargetSchema.optional(),
          // Whole-object replace, not a deep merge.
          conditions: discountConditionsSchema.optional(),
          action: discountActionSchema.optional(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const existing = await db.discountRule.findFirst({
        where: { id: input.ruleId, orgId: k.orgId },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Discount rule not found." });
      }
      const merged = { ...existing, ...input.patch };
      merged.mechanism = mechanismForRule(merged.kind, merged.trigger);
      const checked = discountRuleSchema.safeParse(merged);
      if (!checked.success) {
        throw new TRPCError({ code: "BAD_REQUEST", message: checked.error.issues[0]?.message ?? "Invalid rule." });
      }
      if (input.patch.action) await assertGiftProduct(db, k.orgId, input.patch.action);
      const updated = await db.discountRule.update({
        where: { id: existing.id },
        data: {
          name: checked.data.name,
          kind: checked.data.kind,
          mechanism: checked.data.mechanism,
          trigger: checked.data.trigger,
          active: checked.data.active,
          priority: checked.data.priority,
          stopOtherRules: checked.data.stopOtherRules,
          startsAt: checked.data.startsAt,
          endsAt: checked.data.endsAt,
          target: checked.data.target,
          conditions: checked.data.conditions,
          action: checked.data.action,
        },
      });
      const couponCount = await db.coupon.count({ where: { ruleId: existing.id } });
      return toDiscountRuleRow(updated, couponCount);
    }),

  deleteDiscountRule: kyte
    .input(z.object({ kyteId: z.string().min(1), ruleId: z.string().min(1) }))
    .output(okSchema)
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const existing = await db.discountRule.findFirst({
        where: { id: input.ruleId, orgId: k.orgId },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Discount rule not found." });
      }
      // Coupons + redemptions cascade via FK. Past purchases keep their
      // discountCents/couponCode audit fields — they never point at the rule.
      await db.discountRule.delete({ where: { id: existing.id } });
      return { ok: true as const };
    }),

  listCoupons: kyte
    .input(z.object({ kyteId: z.string().min(1), ruleId: z.string().min(1).optional() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const k = ctx.access.kyte!;
      const coupons = await db.coupon.findMany({
        where: { orgId: k.orgId, ...(input.ruleId ? { ruleId: input.ruleId } : {}) },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const rules = await db.discountRule.findMany({
        where: { orgId: k.orgId },
        select: { id: true, name: true },
      });
      const names = new Map(rules.map((r: any) => [r.id, r.name]));
      return {
        coupons: coupons.map((c: any) => ({
          ...toCouponRow(c),
          ruleName: names.get(c.ruleId) ?? null,
        })),
      };
    }),

  createCoupon: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        ruleId: z.string().min(1),
        coupon: createCouponInputSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const rule = await requireCouponRule(db, k.orgId, input.ruleId);
      const c = input.coupon;
      try {
        const created = await db.coupon.create({
          data: {
            kyteId: k.id,
            orgId: k.orgId,
            ruleId: rule.id,
            code: c.code,
            maxUses: c.maxUses ?? null,
            maxUsesPerCustomer: c.maxUsesPerCustomer ?? null,
            startsAt: c.startsAt ?? null,
            endsAt: c.endsAt ?? null,
            active: c.active,
            generated: false,
          },
        });
        return toCouponRow(created);
      } catch (error: any) {
        if (error?.code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Code ${c.code} already exists for this seller.`,
          });
        }
        throw error;
      }
    }),

  generateCoupons: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        ruleId: z.string().min(1),
        options: generateCouponsInputSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const rule = await requireCouponRule(db, k.orgId, input.ruleId);
      const o = input.options;
      const codes = generateCouponCodes(o);
      const now = new Date();
      const result = await db.coupon.createMany({
        data: codes.map((code) => ({
          kyteId: k.id,
          orgId: k.orgId,
          ruleId: rule.id,
          code,
          maxUses: o.maxUses ?? null,
          maxUsesPerCustomer: o.maxUsesPerCustomer ?? null,
          startsAt: o.startsAt ?? null,
          endsAt: o.endsAt ?? null,
          active: true,
          generated: true,
        })),
        skipDuplicates: true,
      });
      // skipDuplicates silently drops codes that already exist for this org
      // (cross-batch collisions). The caller sees the shortfall in
      // `collisions` and can generate again; every returned code is usable
      // for this rule.
      return {
        codes,
        requested: codes.length,
        created: result.count,
        collisions: codes.length - result.count,
        generatedAt: now.toISOString(),
      };
    }),

  setCouponActive: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        couponId: z.string().min(1),
        active: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const existing = await db.coupon.findFirst({
        where: { id: input.couponId, orgId: k.orgId },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Coupon not found." });
      }
      const updated = await db.coupon.update({
        where: { id: existing.id },
        data: { active: input.active },
      });
      return toCouponRow(updated);
    }),

  // ── Gift cards — seller-side issue, list, detail, reload, toggle ─────────
  // Saleor's model (currency-based balance, bulk creation) + the blamejs
  // ledger + Stacks state machine, rebuilt natively. Everything here is
  // org-scoped: a seller can only ever touch their own cards. The issue
  // response is the ONLY place a plaintext code appears — the seller must
  // show or send it now, because it is never stored and never recoverable.

  listGiftCards: kyte.input(kyteIdInput).query(async ({ ctx }) => {
    const db = getDb();
    const k = ctx.access.kyte!;
    const cards = await db.giftCard.findMany({
      where: { orgId: k.orgId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { giftCards: cards.map((c: any) => toGiftCardRow(c)) };
  }),

  issueGiftCards: kyte
    .input(z.object({ kyteId: z.string().min(1), issue: giftCardIssueInputSchema }))
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const cards = await issueGiftCards(db, {
        kyteId: k.id,
        orgId: k.orgId,
        issue: input.issue,
      });
      return { cards };
    }),

  getGiftCard: kyte
    .input(z.object({ kyteId: z.string().min(1), giftCardId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const k = ctx.access.kyte!;
      const card = await db.giftCard.findFirst({
        where: { id: input.giftCardId, orgId: k.orgId },
      });
      if (!card) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Gift card not found." });
      }
      const ledger = await db.giftCardLedger.findMany({
        where: { giftCardId: card.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return { giftCard: toGiftCardRow(card), ledger: ledger.map((l: any) => toGiftCardLedgerRow(l)) };
    }),

  reloadGiftCard: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        giftCardId: z.string().min(1),
        amountCents: giftCardReloadInputSchema.shape.amountCents,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const existing = await db.giftCard.findFirst({
        where: { id: input.giftCardId, orgId: k.orgId },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Gift card not found." });
      }
      // One entry point (updateBalance): a USED non-reloadable card cannot
      // be revived, a deactivated card cannot be reloaded — the SQL decides.
      const updated = await updateGiftCardBalance(db, {
        giftCardId: existing.id,
        orgId: k.orgId,
        deltaCents: input.amountCents,
        kind: "reload",
      });
      if (!updated) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That card can't be topped up — it may be used up and not reloadable, or deactivated.",
        });
      }
      const fresh = await db.giftCard.findFirst({ where: { id: existing.id } });
      return toGiftCardRow(fresh);
    }),

  setGiftCardActive: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        giftCardId: z.string().min(1),
        active: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertCan(ctx.access.effectiveRole, "edit_draft");
      const db = getDb();
      const k = ctx.access.kyte!;
      const existing = await db.giftCard.findFirst({
        where: { id: input.giftCardId, orgId: k.orgId },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Gift card not found." });
      }
      if (existing.status === "USED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A used-up card can't be reactivated — reload it instead (reloadable cards only).",
        });
      }
      const updated = await db.giftCard.update({
        where: { id: existing.id },
        data: { status: input.active ? "ACTIVE" : "DEACTIVATED" },
      });
      return toGiftCardRow(updated);
    }),

  /** Seller preview: exactly what a buyer would pay, through the same engine. */
  previewTotals: kyte
    .input(
      z.object({
        kyteId: z.string().min(1),
        productId: z.string().min(1),
        couponCode: z.string().trim().min(1).max(64).optional(),
        giftCardCode: z.string().trim().min(1).max(64).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const k = ctx.access.kyte!;
      const product = await db.product.findFirst({
        where: { id: input.productId, kyteId: k.id, active: true },
      });
      if (!product) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Product not found." });
      }
      const now = new Date();
      const rows = await db.discountRule.findMany({
        where: { orgId: k.orgId, active: true },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      });
      const rules = rows
        .map((row: any) => discountRuleSchema.safeParse(row))
        .filter((p: any) => p.success)
        .map((p: any) => p.data);
      const sale = applyCatalogRules(
        { id: product.id, priceCents: product.priceCents },
        rules,
        now,
      );
      let couponRule: any = null;
      let couponCode: string | null = null;
      if (input.couponCode) {
        couponCode = input.couponCode.trim().toUpperCase();
        try {
          const resolved = await resolveCoupon(db, {
            orgId: k.orgId,
            code: couponCode,
            buyerEmail: null,
            now,
          });
          couponRule = resolved.rule;
        } catch (error) {
          if (error instanceof CouponResolutionError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
          }
          throw error;
        }
      }
      const totals = collectTotals(
        {
          lines: [{ productId: product.id, unitPriceCents: sale.priceCents, quantity: 1 }],
          couponCode,
          couponRule,
        },
        rules,
        now,
      );
      // The seller preview MUST agree with the charge: same totals, same
      // fee input (the amount Stripe actually charges — the DISCOUNTED
      // total minus any gift-card cover), same gift-card split.
      let giftTotals = {
        ...totals,
        giftCardCents: 0,
        stripeChargeCents: totals.totalCents,
        fullyCoveredByGiftCard: false,
      };
      if (input.giftCardCode) {
        try {
          const card = await resolveGiftCardByCode(db, {
            orgId: k.orgId,
            code: input.giftCardCode,
            now,
          });
          if (card.currency !== product.currency) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "That gift card's currency doesn't match this product." });
          }
          giftTotals = applyGiftCardToTotals(totals, card.balanceCents);
        } catch (error) {
          if (error instanceof GiftCardResolutionError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
          }
          throw error;
        }
      }
      return {
        productId: product.id,
        listPriceCents: product.priceCents,
        salePriceCents: sale.priceCents,
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        shippingCents: totals.shippingCents,
        shippingDiscountCents: totals.shippingDiscountCents,
        totalCents: totals.totalCents,
        feeCents: computeFeeCents(giftTotals.stripeChargeCents),
        applied: totals.applied,
        giftLines: totals.giftLines,
        couponApplied: totals.couponApplied,
        couponNotAppliedReason: totals.couponNotAppliedReason ?? null,
        giftCardCents: giftTotals.giftCardCents,
        stripeChargeCents: giftTotals.stripeChargeCents,
        fullyCoveredByGiftCard: giftTotals.fullyCoveredByGiftCard,
      };
    }),
});
