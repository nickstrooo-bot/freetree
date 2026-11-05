// Client-side QR download helpers. The QR SVG is rendered by
// FreeTreeQrCode (@kytelink/ui); these serialize it for download without any
// server round-trip.

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(clone);
}

/** Download the QR code as an .svg file. */
export function downloadQrSvg(svg: SVGSVGElement, filename: string) {
  const source = serializeSvg(svg);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  triggerDownload(href, filename.endsWith(".svg") ? filename : `${filename}.svg`);
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

/**
 * Download the QR code as a .png file.
 * Renders the SVG to a canvas at 4x for crisp print quality.
 */
export function downloadQrPng(svg: SVGSVGElement, filename: string, bgColor = "#FDF8F0", scale = 4) {
  const source = serializeSvg(svg);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const img = new Image();

  img.onload = () => {
    const size = (svg.viewBox?.baseVal?.width || 200) * scale;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(href);
      return;
    }
    // Paint the QR background color so the PNG isn't transparent.
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    URL.revokeObjectURL(href);
    triggerDownload(canvas.toDataURL("image/png"), filename.endsWith(".png") ? filename : `${filename}.png`);
  };

  img.onerror = () => URL.revokeObjectURL(href);
  img.src = href;
}

/** Find the QR <svg> inside a FreeTreeQrCode wrapper by its container id. */
export function findQrSvg(containerId: string): SVGSVGElement | null {
  const container = document.getElementById(containerId);
  return container?.querySelector("svg") ?? null;
}
