import { taggedLogger } from "../logger";

const log = taggedLogger("commerce:stripe");

// ─── FreeTree Commerce — Stripe Connect integration ──────────────────────────
// Sellers connect their own Stripe account (Connect Standard — $0 platform cost).
// Stripe Checkout sessions created ON the seller's connected account, with a
// platform application fee (default 4%) flowing back to FreeTree.
// Everything degrades gracefully: if STRIPE_SECRET_KEY is unset, all commerce
// endpoints report "not configured" instead of crashing.

type StripeLike = any;

let cached: StripeLike | null | undefined;

export function getFeePercent(): number {
  const raw = process.env.COMMERCE_FEE_PERCENT;
  const parsed = raw ? Number(raw) : 4;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return 4;
  return parsed;
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Lazy singleton. Returns null when Stripe is not configured. */
export function getStripeClient(): StripeLike | null {
  if (cached !== undefined) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    cached = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Stripe = require("stripe");
    cached = new Stripe(key);
    return cached;
  } catch (error) {
    log.error({ err: error }, "stripe SDK failed to load — commerce disabled");
    cached = null;
    return null;
  }
}

export interface ConnectAccountResult {
  stripeAccountId: string;
}

/** Create (or reuse) a Connect Standard account for a seller org. */
export async function getOrCreateConnectAccount(
  stripe: StripeLike,
  orgId: string,
  email: string,
  existingAccountId?: string | null,
): Promise<ConnectAccountResult> {
  if (existingAccountId) {
    try {
      await stripe.accounts.retrieve(existingAccountId);
      return { stripeAccountId: existingAccountId };
    } catch {
      log.warn({ orgId }, "stored Connect account missing on Stripe — creating a new one");
    }
  }
  const account = await stripe.accounts.create({
    // Standard (not Express): $0 platform cost per seller. Express charges
    // $2/mo per active account, which loses money on sellers under ~$50/mo.
    // Standard sellers get the full Stripe dashboard; onboarding link below
    // still works the same.
    type: "standard",
    email,
    metadata: { freetree_org_id: orgId },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });
  return { stripeAccountId: account.id };
}

/** Build a Connect onboarding link for the seller (works for Standard accounts). */
export async function createOnboardingLink(
  stripe: StripeLike,
  stripeAccountId: string,
  returnUrl: string,
  refreshUrl: string,
): Promise<string> {
  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    return_url: returnUrl,
    refresh_url: refreshUrl,
    type: "account_onboarding",
  });
  return link.url;
}

export interface CheckoutSessionInput {
  /** Connected (seller) account id — the charge lands here. */
  stripeAccountId: string;
  productName: string;
  productDescription?: string | null;
  /** Unit price in the smallest currency unit. */
  amountCents: number;
  currency: string;
  buyerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  /** Our internal purchase id, echoed back via webhook metadata. */
  purchaseId: string;
  /**
   * When true, Stripe Checkout shows a promo-code field. Sellers create and
   * manage their codes in their own Stripe dashboard (Billing > Coupons) —
   * FreeTree never touches coupon definitions, just enables the field.
   */
  allowPromoCodes?: boolean;
}

export interface CheckoutSessionResult {
  sessionId: string;
  url: string;
}

/**
 * Create a Stripe Checkout session on the seller's connected account.
 * The application fee (default 4%) is taken automatically by Stripe and
 * routed to the platform; the seller keeps the rest.
 */
export async function createCheckoutSession(
  stripe: StripeLike,
  input: CheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  const feePercent = getFeePercent();
  const feeAmount = Math.round((input.amountCents * feePercent) / 100);

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: input.currency,
            unit_amount: input.amountCents,
            product_data: {
              name: input.productName,
              description: input.productDescription ?? undefined,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: input.buyerEmail ?? undefined,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // Per-product toggle: sellers opt in via the product editor. The actual
      // coupon codes live in the seller's Stripe dashboard, not here.
      allow_promotion_codes: input.allowPromoCodes ?? false,
      payment_intent_data: {
        application_fee_amount: feeAmount,
      },
      metadata: {
        freetree_purchase_id: input.purchaseId,
        freetree_fee_percent: String(feePercent),
      },
    },
    { stripeAccount: input.stripeAccountId },
  );

  if (!session.url) {
    throw new Error("Stripe Checkout session created without a URL");
  }
  return { sessionId: session.id, url: session.url };
}

/**
 * Verify a Stripe webhook signature against the raw request body.
 * Throws on invalid signature.
 */
export function verifyWebhookEvent(stripe: StripeLike, rawBody: string | Buffer, signature: string): any {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  }
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/** Refresh a stored Connect account's capability flags from Stripe. */
export async function refreshAccountStatus(
  stripe: StripeLike,
  stripeAccountId: string,
): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean }> {
  const account = await stripe.accounts.retrieve(stripeAccountId);
  return {
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
  };
}
