import { router } from "@kytelink/trpc";
import { linkCardFetchInputSchema, linkCardFetchResultSchema } from "@kytelink/schemas";
import { authed } from "../trpc/procedures";
import { fetchOpenGraph, LinkCardFetchError } from "../link-card/open-graph";
import { taggedLogger } from "../logger";

const log = taggedLogger("link-card");

// ─── FreeTree Photo Link-Card — concrete tRPC router ─────────────────────────
// OpenGraph auto-fetch on link add (LinkPage pattern, BSD-2-Clause — rebuild
// the logic, do not port code). The contract lives in
// packages/trpc/src/routers/link-card.ts; the fetch + SSRF guards live in
// ../link-card/open-graph.ts.
//
// Fail-quiet by design: any guard or network failure returns { card: null }
// and the editor keeps the seller's manual title. A missing preview is never
// a save error, and the reason is logged server-side for debugging.

export const linkCardRouter = router({
  fetch: authed
    .input(linkCardFetchInputSchema)
    .output(linkCardFetchResultSchema)
    .mutation(async ({ input }) => {
      try {
        return await fetchOpenGraph(input.url);
      } catch (error) {
        if (error instanceof LinkCardFetchError) {
          log.info(
            { url: input.url, code: error.code },
            "link-card fetch failed, returning no card",
          );
          return { card: null, fetchedUrl: input.url };
        }
        throw error;
      }
    }),
});
