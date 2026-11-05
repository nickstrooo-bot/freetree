import { useEffect, useState } from "react";
import { QrCode as QrCodeIcon } from "lucide-react";
// Deep import, not the @kytelink/ui barrel: the barrel re-exports ./motion and
// the six analytics charts, which the public profile never renders but would
// otherwise ship to every visitor.
import { FreeTreeQrCode, QR_BG_COLOR } from "@kytelink/ui";
import { ProfileView } from "@kytelink/ui/profile-view";
import type { PublicProduct, PublicEmailCaptureBlock } from "@kytelink/ui";
import type { Icon, Link, ProfileContent } from "@kytelink/schemas";
import { sendEventBeacon, sendLinkBeacon, sendPageBeacon } from "../../lib/beacons";
import { startCheckout } from "../../lib/api/products-fetch";
import { subscribeEmail } from "../../lib/api/email-capture-fetch";
import { Modal } from "../ui/modal";
import { Button } from "../ui/button";
import { SHARE_DOMAINS } from "../../consts/brand";
import { downloadQrPng, findQrSvg } from "../../lib/qr-download";

export interface PublicProfileProps {
  content: ProfileContent;
  username: string;
  kyteId: string | null;
  products?: PublicProduct[];
  checkoutEnabled?: boolean;
  emailCaptureBlock?: PublicEmailCaptureBlock | null;
}

const QR_CONTAINER_ID = "freetree-public-qr";

function QrModal({
  open,
  onClose,
  url,
  username,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  username: string;
}) {
  function handleDownload() {
    const svg = findQrSvg(QR_CONTAINER_ID);
    if (!svg) return;
    downloadQrPng(svg, `freetree-${username}-qr`, QR_BG_COLOR);
  }

  return (
    <Modal open={open} onClose={onClose} title="Scan to open this FreeTree" maxWidth={340}>
      <div className="flex flex-col items-center gap-4 py-2">
        <FreeTreeQrCode
          id={QR_CONTAINER_ID}
          value={url}
          size={220}
          ariaLabel={`QR code linking to ${username}'s FreeTree page`}
        />
        <p className="text-center text-sm text-muted-foreground">
          Point your phone camera at the code to open this page.
        </p>
        <Button onClick={handleDownload} variant="primary">
          Download PNG
        </Button>
      </div>
    </Modal>
  );
}

export function PublicProfile({
  content,
  username,
  kyteId,
  products = [],
  checkoutEnabled = false,
  emailCaptureBlock = null,
}: PublicProfileProps) {
  const [qrOpen, setQrOpen] = useState(false);
  const [buyingProductId, setBuyingProductId] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);
  const profileUrl = `https://${SHARE_DOMAINS[0]}/${username}`;

  useEffect(() => {
    if (!kyteId) return;
    const referrer = typeof document !== "undefined" ? document.referrer : undefined;
    sendPageBeacon({ kyteId, username, referrer });
  }, [kyteId, username]);

  function onLinkClick(link: Link) {
    if (!kyteId) return;
    const referrer = typeof document !== "undefined" ? document.referrer : undefined;
    sendLinkBeacon({ kyteId, username, referrer, linkUrl: link.link, linkTitle: link.title });
  }

  function onIconClick(icon: Icon) {
    if (!kyteId) return;
    const referrer = typeof document !== "undefined" ? document.referrer : undefined;
    sendLinkBeacon({
      kyteId,
      username,
      referrer,
      linkUrl: icon.url ?? "",
      linkTitle: icon.name,
    });
  }

  function onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("[data-kytelink-watermark]")) {
      sendEventBeacon("watermark_click", { username });
    }
  }

  async function onProductBuy(product: PublicProduct) {
    setBuyError(null);
    setBuyingProductId(product.id);
    try {
      await startCheckout(product.id);
      // startCheckout redirects to Stripe on success; we never get here.
    } catch (error) {
      setBuyingProductId(null);
      setBuyError(
        error instanceof Error && error.message === "SELLER_NOT_READY"
          ? "This seller hasn't finished setting up payments yet. Try again soon."
          : "Couldn't start checkout. Please try again.",
      );
    }
  }

  return (
    <div className="relative min-h-screen" onClickCapture={onClickCapture}>
      <ProfileView
        content={content}
        username={username}
        onLinkClick={onLinkClick}
        onIconClick={onIconClick}
        products={products}
        onProductBuy={onProductBuy}
        buyingProductId={buyingProductId}
        checkoutEnabled={checkoutEnabled}
        emailCaptureBlock={emailCaptureBlock}
        onEmailSubscribe={(email) => subscribeEmail(username, email)}
      />
      {buyError ? (
        <div
          role="alert"
          className="mx-auto mt-2 max-w-md rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-center text-sm text-red-800"
        >
          {buyError}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setQrOpen(true)}
        aria-label="Show QR code for this page"
        title="Show QR code"
        className="fixed top-4 right-4 z-40 flex size-10 items-center justify-center rounded-full border border-black/10 bg-white/90 text-neutral-700 shadow-sm backdrop-blur transition-transform hover:scale-105 active:scale-95"
      >
        <QrCodeIcon className="size-5" aria-hidden="true" />
      </button>
      <QrModal open={qrOpen} onClose={() => setQrOpen(false)} url={profileUrl} username={username} />
    </div>
  );
}
