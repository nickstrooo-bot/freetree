import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FreeTreeQrCode, QR_BG_COLOR, QR_FG_COLOR } from "./qr-code";

describe("FreeTreeQrCode", () => {
  it("renders an SVG with the encoded value", () => {
    const html = renderToStaticMarkup(
      <FreeTreeQrCode value="https://getfreetree.com/testuser" size={200} />,
    );
    // react-qr-code renders an <svg> with the QR modules as <path> elements
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
  });

  it("uses FreeTree brand colors by default", () => {
    const html = renderToStaticMarkup(<FreeTreeQrCode value="https://getfreetree.com/testuser" />);
    expect(html).toContain(QR_FG_COLOR);
    expect(html).toContain(QR_BG_COLOR);
  });

  it("applies the id to the wrapper for download targeting", () => {
    const html = renderToStaticMarkup(
      <FreeTreeQrCode id="test-qr" value="https://getfreetree.com/testuser" />,
    );
    expect(html).toContain('id="test-qr"');
  });

  it("sets an accessible label", () => {
    const html = renderToStaticMarkup(
      <FreeTreeQrCode value="https://getfreetree.com/testuser" ariaLabel="QR for testuser" />,
    );
    expect(html).toContain('aria-label="QR for testuser"');
  });

  it("renders different output for different values", () => {
    const a = renderToStaticMarkup(<FreeTreeQrCode value="https://getfreetree.com/alice" />);
    const b = renderToStaticMarkup(<FreeTreeQrCode value="https://getfreetree.com/bob" />);
    expect(a).not.toBe(b);
  });
});
