import { useState, type CSSProperties, type FormEvent } from "react";
import type { ThemeExtras } from "../theme-extras";

export interface PublicEmailCaptureBlock {
  heading: string;
  description: string | null;
  buttonText: string;
  pendingText: string;
  successText: string;
}

interface EmailSignupBlockProps {
  block: PublicEmailCaptureBlock;
  extras: ThemeExtras;
  linkColor: string;
  textShadow: string | undefined;
  /** Called when the visitor submits. Parent handles the API call. */
  onSubscribe: (email: string) => Promise<{ alreadySubscribed: boolean }>;
}

type Status = "idle" | "submitting" | "pending" | "done" | "error";

export function EmailSignupBlock({
  block,
  extras,
  linkColor,
  textShadow,
  onSubscribe,
}: EmailSignupBlockProps) {
  const [email, setEmail] = useState("");
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

  const buttonStyle: CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: "10px",
    border: "none",
    background: "#1B4332",
    color: "#FDF8F0",
    fontSize: "15px",
    fontWeight: 600,
    cursor: status === "submitting" ? "wait" : "pointer",
    opacity: status === "submitting" ? 0.7 : 1,
  };

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setErrorMsg("Please enter a valid email address.");
      setStatus("error");
      return;
    }
    setStatus("submitting");
    setErrorMsg("");
    try {
      const result = await onSubscribe(trimmed);
      setStatus(result.alreadySubscribed ? "done" : "pending");
    } catch {
      setErrorMsg("Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div data-freetree-email-capture="" style={cardStyle}>
      <div style={{ fontSize: "16px", fontWeight: 700 }}>{block.heading}</div>
      {block.description ? (
        <div style={{ fontSize: "14px", opacity: 0.85, lineHeight: 1.45 }}>{block.description}</div>
      ) : null}

      {status === "done" ? (
        <div style={{ fontSize: "14px", fontWeight: 600 }}>✅ {block.successText}</div>
      ) : status === "pending" ? (
        <div style={{ fontSize: "14px", lineHeight: 1.5 }}>📬 {block.pendingText}</div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <label htmlFor="freetree-email-input" style={{ position: "absolute", left: "-9999px" }}>
            Email address
          </label>
          <input
            id="freetree-email-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            disabled={status === "submitting"}
            style={inputStyle}
          />
          {status === "error" && errorMsg ? (
            <div style={{ fontSize: "13px", color: "#b91c1c", textShadow: "none" }}>{errorMsg}</div>
          ) : null}
          <button type="submit" disabled={status === "submitting"} style={buttonStyle}>
            {status === "submitting" ? "Subscribing…" : block.buttonText}
          </button>
          <div style={{ fontSize: "11px", opacity: 0.6, textAlign: "center", textShadow: "none" }}>
            No spam, unsubscribe anytime.
          </div>
        </form>
      )}
    </div>
  );
}
