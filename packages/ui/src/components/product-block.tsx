import type { CSSProperties } from "react";
import type { ThemeExtras } from "../theme-extras";

export interface PublicProduct {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  fileName: string | null;
}

export function formatProductPrice(priceCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(priceCents / 100);
  } catch {
    return `$${(priceCents / 100).toFixed(2)}`;
  }
}

interface ProductBlockProps {
  product: PublicProduct;
  extras: ThemeExtras;
  linkColor: string;
  textShadow: string | undefined;
  /** Called when the buyer clicks Buy. Parent handles checkout redirect. */
  onBuy: (product: PublicProduct) => void;
  buying?: boolean;
  checkoutEnabled: boolean;
}

export function ProductBlock({
  product,
  extras,
  linkColor,
  textShadow,
  onBuy,
  buying = false,
  checkoutEnabled,
}: ProductBlockProps) {
  const cardStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    width: "100%",
    padding: "16px",
    borderRadius: extras.linkRadius,
    background: extras.link.background,
    border: extras.link.border,
    boxShadow: extras.link.boxShadow,
    backdropFilter: extras.link.backdropFilter,
    WebkitBackdropFilter: extras.link.backdropFilter,
    color: linkColor,
    textShadow,
  };

  const buttonStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    minHeight: "48px",
    padding: "0 16px",
    borderRadius: "10px",
    border: "none",
    cursor: buying || !checkoutEnabled ? "not-allowed" : "pointer",
    fontSize: "16px",
    fontWeight: 700,
    color: "#FDF8F0",
    background: "#1B4332",
    opacity: buying || !checkoutEnabled ? 0.6 : 1,
  };

  return (
    <div className="freetree-product" data-product-id={product.id} style={cardStyle}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" }}>
        <span style={{ fontSize: "17px", fontWeight: 700, lineHeight: 1.3 }}>{product.name}</span>
        <span style={{ fontSize: "17px", fontWeight: 700, whiteSpace: "nowrap" }} aria-label={`Price: ${formatProductPrice(product.priceCents, product.currency)}`}>
          {formatProductPrice(product.priceCents, product.currency)}
        </span>
      </div>
      {product.description ? (
        <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.45, opacity: 0.85 }}>{product.description}</p>
      ) : null}
      <button
        type="button"
        style={buttonStyle}
        disabled={buying || !checkoutEnabled}
        onClick={() => onBuy(product)}
        aria-label={`Buy ${product.name} for ${formatProductPrice(product.priceCents, product.currency)}`}
      >
        {buying ? "Opening checkout…" : checkoutEnabled ? `Buy now` : "Selling coming soon"}
      </button>
      <p style={{ margin: 0, fontSize: "11px", opacity: 0.6, textAlign: "center" }}>
        Secure checkout · Seller keeps 96%
      </p>
    </div>
  );
}
