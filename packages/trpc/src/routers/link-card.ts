import { linkCardFetchInputSchema, linkCardFetchResultSchema } from "@kytelink/schemas";
import { authedProcedure, router } from "../trpc";
import { notImplemented } from "../errors";

// ─── FreeTree Photo Link-Card contract ───────────────────────────────────────
// OpenGraph auto-fetch on link add (LinkPage pattern, BSD-2-Clause — rebuild
// the logic, do not port code). Every procedure here throws notImplemented;
// the concrete implementation lives in apps/api/src/routers/link-card.ts and
// must conform to these shapes.
//
// The seller pastes a URL in the editor; the editor calls linkCard.fetch and
// pre-fills the link's title + a rich card (photo + title + description) from
// the page's OpenGraph metadata. The card is stored on the Link itself and
// rendered by ProfileView. A null card means "no usable metadata / fetch
// failed" — the editor keeps the seller's manual title, never an error.

export const linkCardRouter = router({
  // ── Seller: fetch OpenGraph metadata for a pasted URL ───────────────────
  // Authenticated (any signed-in seller — no kyte scope, the URL is not
  // saved by this call). Rate-limited by the shared trpc-write middleware.
  // The server-side fetch is SSRF-guarded in
  // apps/api/src/link-card/open-graph.ts (http/https only, private/loopback/
  // link-local hosts blocked, 5s timeout, 1 MB cap, max 5 redirects).
  fetch: authedProcedure
    .input(linkCardFetchInputSchema)
    .output(linkCardFetchResultSchema)
    .mutation(() => {
      throw notImplemented("linkCard.fetch");
    }),
});
