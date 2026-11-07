/**
 * Client-side: start a Stripe Checkout session for a tip and redirect the
 * visitor. The amount must be one of the jar's preset amounts — the server
 * enforces that, so a tampered amount fails here with INVALID_TIP_AMOUNT.
 */
export async function startTip(
  username: string,
  amountCents: number,
  tipMessage?: string,
  buyerEmail?: string,
): Promise<void> {
  const base =
    process.env.NEXT_PUBLIC_API_URL ?? (typeof window !== "undefined" ? "" : "http://localhost:3003");
  const response = await fetch(`${base}/commerce/tip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      amountCents,
      tipMessage: tipMessage || undefined,
      buyerEmail: buyerEmail || undefined,
    }),
  });
  const data = (await response.json()) as { url?: string; error?: string };
  if (!response.ok || !data.url) {
    throw new Error(data.error ?? "CHECKOUT_FAILED");
  }
  window.location.href = data.url;
}
