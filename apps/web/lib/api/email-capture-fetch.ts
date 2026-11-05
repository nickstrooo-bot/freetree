import type { PublicEmailCaptureBlock } from "@kytelink/ui";

const EMPTY: { block: PublicEmailCaptureBlock | null } = { block: null };

/**
 * Server-side fetch of a profile's email capture block. Best-effort: any
 * failure returns null so an email-capture outage never breaks the page.
 */
export async function fetchPublicEmailCapture(
  username: string,
): Promise<{ block: PublicEmailCaptureBlock | null }> {
  const base = process.env.API_BASE_URL ?? "http://localhost:3003";
  try {
    const response = await fetch(
      `${base}/email-capture/block/${encodeURIComponent(username.toLowerCase())}`,
    );
    if (!response.ok) return EMPTY;
    const data = (await response.json()) as { block?: PublicEmailCaptureBlock | null };
    return { block: data.block ?? null };
  } catch {
    return EMPTY;
  }
}

/** Client-side: submit an email to a profile's list (starts double opt-in). */
export async function subscribeEmail(
  username: string,
  email: string,
): Promise<{ alreadySubscribed: boolean }> {
  const base =
    process.env.NEXT_PUBLIC_API_URL ?? (typeof window !== "undefined" ? "" : "http://localhost:3003");
  const response = await fetch(`${base}/email-capture/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email }),
  });
  const data = (await response.json()) as { ok?: boolean; alreadySubscribed?: boolean; error?: string };
  if (!response.ok || !data.ok) {
    throw new Error(data.error ?? "SUBSCRIBE_FAILED");
  }
  return { alreadySubscribed: Boolean(data.alreadySubscribed) };
}
