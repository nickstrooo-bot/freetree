import { createReadStream, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "@kytelink/db";
import {
  discountRuleSchema,
  normalizeCouponCode,
  tipJarSchema,
} from "@kytelink/schemas";
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
  computeFeeCents,
  createCheckoutSession,
  getFeePercent,
  getStripeClient,
  isStripeConfigured,
  verifyWebhookEvent,
} from "../commerce/stripe";
import {
  applyCatalogRules,
  checkCoupon,
  collectTotals,
  couponCheckError,
  CouponResolutionError,
  redeemCouponAtomic,
  releaseCouponRedemption,
  resolveCoupon,
  STRIPE_MINIMUM_CHARGE_CENTS,
  type EngineRule,
} from "../commerce/discounts";
import {
  applyGiftCardToTotals,
  GiftCardResolutionError,
  redeemGiftCardAtomic,
  recordGiftCardRefund,
  releaseGiftCardRedemption,
  resolveGiftCardByCode,
} from "../commerce/gift-cards";

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
  /** FreeTree coupon code (a seller's own code, not a Stripe coupon). */
  couponCode: z.string().trim().min(1).max(64).optional(),
  /** Gift-card code (a seller-issued card, not a Stripe coupon). Guest
   * redemption needs no account — the code IS the credential. */
  giftCardCode: z.string().trim().min(1).max(64).optional(),
});

/** Stored rule rows were validated at write time; parse defensively anyway. */
function parseRuleRow(row: any): EngineRule | null {
  const parsed = discountRuleSchema.safeParse(row);
  if (!parsed.success) {
    log.warn({ ruleId: row?.id }, "discount rule row failed validation — skipping it");
    return null;
  }
  return parsed.data;
}

