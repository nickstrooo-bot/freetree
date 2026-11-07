import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ThemeExtras } from "../theme-extras";
import type { ScheduledBlock } from "@kytelink/schemas";
import { evaluateScheduledBlock, formatCountdown } from "@kytelink/schemas/profile-data";

interface ScheduledBlockViewProps {
  block: ScheduledBlock;
  extras: ThemeExtras;
  linkColor: string;
  textShadow: string | undefined;
  isPreview?: boolean;
}

function normalizeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * A scheduled block: before startsAt it is a locked card with a live digital
 * countdown; at startsAt it becomes a normal link button; after endsAt it
 * disappears. The 1s ticker flips it without a reload, so a visitor watching
 * the countdown sees the link open — Kitab-Link's countdown-link-card pattern
 * (locked card + live countdown, real link after the moment), rebuilt on
 * FreeTree's booking-block visual language.
 */
export function ScheduledBlockView({
  block,
  extras,
  linkColor,
  textShadow,
  isPreview,
}: ScheduledBlockViewProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const state = evaluateScheduledBlock(block, new Date(now));
  if (state === "expired") return null;
  if (state === "upcoming" && !block.showCountdown) return null;

  const cardStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    width: "100%",
    minHeight: "56px",
    padding: "12px 16px",
    borderRadius: extras.linkRadius,
    background: extras.link.background,
    border: `2px solid ${linkColor}`,
    boxShadow: extras.link.boxShadow,
    backdropFilter: extras.link.backdropFilter,
    WebkitBackdropFilter: extras.link.backdropFilter,
    color: linkColor,
    textShadow,
    textDecoration: "none",
    cursor: "pointer",
  };

  if (state === "upcoming") {
    const startsAtMs = new Date(block.startsAt).getTime();
    return (
      <div
        className="kyte-link kyte-scheduled kyte-scheduled-locked"
        style={cardStyle}
        aria-disabled="true"
      >
        <span style={{ fontSize: "22px", lineHeight: 1 }} aria-hidden="true">
          ⏳
        </span>
        <span style={{ textAlign: "center" }}>
          <span style={{ display: "block", fontSize: "16px", fontWeight: 700 }}>
            {block.label}
          </span>
          <span
            style={{
              display: "block",
              fontSize: "15px",
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              fontFamily: "ui-monospace, monospace",
            }}
            suppressHydrationWarning
          >
            {formatCountdown(startsAtMs - now)}
          </span>
          <span style={{ display: "block", fontSize: "13px", fontWeight: 400, opacity: 0.85 }}>
            Unlocks{" "}
            {new Date(block.startsAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
          {block.description ? (
            <span style={{ display: "block", fontSize: "13px", fontWeight: 400, opacity: 0.85 }}>
              {block.description}
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <a
      className="kyte-link kyte-scheduled"
      href={normalizeHref(block.url)}
      target="_blank"
      rel="ugc nofollow noopener noreferrer"
      style={cardStyle}
      onClick={(event) => {
        if (isPreview) event.preventDefault();
      }}
      aria-label={`${block.label} (opens in a new tab)`}
    >
      <span style={{ fontSize: "22px", lineHeight: 1 }} aria-hidden="true">
        ⏰
      </span>
      <span style={{ textAlign: "center" }}>
        <span style={{ display: "block", fontSize: "16px", fontWeight: 700 }}>{block.label}</span>
        {block.description ? (
          <span style={{ display: "block", fontSize: "13px", fontWeight: 400, opacity: 0.85 }}>
            {block.description}
          </span>
        ) : null}
      </span>
    </a>
  );
}
