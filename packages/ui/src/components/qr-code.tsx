import QRCode from "react-qr-code";

// FreeTree brand colors for QR codes. Dark green on warm off-white keeps the
// code scannable while matching the FreeTree look. Standard black-on-white
// contrast ratios are preserved (both directions exceed 4.5:1).
export const QR_FG_COLOR = "#1B4332";
export const QR_BG_COLOR = "#FDF8F0";

export interface FreeTreeQrCodeProps {
  /** The URL or text to encode. For profiles this is the full profile URL. */
  value: string;
  /** Rendered size in pixels (the SVG is square). Defaults to 200. */
  size?: number;
  /** Module (dark square) color. Defaults to FreeTree green. */
  fgColor?: string;
  /** Background color. Defaults to FreeTree off-white. */
  bgColor?: string;
  /** Accessible label for screen readers. */
  ariaLabel?: string;
  /** Id on the wrapper, used to locate the SVG for download. */
  id?: string;
}

// Shared QR renderer. Static codes only: the value is encoded directly, no
// server round-trip, no redirect service, no tracking. What you see is what
// scans — free forever, matching FreeTree's promise.
//
// To download: give the component an `id`, then use findQrSvg(id) from
// apps/web/lib/qr-download.ts to locate the rendered <svg>.
export function FreeTreeQrCode({
  value,
  size = 200,
  fgColor = QR_FG_COLOR,
  bgColor = QR_BG_COLOR,
  ariaLabel = "QR code",
  id,
}: FreeTreeQrCodeProps) {
  return (
    <div
      id={id}
      role="img"
      aria-label={ariaLabel}
      style={{
        display: "inline-block",
        padding: "12px",
        background: bgColor,
        borderRadius: "12px",
        lineHeight: 0,
      }}
    >
      <QRCode value={value} size={size} fgColor={fgColor} bgColor={bgColor} aria-label={ariaLabel} />
    </div>
  );
}