/** All active rules for an org, parsed and ready for the engine. */
async function loadActiveRules(db: any, orgId: string, now: Date): Promise<EngineRule[]> {
  const rows = await db.discountRule.findMany({
    where: { orgId, active: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return rows
    .map(parseRuleRow)
    .filter((r: EngineRule | null): r is EngineRule => r !== null)
    .filter((r: EngineRule) => !r.startsAt || r.startsAt <= now)
    .filter((r: EngineRule) => !r.endsAt || r.endsAt >= now);
}

const tipCheckoutBody = z.object({
  username: z.string().trim().min(1).max(63),
  amountCents: z.number().int().min(50).max(1_000_000),
  buyerEmail: z.string().trim().email().max(320).optional(),
  tipMessage: z.string().trim().max(500).optional(),
});

/**
 * The tip jar's hidden backing Product (kind "tip", one per kyte). It exists
 * only so tip Purchases have a productId to point at — it is never listed in
 * the store (active=false) and never sold directly. The real amount lives on
 * each Purchase row, not on this row's priceCents.
 */
async function getOrCreateTipProduct(db: any, kyte: { id: string; orgId: string }, heading: string) {
  const existing = await db.product.findFirst({
    where: { kyteId: kyte.id, kind: "tip" },
  });
  if (existing) return existing;
  return db.product.create({
    data: {
      kyteId: kyte.id,
      orgId: kyte.orgId,
      name: heading,
      description: null,
      priceCents: 0,
      currency: "usd",
      kind: "tip",
      active: false,
    },
  });
}

/** Read the PUBLISHED tip jar for a kyte (draft jars don't take tips). */
function publishedTipJar(published: { tipJar?: unknown } | null) {
  if (!published) return null;
  const parsed = tipJarSchema.safeParse(published.tipJar);
  if (!parsed.success || !parsed.data.active) return null;
  return parsed.data;
}

export function registerCommerceRoutes(app: FastifyInstance): void {
  // ── Public product listing for a profile page ────────────────────────────
  // Catalog rules apply AT READ TIME here (applyCatalogRules): the listing
  // shows the sale price, the DB keeps the list price, and no reindex ever
  // runs. priceCents stays the list price; salePriceCents is what the
  // buyer pays before any checkout (cart-rule) discount.
  app.get("/commerce/products/:username", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "commerce-products"))) return;
    const { username } = req.params as { username: string };
    const db = getDb();
    const kyte = await db.kyte.findFirst({
      where: { username: username.toLowerCase() },
      select: { id: true, orgId: true },
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
    const rules = await loadActiveRules(db, kyte.orgId, new Date());
    const commerceEnabled = isStripeConfigured();
    await reply.send({
      products: products.map(
        (p: { id: string; name: string; description: string | null; priceCents: number; currency: string; fileName: string | null }) => {
          const sale = applyCatalogRules({ id: p.id, priceCents: p.priceCents }, rules);
          return {
            id: p.id,
            name: p.name,
            description: p.description,
            priceCents: p.priceCents,
            salePriceCents: sale.priceCents,
            onSale: sale.priceCents < p.priceCents,
            currency: p.currency,
            fileName: p.fileName,
          };
        },
      ),
      feePercent: getFeePercent(),
      checkoutEnabled: commerceEnabled,
    });
  });

  // ── Public tip jar config for a profile page ─────────────────────────────
  // Best-effort like products: a missing/inactive jar is just null.
  app.get("/commerce/tip-jar/:username", async (req, reply) => {
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
    const published = await db.publishedKyte.findUnique({
      where: { kyteId: kyte.id },
      select: { tipJar: true },
    });
    const jar = publishedTipJar(published);
    await reply.send({
      tipJar: jar
        ? { heading: jar.heading, message: jar.message ?? null, amountsCents: jar.amountsCents }
        : null,
      feePercent: getFeePercent(),
      checkoutEnabled: isStripeConfigured(),
    });
  });

  // ── Create a Stripe Checkout session for a tip ───────────────────────────
  // A tip is a Purchase against the kyte's hidden tip Product, at one of the
  // jar's preset amounts. Same fee math as a product sale: computeFeeCents
  // (4% of what's left after Stripe's fee) at the Purchase row AND inside
  // createCheckoutSession, so the charge and the seller preview agree.
  app.post("/commerce/tip", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "commerce-checkout"))) return;
    const stripe = getStripeClient();
    if (!stripe) {
      await reply.status(503).send({ error: "COMMERCE_NOT_CONFIGURED" });
      return;
    }
    const parsed = tipCheckoutBody.safeParse(req.body);
    if (!parsed.success) {
      await reply.status(400).send({ error: "BAD_REQUEST" });
      return;
    }

    const db = getDb();
    const kyte = await db.kyte.findFirst({
      where: { username: parsed.data.username.toLowerCase() },
      select: { id: true, orgId: true, username: true, displayName: true },
    });
    if (!kyte) {
      await reply.status(404).send({ error: "NOT_FOUND" });
      return;
    }

    const published = await db.publishedKyte.findUnique({
      where: { kyteId: kyte.id },
      select: { tipJar: true },
    });
    const jar = publishedTipJar(published);
    if (!jar) {
      await reply.status(404).send({ error: "TIP_JAR_NOT_FOUND" });
      return;
    }
    if (!jar.amountsCents.includes(parsed.data.amountCents)) {
      await reply.status(400).send({ error: "INVALID_TIP_AMOUNT" });
      return;
    }

    const connectAccount = await db.stripeConnectAccount.findUnique({
      where: { orgId: kyte.orgId },
    });
    if (!connectAccount?.chargesEnabled) {
      await reply.status(409).send({ error: "SELLER_NOT_READY" });
      return;
    }

    const config = getConfig();
    const username = kyte.username ?? kyte.id;
    const tipProduct = await getOrCreateTipProduct(db, kyte, jar.heading);

    const purchase = await db.purchase.create({
      data: {
        productId: tipProduct.id,
        kyteId: kyte.id,
        buyerEmail: parsed.data.buyerEmail ?? null,
        stripeSessionId: `pending_tip_${kyte.id}_${Date.now()}`,
        amountCents: parsed.data.amountCents,
        feeCents: computeFeeCents(parsed.data.amountCents),
        currency: "usd",
        status: "pending",
        tipMessage: parsed.data.tipMessage ?? null,
      },
    });

    try {
      const session = await createCheckoutSession(stripe, {
        stripeAccountId: connectAccount.stripeAccountId,
        productName: jar.heading,
        productDescription: jar.message ?? `A tip for ${kyte.displayName ?? username}`,
        amountCents: parsed.data.amountCents,
        currency: "usd",
        buyerEmail: parsed.data.buyerEmail,
        successUrl: `${config.webBaseUrl}/${username}/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${config.webBaseUrl}/${username}`,
        purchaseId: purchase.id,
        allowPromoCodes: false,
      });

      await db.purchase.update({
        where: { id: purchase.id },
        data: { stripeSessionId: session.sessionId },
      });

      await reply.send({ url: session.url, sessionId: session.sessionId });
    } catch (error) {
      log.error({ err: error, kyteId: kyte.id }, "tip checkout session creation failed");
      await db.purchase.delete({ where: { id: purchase.id } }).catch(() => undefined);
      await reply.status(502).send({ error: "CHECKOUT_FAILED" });
    }
  });

  // ── Create a Stripe Checkout session for a product ───────────────────────
  // Totals flow through ONE choke-point, collectTotals(): catalog rules
  // first (read-time sale price), then cart rules (automatic + the entered
  // coupon's rule). The DISCOUNTED total — not the list price — is what
  // gets charged AND what computeFeeCents runs on, both here (the Purchase
  // row, i.e. the seller preview) and inside createCheckoutSession (the
  // charge), so the two agree. If a FreeTree rule discounted anything (or
  // added a gift), Stripe's promo-code field is disabled for this session:
  // native discounts and Stripe coupons are mutually exclusive per
  // checkout, so the same order is never discounted twice.
  //
  // Coupon redemption is atomic (redeemCouponAtomic): the use is claimed by
  // a single conditional UPDATE whose WHERE clause enforces active /
  // window / maxUses / per-customer caps. If the claim loses the race, the
  // buyer gets COUPON_EXHAUSTED and no order is created. If Stripe then
  // fails, the claim is released again so the use isn't burned.
  app.post("/commerce/checkout", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "commerce-checkout"))) return;
    // NOTE: no Stripe check up here — a fully gift-card-covered order
    // never touches Stripe (see below), so Stripe only becomes required
    // once the gift-card remainder is known.
    const parsed = checkoutBody.safeParse(req.body);
    if (!parsed.success) {
      await reply.status(400).send({ error: "BAD_REQUEST" });
      return;
    }

    const db = getDb();
    const now = new Date();
    const product = await db.product.findFirst({
      where: { id: parsed.data.productId, active: true },
      include: { kyte: { select: { id: true, orgId: true, username: true } } },
    });
    if (!product) {
      await reply.status(404).send({ error: "PRODUCT_NOT_FOUND" });
      return;
    }

    const config = getConfig();
    const username = product.kyte.username ?? product.kyteId;
    const rules = await loadActiveRules(db, product.kyte.orgId, now);

    // Catalog rules: the sale price the buyer saw on the listing.
    const sale = applyCatalogRules(
      { id: product.id, priceCents: product.priceCents },
      rules,
      now,
    );

    // Resolve the entered coupon (if any) to its rule. Fast-fail messaging
    // only — the atomic UPDATE below is authoritative.
    let coupon: any = null;
    let couponRule: EngineRule | null = null;
    let couponCode: string | null = null;
    if (parsed.data.couponCode) {
      couponCode = normalizeCouponCode(parsed.data.couponCode);
      try {
        const resolved = await resolveCoupon(db, {
          orgId: product.kyte.orgId,
          code: couponCode,
          buyerEmail: parsed.data.buyerEmail ?? null,
          now,
        });
        coupon = resolved.coupon;
        couponRule = resolved.rule;
      } catch (error) {
        if (error instanceof CouponResolutionError) {
          await reply.status(error.status).send({ error: error.code, message: error.message });
          return;
        }
        throw error;
      }
    }

    // THE choke-point: one computation of the total, every discount in it.
    const totals = collectTotals(
      {
        lines: [{ productId: product.id, unitPriceCents: sale.priceCents, quantity: 1 }],
        couponCode,
        couponRule,
      },
      rules,
      now,
    );

    if (couponCode && couponRule && !totals.couponApplied) {
      await reply.status(400).send({
        error: "COUPON_NOT_APPLICABLE",
        message: totals.couponNotAppliedReason ?? "That code doesn't apply to this order.",
      });
      return;
    }

    // Gift card: applied AFTER collectTotals (the choke-point), to the
    // DISCOUNTED total. A fully-covering card means stripeChargeCents is 0
    // — the order is paid with NO Stripe charge and NO fee. A partial card
    // leaves only the remainder for Stripe, and the fee is computed on
    // that remainder only. Currency must match the product (a card is
    // currency-based); a mismatch is the same generic error as an unknown
    // code, so the checkout cannot be used as a code-existence oracle.
    let giftCard: any = null;
    let giftTotals = {
      ...totals,
      giftCardCents: 0,
      stripeChargeCents: totals.totalCents,
      fullyCoveredByGiftCard: false,
    };
    if (parsed.data.giftCardCode) {
      try {
        giftCard = await resolveGiftCardByCode(db, {
          orgId: product.kyte.orgId,
          code: parsed.data.giftCardCode,
          now,
        });
      } catch (error) {
        if (error instanceof GiftCardResolutionError) {
          await reply.status(error.status).send({ error: error.code, message: error.message });
          return;
        }
        throw error;
      }
      if (giftCard.currency !== product.currency) {
        await reply.status(400).send({
          error: "GIFT_CARD_INVALID",
          message: "That gift card isn't valid for this seller.",
        });
        return;
      }
      giftTotals = applyGiftCardToTotals(totals, giftCard.balanceCents);
    }

    // Stripe Checkout can't charge below its minimum (and can't charge
    // $0). The minimum applies to what Stripe actually charges — the
    // remainder after the gift card — not to the discounted total: a
    // 100%-off order is fine when a gift card covers it, and a card that
    // leaves a 1–49¢ remainder has no Stripe path (the buyer is told so).
    // A $0 remainder with $0 of card value is neither: nothing paid for
    // the order, so it keeps the old TOTAL_BELOW_MINIMUM answer.
    if (giftTotals.stripeChargeCents === 0 && giftTotals.giftCardCents === 0) {
      await reply.status(400).send({
        error: "TOTAL_BELOW_MINIMUM",
        message: `After discounts the total is below the ${STRIPE_MINIMUM_CHARGE_CENTS}¢ minimum Stripe can charge.`,
      });
      return;
    }
    if (giftTotals.stripeChargeCents > 0 && giftTotals.stripeChargeCents < STRIPE_MINIMUM_CHARGE_CENTS) {
      await reply.status(400).send({
        error: "TOTAL_BELOW_MINIMUM",
        message:
          giftTotals.giftCardCents > 0
            ? `After the gift card, ${giftTotals.stripeChargeCents}¢ is left — below the ${STRIPE_MINIMUM_CHARGE_CENTS}¢ minimum Stripe can charge.`
            : `After discounts the total is below the ${STRIPE_MINIMUM_CHARGE_CENTS}¢ minimum Stripe can charge.`,
      });
      return;
    }

    // Stripe + the seller's Connect account are only required when the
    // gift card leaves a remainder to charge.
    let stripe: any = null;
    let connectAccount: any = null;
    if (giftTotals.stripeChargeCents > 0) {
      stripe = getStripeClient();
      if (!stripe) {
        await reply.status(503).send({ error: "COMMERCE_NOT_CONFIGURED" });
        return;
      }
      connectAccount = await db.stripeConnectAccount.findUnique({
        where: { orgId: product.kyte.orgId },
      });
      if (!connectAccount?.chargesEnabled) {
        await reply.status(409).send({ error: "SELLER_NOT_READY" });
        return;
      }
    }

    // Create the purchase row first so the webhook can reconcile by metadata.
    // amountCents is what Stripe charges (the REMAINDER after the gift
    // card); feeCents is 4% of what's left after Stripe's fee ON THAT
    // REMAINDER — same input as the charge. amountCents + giftCardCents
    // is the discounted total. A fully-covered order has amountCents 0
    // and feeCents 0: no Stripe charge, no fee.
    const purchase = await db.purchase.create({
      data: {
        productId: product.id,
        kyteId: product.kyteId,
        buyerEmail: parsed.data.buyerEmail ?? null,
        stripeSessionId: `pending_${product.id}_${Date.now()}`,
        amountCents: giftTotals.stripeChargeCents,
        feeCents: computeFeeCents(giftTotals.stripeChargeCents),
        currency: product.currency,
        status: giftTotals.fullyCoveredByGiftCard ? "completed" : "pending",
        discountCents: totals.discountCents,
        couponCode,
        giftCardCents: giftTotals.giftCardCents,
        giftCardId: giftCard?.id ?? null,
        discountBreakdown: {
          applied: totals.applied,
          giftProductIds: totals.giftLines.map((g) => g.productId),
          giftCardCents: giftTotals.giftCardCents,
        },
      },
    });

    // Claim the coupon use atomically. If the race is lost, no order.
    let redeemed = false;
    if (coupon && couponRule && totals.couponApplied) {
      redeemed = await redeemCouponAtomic(db, {
        couponId: coupon.id,
        orgId: product.kyte.orgId,
        buyerEmail: parsed.data.buyerEmail ?? null,
        purchaseId: purchase.id,
        now,
      });
      if (!redeemed) {
        await db.purchase.delete({ where: { id: purchase.id } }).catch(() => undefined);
        const fresh = await db.coupon.findUnique({ where: { id: coupon.id } });
        const check = fresh ? checkCoupon(fresh, new Date(), null) : "exhausted";
        const err = couponCheckError(check === "ok" ? "exhausted" : check);
        await reply
          .status(err?.status ?? 409)
          .send({ error: err?.code ?? "COUPON_EXHAUSTED", message: err?.message ?? "That code has been used up." });
        return;
      }
    }

    // Claim the gift-card value atomically. If the race is lost (another
    // checkout spent the card first), no order — and the coupon use claimed
    // above is released with it.
    let giftCardRedeemed = false;
    if (giftCard && giftTotals.giftCardCents > 0) {
      giftCardRedeemed = await redeemGiftCardAtomic(db, {
        giftCardId: giftCard.id,
        orgId: product.kyte.orgId,
        amountCents: giftTotals.giftCardCents,
        buyerEmail: parsed.data.buyerEmail ?? null,
        purchaseId: purchase.id,
        now,
      });
      if (!giftCardRedeemed) {
        if (redeemed && coupon) {
          await releaseCouponRedemption(db, {
            couponId: coupon.id,
            orgId: product.kyte.orgId,
            purchaseId: purchase.id,
          }).catch(() => undefined);
        }
        await db.purchase.delete({ where: { id: purchase.id } }).catch(() => undefined);
        await reply.status(400).send({
          error: "GIFT_CARD_INVALID",
          message: "That gift card isn't valid for this seller.",
        });
        return;
      }
    }

    // Fully covered by the gift card: the order is paid — no Stripe
    // session, no charge, no fee. The purchase was created "completed"
    // above; swap the placeholder session id for a gift-card marker so
    // the order can still be looked up by session id.
    if (giftTotals.fullyCoveredByGiftCard) {
      await db.purchase.update({
        where: { id: purchase.id },
        data: { stripeSessionId: `giftcard_${purchase.id}` },
      });
      await reply.send({
        url: null,
        sessionId: null,
        totalCents: totals.totalCents,
        discountCents: totals.discountCents,
        giftCardCents: giftTotals.giftCardCents,
        stripeChargeCents: 0,
        paidByGiftCard: true,
      });
      return;
    }

    // Resolve gift lines to real products (same seller, still active) for
    // the $0 line items. A gift product deleted since the rule was made is
    // skipped, not fatal — the buyer still gets the paid product.
    const extraLineItems: Array<{ name: string; description: string | null; amountCents: number; quantity: number }> = [];
    for (const gift of totals.giftLines) {
      const giftProduct = await db.product.findFirst({
        where: { id: gift.productId, orgId: product.kyte.orgId, active: true },
        select: { name: true, description: true },
      });
      if (!giftProduct) {
        log.warn({ giftProductId: gift.productId, purchaseId: purchase.id }, "gift product missing or inactive — skipping gift line");
        continue;
      }
      extraLineItems.push({
        name: giftProduct.name,
        description: giftProduct.description ?? "Free gift with your order",
        amountCents: 0,
        quantity: gift.quantity,
      });
    }

    try {
      const session = await createCheckoutSession(stripe, {
        stripeAccountId: connectAccount.stripeAccountId,
        productName: product.name,
        productDescription: product.description,
        amountCents: giftTotals.stripeChargeCents,
        currency: product.currency,
        buyerEmail: parsed.data.buyerEmail,
        successUrl: `${config.webBaseUrl}/${username}/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${config.webBaseUrl}/${username}`,
        purchaseId: purchase.id,
        // Mutual exclusion: a FreeTree discount (or gift) means no Stripe
        // promo-code field on this session — no double-dipping.
        allowPromoCodes:
          totals.discountCents > 0 || totals.giftLines.length > 0
            ? false
            : (product.allowPromoCodes ?? false),
        extraLineItems,
        discountCents: totals.discountCents,
        couponCode,
        giftCardCents: giftTotals.giftCardCents,
        giftCardId: giftCard?.id ?? null,
      });

      // Swap the placeholder session id for the real one.
      await db.purchase.update({
        where: { id: purchase.id },
        data: { stripeSessionId: session.sessionId },
      });

      await reply.send({
        url: session.url,
        sessionId: session.sessionId,
        totalCents: totals.totalCents,
        discountCents: totals.discountCents,
        giftCardCents: giftTotals.giftCardCents,
        stripeChargeCents: giftTotals.stripeChargeCents,
        paidByGiftCard: false,
      });
    } catch (error) {
      log.error({ err: error, productId: product.id }, "checkout session creation failed");
      // Give the coupon use back: no order, no burned code.
      if (redeemed && coupon) {
        await releaseCouponRedemption(db, {
          couponId: coupon.id,
          orgId: product.kyte.orgId,
          purchaseId: purchase.id,
        }).catch((releaseError) =>
          log.error({ err: releaseError, purchaseId: purchase.id }, "coupon release failed after checkout failure"),
        );
      }
      // Give the gift-card value back too: no order, no burned card.
      if (giftCardRedeemed && giftCard) {
        await releaseGiftCardRedemption(db, {
          giftCardId: giftCard.id,
          orgId: product.kyte.orgId,
          amountCents: giftTotals.giftCardCents,
          purchaseId: purchase.id,
        }).catch((releaseError) =>
          log.error({ err: releaseError, purchaseId: purchase.id }, "gift-card release failed after checkout failure"),
        );
      }
      await db.purchase.delete({ where: { id: purchase.id } }).catch(() => undefined);
      await reply.status(502).send({ error: "CHECKOUT_FAILED" });
    }
  });

  // ── Gift-card balance check (buyer-facing, no account needed) ────────────
  // NOT a code-existence oracle: an unknown, malformed, expired, used-up,
  // or deactivated code all get the same generic 404 — the caller can
  // never learn whether a code exists, only whether THIS code has a
  // balance right now. Rate-limited with the checkout bucket because a
  // guessable-code endpoint is exactly what enumeration attacks target.
  app.post("/commerce/gift-card/balance", async (req, reply) => {
    if (!(await rateLimitOr429(app, req, reply, "commerce-checkout"))) return;
    const parsed = z
      .object({
        username: z.string().trim().min(1).max(63),
        code: z.string().trim().min(1).max(64),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      await reply.status(404).send({ error: "GIFT_CARD_NOT_FOUND" });
      return;
    }
    const db = getDb();
    const kyte = await db.kyte.findFirst({
      where: { username: parsed.data.username.toLowerCase() },
      select: { id: true, orgId: true },
    });
    if (!kyte) {
      await reply.status(404).send({ error: "GIFT_CARD_NOT_FOUND" });
      return;
    }
    try {
      const card = await resolveGiftCardByCode(db, {
        orgId: kyte.orgId,
        code: parsed.data.code,
      });
      await reply.send({
        balanceCents: card.balanceCents,
        currency: card.currency,
        expiresAt: card.expiresAt?.toISOString() ?? null,
      });
    } catch (error) {
      if (error instanceof GiftCardResolutionError) {
        await reply.status(404).send({ error: "GIFT_CARD_NOT_FOUND" });
        return;
      }
      throw error;
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
        tipMessage: true,
        product: { select: { name: true, kind: true, fileKey: true, externalUrl: true } },
      },
    });
    if (!purchase) {
      await reply.status(404).send({ error: "NOT_FOUND" });
      return;
    }
    const config = getConfig();
    const isTip = purchase.product.kind === "tip";
    // A tip has no file to download — the thanks page must not offer one.
    const hasDownload = Boolean(purchase.product.fileKey || purchase.product.externalUrl);
    await reply.send({
      status: purchase.status,
      productName: purchase.product.name,
      isTip,
      tipMessage: purchase.tipMessage,
      downloadUrl:
        purchase.status === "completed" && hasDownload
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
        } else if (event.type === "checkout.session.expired") {
          // Buyer abandoned the session: give any redeemed gift-card value
          // back. (Coupon uses are NOT released here — the discount engine
          // only releases on session-creation failure; gift cards release
          // on expiry because the money is the buyer's stored value.)
          const session = event.data.object;
          const purchase = await db.purchase.findFirst({
            where: { stripeSessionId: session.id as string },
          });
          if (purchase?.giftCardId && (purchase.giftCardCents ?? 0) > 0) {
            const kyte = await db.kyte.findFirst({ where: { id: purchase.kyteId } });
            if (kyte) {
              await releaseGiftCardRedemption(db, {
                giftCardId: purchase.giftCardId,
                orgId: kyte.orgId,
                amountCents: purchase.giftCardCents,
                purchaseId: purchase.id,
              }).catch((error) =>
                log.error({ err: error, purchaseId: purchase.id }, "gift-card release failed on session expiry"),
              );
            }
          }
        } else if (event.type === "charge.refunded") {
          const charge = event.data.object;
          const paymentIntent = charge.payment_intent as string | undefined;
          if (paymentIntent) {
            // Refunds are recorded the Solidus way: a Refund (separate
            // model from the payment) PAIRED with its OrderAdjustment, in
            // one transaction — a bare refund must never leave the order
            // balance_due, and a refund of a gift-card-paid order reverses
            // the card's share proportionally (back to the card, or as a
            // new card when the original can't take credit). Stripe's
            // amount_refunded is a RUNNING total, so only the increment
            // over refunds already recorded is booked — a retried webhook
            // must not double-record.
            const purchase = await db.purchase.findFirst({
              where: { stripePaymentIntent: paymentIntent },
            });
            if (purchase) {
              const kyte = await db.kyte.findFirst({ where: { id: purchase.kyteId } });
              if (kyte) {
                const refundedSoFar = typeof charge.amount_refunded === "number"
                  ? charge.amount_refunded
                  : (charge.amount as number | undefined) ?? 0;
                const alreadyRecorded = await db.refund.findMany({
                  where: { purchaseId: purchase.id },
                });
                const recordedTotal = alreadyRecorded.reduce(
                  (sum: number, r: any) => sum + (r.amountCents ?? 0),
                  0,
                );
                const incremental = refundedSoFar - recordedTotal;
                if (incremental > 0) {
                  const refundRows = Array.isArray((charge as any).refunds?.data)
                    ? (charge as any).refunds.data
                    : [];
                  const result = await recordGiftCardRefund(db, {
                    purchaseId: purchase.id,
                    orgId: kyte.orgId,
                    amountCents: incremental,
                    currency: purchase.currency ?? "usd",
                    stripeRefundId: refundRows.length > 0 ? refundRows[refundRows.length - 1].id : null,
                    reason: "stripe_webhook",
                  });
                  log.info(
                    {
                      purchaseId: purchase.id,
                      refundCents: incremental,
                      giftCardReversedCents: result.giftCardReversedCents,
                      replacementGiftCardId: result.replacementGiftCardId,
                    },
                    "refund recorded with order adjustment",
                  );
                }
              }
            }
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
