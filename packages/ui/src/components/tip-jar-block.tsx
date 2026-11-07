import { useState, type CSSProperties, type FormEvent } from "react";
import type { ThemeExtras } from "../theme-extras";
import { formatProductPrice } from "./product-block";

// ─── Tip jar block (public profile) ──────────────────────────────────────────
// "Leave a tip" card: preset amount buttons + an optional message, then one
// Tip button that hands the chosen amount to the parent (which starts Stripe
// Checkout). No file, no download — the thanks page just says thank you.
// Mirrors EmailSignupBlock's card styling so the profile stays consistent.

export interface PublicTipJar {
  heading: string;
  message: string | null;
  amountsCents: number[];
}

interface TipJarBlockProps {
  jar: PublicTipJar;
  extras: ThemeExtras;
  linkColor: string;
  textShadow: string | undefined;
  /** Called when the visitor tips. Parent handles the checkout redirect. */
  onTip: (amountCents: number, tipMessage?: string) => Promise<void>;
  tipping?: boolean;
  checkoutEnabled: boolean;
}

type Status = "idle" | "submitting" | "error";

export function TipJarBlock({
  jar,
  extras,
  linkColor,
  textShadow,
  onTip,
  tipping = false,
  checkoutEnabled,
}: TipJarBlockProps) {
  const [selected, setSelected] = useState<number>(jar.amountsCents[0] ?? 300);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const cardStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    width: "100%",
    padding: "18px",
    borderRadius: extras.linkRadius,
    background: extras.link.background,
    border: extras.link.border,
    boxShadow: extras.link.boxShadow,
    backdropFilter: extras.link.backdropFilter,
    WebkitBackdropFilter: extras.link.backdropFilter,
    color: linkColor,
    textShadow,
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: "10px",
    border: "1px solid rgba(128,128,128,0.35)",
    background: "rgba(255,255,255,0.85)",
    color: "#1a1a1a",
    fontSize: "15px",
    outline: "none",
    textShadow: "none",
  };

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (status === "submitting" || tipping) return;
    setStatus("submitting");
    setErrorMsg("");
    try {
      await onTip(selected, message.trim() || undefined);
      // onTip redirects to Stripe on success; we never get here.
    } catch {
      setStatus("error");
      setErrorMsg("Couldn't start checkout. Please try again.");
    }
  }

  return (
    <form
      data-freetree-tip-jar=""
      onSubmit={handleSubmit}
      style={cardStyle}
    >
      <div style={{ fontSize: "17px", fontWeight: 700 }}>{jar.heading}</div>
      {jar.message ? (
        <div style={{ fontSize: "14px", opacity: 0.85 }}>{jar.message}</div>
      ) : null}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {jar.amountsCents.map((amount) => (
          <button
            key={amount}
            type="button"
            onClick={() => setSelected(amount)}
            aria-pressed={selected === amount}
            style={{
              padding: "10px 16px",
              borderRadius: "10px",
              border:
                selected === amount
                  ? "2px solid currentColor"
                  : "1px solid rgba(128,128,128,0.35)",
              background: selected === amount ? "rgba(128,128,128,0.12)" : "transparent",
              color: "inherit",
              fontSize: "15px",
              fontWeight: selected === amount ? 700 : 500,
              cursor: "pointer",
            }}
          >
            {formatProductPrice(amount, "usd")}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={message}
        maxLength={500}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Leave a message (optional)"
        aria-label="Message with your tip (optional)"
        style={inputStyle}
      />
      <button
        type="submit"
        disabled={status === "submitting" || tipping || !checkoutEnabled}
        style={{
          width: "100%",
          padding: "12px 14px",
          borderRadius: "10px",
          border: "none",
          background: "#1B4332",
          color: "#FDF8F0",
          fontSize: "15px",
          fontWeight: 700,
          cursor: checkoutEnabled ? "pointer" : "not-allowed",
          opacity: checkoutEnabled ? 1 : 0.6,
        }}
      >
        {status === "submitting" || tipping
          ? "Starting checkout…"
          : `Tip ${formatProductPrice(selected, "usd")}`}
      </button>
      {status === "error" ? (
        <div role="alert" style={{ fontSize: "13px", color: "#b91c1c", textShadow: "none" }}>
          {errorMsg}
        </div>
      ) : null}
      {!checkoutEnabled ? (
        <div style={{ fontSize: "13px", opacity: 0.75 }}>
          Tips aren&apos;t set up on this page yet.
        </div>
      ) : null}
    </form>
  );
}
