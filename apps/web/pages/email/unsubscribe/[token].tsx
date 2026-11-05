import { useEffect, useState } from "react";
import { useRouter } from "next/router";

type State = "loading" | "ok" | "error";

export default function UnsubscribePage() {
  const router = useRouter();
  const { token } = router.query;
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    if (typeof token !== "string" || !token) return;
    const base = process.env.NEXT_PUBLIC_API_URL ?? "";
    fetch(`${base}/email-capture/unsubscribe/${encodeURIComponent(token)}`)
      .then((res) => setState(res.ok ? "ok" : "error"))
      .catch(() => setState("error"));
  }, [token]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-card border border-cardline bg-card px-8 py-12 text-center">
        {state === "loading" && (
          <>
            <p className="text-2xl" aria-hidden="true">⏳</p>
            <p className="mt-3 text-sm text-secondary">Unsubscribing…</p>
          </>
        )}
        {state === "ok" && (
          <>
            <p className="text-2xl" aria-hidden="true">👋</p>
            <h1 className="mt-3 text-lg font-semibold text-ink">You're unsubscribed</h1>
            <p className="mt-2 text-sm text-secondary">
              You won't hear from this list again. Sorry to see you go —
              you're welcome back anytime.
            </p>
          </>
        )}
        {state === "error" && (
          <>
            <p className="text-2xl" aria-hidden="true">😕</p>
            <h1 className="mt-3 text-lg font-semibold text-ink">Couldn't unsubscribe</h1>
            <p className="mt-2 text-sm text-secondary">
              That link doesn't look valid. If you keep getting emails,
              reply to one and ask to be removed.
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

UnsubscribePage.bare = true;
