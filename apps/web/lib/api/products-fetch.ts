import type { PublicProduct } from "@kytelink/ui";

export interface PublicProductsResult {
  products: PublicProduct[];
  feePercent: number;
  checkoutEnabled: boolean;
}

const EMPTY: PublicProductsResult = { products: [], feePercent: 4, checkoutEnabled: false };

/**
 * Server-side fetch of a profile's public products. Best-effort: any failure
 * returns an empty list so a commerce outage never breaks the profile page.
 */
export async function fetchPublicProducts(username: string): Promise<PublicProductsResult> {
  const base = process.env.API_BASE_URL ?? "http://localhost:3003";
  try {
    const response = await fetch(
      `${base}/commerce/products/${encodeURIComponent(username.toLowerCase())}`,
    );
    if (!response.ok) return EMPTY;
    const data = (await response.json()) as {
      products?: PublicProduct[];
      feePercent?: number;
      checkoutEnabled?: boolean;
    };
    return {
      products: Array.isArray(data.products) ? data.products : [],
      feePercent: typeof data.feePercent === "number" ? data.feePercent : 4,
      checkoutEnabled: Boolean(data.checkoutEnabled),
    };
  } catch {
    return EMPTY;
  }
}

/** Client-side: create a Stripe Checkout session and redirect the buyer. */
export async function startCheckout(productId: string, buyerEmail?: string): Promise<void> {
  const base =
    process.env.NEXT_PUBLIC_API_URL ?? (typeof window !== "undefined" ? "" : "http://localhost:3003");
  const response = await fetch(`${base}/commerce/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, buyerEmail: buyerEmail || undefined }),
  });
  const data = (await response.json()) as { url?: string; error?: string };
  if (!response.ok || !data.url) {
    throw new Error(data.error ?? "CHECKOUT_FAILED");
  }
  window.location.href = data.url;
}
