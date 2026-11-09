import { taggedLogger } from "../logger";

const log = taggedLogger("commerce:stripe");

// ─── FreeTree Commerce — Stripe Connect integration ──────────────────────────
// Sellers connect their own Stripe account (Connect Standard — $0 platform cost).
// Stripe Checkout sessions created ON the seller's connected account, with a
// platform application fee (default 4%) flowing back to FreeTree. The fee is
// taken on what's left AFTER Stripe's processing fee — Stripe's fee is
// separate from ours and comes off first.
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

/**
 * FreeTree's cut, in cents: feePercent of what's left AFTER Stripe's
 * processing fee. Stripe's fee isn't known exactly until the card is
 * charged (it varies by card and country), so we estimate the standard
 * US card rate: 2.9% + 30c. The seller's net is: sale − Stripe fee −
 * our fee. Stripe's fee is separate from ours and goes to Stripe, not us.
 */
export function computeFeeCents(amountCents: number, feePercent?: number): number {
  const percent = feePercent ?? getFeePercent();
  const stripeFeeEstimate = Math.round(amountCents * 0.029) + 30;
  const netAfterStripe = Math.max(0, amountCents - stripeFeeEstimate);
  return Math.round((netAfterStripe * percent) / 100);
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
    // NOTE: no `type` field — Stripe rejects the legacy `type` field on
    // managed-risk platforms (v1 create defaults to Standard).
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
   *
   * MUTUAL EXCLUSION with the discount engine: the checkout route sets this
   * to false whenever a FreeTree rule discounts the order (or adds a gift),
   * so the same order can never be discounted twice — once by our engine
   * and once by a Stripe coupon. Sellers with no FreeTree rules active are
   * unaffected.
   */
  allowPromoCodes?: boolean;
  /**
   * Extra zero-priced (or priced) line items, e.g. Saleor-style GIFT reward
   * lines from the discount engine. A gift line is a real product the buyer
   * receives for $0 — it shows on the Stripe receipt, which is the point:
   * the buyer can see what they got free.
   */
  extraLineItems?: Array<{
    name: string;
    description?: string | null;
    amountCents: number;
    quantity: number;
  }>;
  /**
   * Discount-engine audit fields, echoed into the session metadata so the
   * webhook / Stripe dashboard can reconcile what was discounted and why.
   */
  discountCents?: number;
  couponCode?: string | null;
  /**
   * Gift-card audit fields: the card portion of this order (the Stripe
   * charge is only the remainder — see applyGiftCardToTotals). Echoed so
   * the webhook / dashboard can reconcile what the card paid.
   */
  giftCardCents?: number;
  giftCardId?: string | null;
}

export interface CheckoutSessionResult {
  sessionId: string;
  url: string;
}

/**
 * Create a Stripe Checkout session on the seller's connected account.
 * The application fee (default 4% of what's left after Stripe's
 * processing fee) is taken automatically by Stripe and routed to the
 * platform; the seller keeps the rest.
 */
export async function createCheckoutSession(
  stripe: StripeLike,
  input: CheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  const feePercent = getFeePercent();
  const feeAmount = computeFeeCents(input.amountCents, feePercent);

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      // NOTE: no `payment_method_types` — Stripe rejects that parameter now
      // ("no longer supported"); Checkout uses dynamic payment methods from
      // the account's Dashboard settings instead (card is on by default).
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
        // Gift lines (discount engine): zero-priced products the buyer gets
        // free. Stripe accepts $0 line items; a gift is a real product on
        // the receipt, not an invisible adjustment.
        ...(input.extraLineItems ?? []).map((item) => ({
          price_data: {
            currency: input.currency,
            unit_amount: item.amountCents,
            product_data: {
              name: item.name,
              description: item.description ?? undefined,
            },
          },
          quantity: item.quantity,
        })),
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
        ...(input.discountCents !== undefined
          ? { freetree_discount_cents: String(input.discountCents) }
          : {}),
        ...(input.couponCode ? { freetree_coupon_code: input.couponCode } : {}),
        ...(input.giftCardCents !== undefined
          ? { freetree_gift_card_cents: String(input.giftCardCents) }
          : {}),
        ...(input.giftCardId ? { freetree_gift_card_id: input.giftCardId } : {}),
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
