import { useEffect, useState } from "react";
import { useRouter } from "next/router";

type State = "loading" | "ok" | "expired" | "error";

export default function ConfirmEmailPage() {
  const router = useRouter();
  const { token } = router.query;
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    if (typeof token !== "string" || !token) return;
    const base = process.env.NEXT_PUBLIC_API_URL ?? "";
    fetch(`${base}/email-capture/confirm/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (res.ok) {
          setState("ok");
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setState(data.error === "EXPIRED" ? "expired" : "error");
      })
      .catch(() => setState("error"));
  }, [token]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-card border border-cardline bg-card px-8 py-12 text-center">
        {state === "loading" && (
          <>
            <p className="text-2xl" aria-hidden="true">⏳</p>
            <p className="mt-3 text-sm text-secondary">Confirming your subscription…</p>
          </>
        )}
        {state === "ok" && (
          <>
            <p className="text-2xl" aria-hidden="true">✅</p>
            <h1 className="mt-3 text-lg font-semibold text-ink">You're subscribed!</h1>
            <p className="mt-2 text-sm text-secondary">
              Thanks for confirming. You'll hear from us soon — and you can
              unsubscribe anytime with one click.
            </p>
          </>
        )}
        {state === "expired" && (
          <>
            <p className="text-2xl" aria-hidden="true">⌛</p>
            <h1 className="mt-3 text-lg font-semibold text-ink">That link expired</h1>
            <p className="mt-2 text-sm text-secondary">
              Confirmation links last 48 hours. Head back to the page and
              sign up again — we'll send a fresh one.
            </p>
          </>
        )}
        {state === "error" && (
          <>
            <p className="text-2xl" aria-hidden="true">😕</p>
            <h1 className="mt-3 text-lg font-semibold text-ink">Couldn't confirm</h1>
            <p className="mt-2 text-sm text-secondary">
              That link doesn't look valid. Try signing up again from the page.
            </p>
          </>
        )}
        <p className="mt-6 text-[11px] text-tertiary">
          Powered by <span className="font-semibold">FreeTree</span> — free forever.
        </p>
      </div>
    </div>
  );
}

ConfirmEmailPage.bare = true;
