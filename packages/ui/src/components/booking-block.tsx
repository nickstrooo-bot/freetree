import type { CSSProperties } from "react";
import type { ThemeExtras } from "../theme-extras";
import type { BookingBlock } from "@kytelink/schemas";

interface BookingBlockViewProps {
  block: BookingBlock;
  extras: ThemeExtras;
  linkColor: string;
  textShadow: string | undefined;
  isPreview?: boolean;
}

function normalizeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Prominent booking button for a seller's scheduling page (Calendly, Cal.com,
 * etc.). Styled like a highlighted link card so it stands out from regular
 * links without inventing a new visual language.
 */
export function BookingBlockView({ block, extras, linkColor, textShadow, isPreview }: BookingBlockViewProps) {
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

  return (
    <a
      className="kyte-link kyte-booking"
      href={normalizeHref(block.url)}
      target="_blank"
      rel="ugc nofollow noopener noreferrer"
      style={cardStyle}
      onClick={(event) => {
        if (isPreview) event.preventDefault();
      }}
      aria-label={`${block.label} (opens booking page in a new tab)`}
    >
      <span style={{ fontSize: "22px", lineHeight: 1 }} aria-hidden="true">
        📅
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
