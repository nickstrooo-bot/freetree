import { z } from "zod";
import { kyteProcedure, router } from "../trpc";
import { notImplemented } from "../errors";
import { kyteIdInput, okSchema } from "../shapes";

// ─── FreeTree Commerce contract ─────────────────────────────────────────────
// Digital-product checkout with a 4% application fee via Stripe Connect.
// Every procedure here throws notImplemented; the concrete implementations live
// in apps/api/src/routers/commerce.ts and must conform to these shapes.

export const productSchema = z.object({
  id: z.string(),
  kyteId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string(),
  fileName: z.string().nullable(),
  fileSizeBytes: z.number().int().nullable(),
  hasFile: z.boolean(),
  externalUrl: z.string().nullable(),
  active: z.boolean(),
  allowPromoCodes: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CommerceProduct = z.infer<typeof productSchema>;

export const saleSchema = z.object({
  id: z.string(),
  productId: z.string(),
  productName: z.string(),
  buyerEmail: z.string().nullable(),
  amountCents: z.number().int(),
  feeCents: z.number().int(),
  currency: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

const createProductInput = z.object({
  kyteId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  priceCents: z.number().int().min(50).max(10000000),
  currency: z.string().trim().toLowerCase().default("usd"),
  // Base64-encoded file content for the digital deliverable (max 25MB).
  fileBase64: z.string().max(35_000_000).optional(),
  fileName: z.string().trim().max(255).optional(),
  // ...or an external download URL instead of an uploaded file.
  externalUrl: z.string().trim().url().max(2048).optional(),
  // Show a promo-code field at Stripe Checkout. Codes are managed in the
  // seller's own Stripe dashboard.
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
  // ── Seller: product management ──────────────────────────────────────────

  listProducts: kyteProcedure
    .input(kyteIdInput)
    .output(z.object({ products: z.array(productSchema) }))
    .query(() => {
      throw notImplemented("commerce.listProducts");
    }),

  createProduct: kyteProcedure
    .input(createProductInput)
    .output(productSchema)
    .mutation(() => {
      throw notImplemented("commerce.createProduct");
    }),

  updateProduct: kyteProcedure
    .input(updateProductInput)
    .output(productSchema)
    .mutation(() => {
      throw notImplemented("commerce.updateProduct");
    }),

  deleteProduct: kyteProcedure
    .input(z.object({ kyteId: z.string().min(1), productId: z.string().min(1) }))
    .output(okSchema)
    .mutation(() => {
      throw notImplemented("commerce.deleteProduct");
    }),

  // ── Seller: Stripe Connect onboarding ───────────────────────────────────

  getConnectStatus: kyteProcedure
    .input(kyteIdInput)
    .output(
      z.object({
        configured: z.boolean(),
        connected: z.boolean(),
        chargesEnabled: z.boolean(),
        payoutsEnabled: z.boolean(),
        detailsSubmitted: z.boolean(),
      }),
    )
    .query(() => {
      throw notImplemented("commerce.getConnectStatus");
    }),

  createOnboardingLink: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        returnUrl: z.string().url(),
        refreshUrl: z.string().url(),
      }),
    )
    .output(z.object({ url: z.string().url() }))
    .mutation(() => {
      throw notImplemented("commerce.createOnboardingLink");
    }),

  // ── Seller: sales history ───────────────────────────────────────────────

  getSales: kyteProcedure
    .input(
      z.object({
        kyteId: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
      }),
    )
    .output(
      z.object({
        sales: z.array(saleSchema),
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
      throw notImplemented("commerce.getSales");
    }),
});
