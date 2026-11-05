import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { PageHead } from "../../components/seo/page-head";

interface OrderState {
  status: string;
  productName: string;
  downloadUrl: string | null;
  expiresAt: string | null;
}

/**
 * Buyer landing page after Stripe Checkout. Polls the order status until the
 * webhook marks the purchase completed, then reveals the download link.
 */
export function ThanksPage() {
  const router = useRouter();
  const username = typeof router.query.username === "string" ? router.query.username : "";
  const sessionId = typeof router.query.session_id === "string" ? router.query.session_id : "";

  const [order, setOrder] = useState<OrderState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let attempts = 0;

    async function poll() {
      attempts += 1;
      try {
        const base = process.env.NEXT_PUBLIC_API_URL ?? "";
        const response = await fetch(
          `${base}/commerce/order/${encodeURIComponent(sessionId)}`,
        );
        if (!response.ok) {
          if (!cancelled && attempts < 20) setTimeout(poll, 3000);
          else if (!cancelled) setError("Couldn't find your order. Check your email for the receipt.");
          return;
        }
        const data = (await response.json()) as OrderState;
        if (cancelled) return;
        setOrder(data);
        // Keep polling while the webhook hasn't confirmed payment yet.
        if (data.status === "pending" && attempts < 20) {
          setTimeout(poll, 3000);
        }
      } catch {
        if (!cancelled && attempts < 20) setTimeout(poll, 3000);
        else if (!cancelled) setError("Something went wrong. Check your email for the receipt.");
      }
    }

    void poll();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <>
      <PageHead title="Thank you | FreeTree" noindex />
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#FDF8F0",
          color: "#1B4332",
          fontFamily: "sans-serif",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "28px", margin: "0 0 12px" }}>Thank you! 🎉</h1>
        {error ? (
          <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>
        ) : !order ? (
          <p>Confirming your payment…</p>
        ) : order.status === "pending" ? (
          <p>Payment processing — your download will appear here in a moment…</p>
        ) : order.status === "completed" && order.downloadUrl ? (
          <>
            <p style={{ margin: "0 0 16px" }}>
              Your purchase of <strong>{order.productName}</strong> is ready.
            </p>
            <a
              href={order.downloadUrl}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: "52px",
                padding: "0 32px",
                borderRadius: "12px",
                background: "#1B4332",
                color: "#FDF8F0",
                fontSize: "17px",
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Download now
            </a>
            {order.expiresAt ? (
              <p style={{ fontSize: "13px", opacity: 0.7, marginTop: "12px" }}>
                Link expires {new Date(order.expiresAt).toLocaleDateString()} · save your file
              </p>
            ) : null}
          </>
        ) : (
          <p>This order was refunded. Contact the seller if you have questions.</p>
        )}
        {username ? (
          <a
            href={`/${encodeURIComponent(username)}`}
            style={{ marginTop: "24px", fontSize: "14px", color: "#1B4332" }}
          >
            ← Back to {username}&apos;s page
          </a>
        ) : null}
      </div>
    </>
  );
}

export default ThanksPage;
