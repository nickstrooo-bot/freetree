import { createReadStream, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "@kytelink/db";
import type { RateLimitClass } from "@kytelink/schemas";
import { getRedis } from "../redis";
import {
  enforceRateLimit,
  isRedisLike,
  RedisRateLimiter,
  retryAfterOf,
} from "../trpc/rate-limit";
import { getConfig } from "../config";
import { taggedLogger } from "../logger";
import {
  createCheckoutSession,
  getFeePercent,
  getStripeClient,
  isStripeConfigured,
  verifyWebhookEvent,
} from "../commerce/stripe";

const log = taggedLogger("commerce:routes");

const DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_DOWNLOADS = 10;

function filesDir(): string {
  return process.env.COMMERCE_FILES_DIR ?? join(process.cwd(), "data", "commerce-files");
}

async function rateLimitOr429(
  app: FastifyInstance,
  req: any,
  reply: any,
  key: RateLimitClass,
): Promise<boolean> {
  const redis = getRedis();
  if (!isRedisLike(redis)) return true;
  try {
    await enforceRateLimit(new RedisRateLimiter(redis), key, { ip: req.ip }, { failOpen: true });
    return true;
  } catch (error) {
    const retryAfter = retryAfterOf(error);
    if (retryAfter !== null) reply.header("retry-after", String(retryAfter));
    await reply.status(429).send({ error: "TOO_MANY_REQUESTS" });
    return false;
  }
}

const checkoutBody = z.object({
  productId: z.string().min(1),
  buyerEmail: z.string().trim().email().max(320).optional(),
});

export function registerCommerceRoutes(app: FastifyInstance): void {
  // ── Public product listing for a profile page ────────────────────────────
  app.get("/commerce/products/:username", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "commerce-products"))) return;
    const { username } = req.params as { username: string };
    const db = getDb();
    const kyte = await db.kyte.findFirst({
      where: { username: username.toLowerCase() },
      select: { id: true },
    });
    if (!kyte) {
      await reply.status(404).send({ error: "NOT_FOUND" });
      return;
    }
    const products = await db.product.findMany({
      where: { kyteId: kyte.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        priceCents: true,
        currency: true,
        fileName: true,
      },
    });
    const commerceEnabled = isStripeConfigured();
    await reply.send({
      products: products.map(
        (p: { id: string; name: string; description: string | null; priceCents: number; currency: string; fileName: string | null }) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          priceCents: p.priceCents,
          currency: p.currency,
          fileName: p.fileName,
        }),
      ),
      feePercent: getFeePercent(),
      checkoutEnabled: commerceEnabled,
    });
  });

  // ── Create a Stripe Checkout session for a product ───────────────────────
  app.post("/commerce/checkout", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "commerce-checkout"))) return;
    const stripe = getStripeClient();
    if (!stripe) {
      await reply.status(503).send({ error: "COMMERCE_NOT_CONFIGURED" });
      return;
    }
    const parsed = checkoutBody.safeParse(req.body);
    if (!parsed.success) {
      await reply.status(400).send({ error: "BAD_REQUEST" });
      return;
    }

    const db = getDb();
    const product = await db.product.findFirst({
      where: { id: parsed.data.productId, active: true },
      include: { kyte: { select: { id: true, orgId: true, username: true } } },
    });
    if (!product) {
      await reply.status(404).send({ error: "PRODUCT_NOT_FOUND" });
      return;
    }

    const connectAccount = await db.stripeConnectAccount.findUnique({
      where: { orgId: product.kyte.orgId },
    });
    if (!connectAccount?.chargesEnabled) {
      await reply.status(409).send({ error: "SELLER_NOT_READY" });
      return;
    }

    const config = getConfig();
    const username = product.kyte.username ?? product.kyteId;

    // Create the purchase row first so the webhook can reconcile by metadata.
    const purchase = await db.purchase.create({
      data: {
        productId: product.id,
        kyteId: product.kyteId,
        buyerEmail: parsed.data.buyerEmail ?? null,
        stripeSessionId: `pending_${product.id}_${Date.now()}`,
        amountCents: product.priceCents,
        feeCents: Math.round((product.priceCents * getFeePercent()) / 100),
        currency: product.currency,
        status: "pending",
      },
    });

    try {
      const session = await createCheckoutSession(stripe, {
        stripeAccountId: connectAccount.stripeAccountId,
        productName: product.name,
        productDescription: product.description,
        amountCents: product.priceCents,
        currency: product.currency,
        buyerEmail: parsed.data.buyerEmail,
        successUrl: `${config.webBaseUrl}/${username}/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${config.webBaseUrl}/${username}`,
        purchaseId: purchase.id,
        allowPromoCodes: product.allowPromoCodes ?? false,
      });

      // Swap the placeholder session id for the real one.
      await db.purchase.update({
        where: { id: purchase.id },
        data: { stripeSessionId: session.sessionId },
      });

      await reply.send({ url: session.url, sessionId: session.sessionId });
    } catch (error) {
      log.error({ err: error, productId: product.id }, "checkout session creation failed");
      await db.purchase.delete({ where: { id: purchase.id } }).catch(() => undefined);
      await reply.status(502).send({ error: "CHECKOUT_FAILED" });
    }
  });

  // ── Order status + download link (buyer-facing, keyed by Stripe session) ──
  app.get("/commerce/order/:sessionId", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "commerce-order"))) return;
    const { sessionId } = req.params as { sessionId: string };
    const db = getDb();
    const purchase = await db.purchase.findUnique({
      where: { stripeSessionId: sessionId },
      select: {
        id: true,
        status: true,
        downloadToken: true,
        downloadExpiresAt: true,
        product: { select: { name: true } },
      },
    });
    if (!purchase) {
      await reply.status(404).send({ error: "NOT_FOUND" });
      return;
    }
    const config = getConfig();
    await reply.send({
      status: purchase.status,
      productName: purchase.product.name,
      downloadUrl:
        purchase.status === "completed"
          ? `${config.apiBaseUrl}/commerce/download/${purchase.downloadToken}`
          : null,
      expiresAt: purchase.downloadExpiresAt?.toISOString() ?? null,
    });
  });

  // ── Time-limited, count-limited file download ────────────────────────────
  app.get("/commerce/download/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const db = getDb();
    const purchase = await db.purchase.findUnique({
      where: { downloadToken: token },
      include: { product: true },
    });
    if (!purchase || purchase.status !== "completed") {
      await reply.status(404).send({ error: "NOT_FOUND" });
      return;
    }
    if (purchase.downloadExpiresAt && purchase.downloadExpiresAt < new Date()) {
      await reply.status(410).send({ error: "DOWNLOAD_EXPIRED" });
      return;
    }
    if (purchase.downloadCount >= MAX_DOWNLOADS) {
      await reply.status(410).send({ error: "DOWNLOAD_LIMIT_REACHED" });
      return;
    }

    // External URL products redirect straight through.
    if (!purchase.product.fileKey && purchase.product.externalUrl) {
      await db.purchase.update({
        where: { id: purchase.id },
        data: { downloadCount: { increment: 1 } },
      });
      await reply.redirect(purchase.product.externalUrl);
      return;
    }
    if (!purchase.product.fileKey) {
      await reply.status(404).send({ error: "FILE_NOT_AVAILABLE" });
      return;
    }

    const filePath = join(filesDir(), basename(purchase.product.fileKey));
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      await reply.status(404).send({ error: "FILE_NOT_AVAILABLE" });
      return;
    }

    await db.purchase.update({
      where: { id: purchase.id },
      data: { downloadCount: { increment: 1 } },
    });

    const fileName = purchase.product.fileName ?? "download";
    await reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`)
      .header("Content-Length", String(size))
      .send(createReadStream(filePath));
  });

  // ── Stripe webhook (raw body required — encapsulated parser) ─────────────
  void app.register(async (webhooks) => {
    webhooks.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (req, body, done) => {
        (req as any).rawBody = body;
        try {
          done(null, JSON.parse(body as string));
        } catch (error) {
          done(error as Error);
        }
      },
    );

    webhooks.post("/webhooks/stripe", async (req, reply) => {
      const stripe = getStripeClient();
      if (!stripe) {
        await reply.status(503).send({ error: "COMMERCE_NOT_CONFIGURED" });
        return;
      }
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") {
        await reply.status(400).send({ error: "MISSING_SIGNATURE" });
        return;
      }

      let event: any;
      try {
        event = verifyWebhookEvent(stripe, (req as any).rawBody as string, signature);
      } catch (error) {
        log.warn({ err: error }, "stripe webhook signature verification failed");
        await reply.status(400).send({ error: "INVALID_SIGNATURE" });
        return;
      }

      const db = getDb();
      try {
        if (event.type === "checkout.session.completed") {
          const session = event.data.object;
          const purchaseId = session.metadata?.freetree_purchase_id as string | undefined;
          const lookup = purchaseId
            ? { id: purchaseId }
            : { stripeSessionId: session.id as string };
          const purchase = await db.purchase.findFirst({ where: lookup });
          if (purchase && purchase.status === "pending") {
            await db.purchase.update({
              where: { id: purchase.id },
              data: {
                status: "completed",
                stripePaymentIntent: (session.payment_intent as string | null) ?? null,
                buyerEmail: purchase.buyerEmail ?? (session.customer_email as string | null),
                downloadExpiresAt: new Date(Date.now() + DOWNLOAD_TTL_MS),
              },
            });
            log.info(
              { purchaseId: purchase.id, amountCents: purchase.amountCents },
              "purchase completed",
            );
          }
        } else if (event.type === "charge.refunded") {
          const charge = event.data.object;
          const paymentIntent = charge.payment_intent as string | undefined;
          if (paymentIntent) {
            await db.purchase.updateMany({
              where: { stripePaymentIntent: paymentIntent, status: "completed" },
              data: { status: "refunded" },
            });
          }
        }
      } catch (error) {
        log.error({ err: error, eventType: event.type }, "webhook handler failed");
        // Return 500 so Stripe retries.
        await reply.status(500).send({ error: "HANDLER_FAILED" });
        return;
      }

      await reply.send({ received: true });
    });
  });
}
