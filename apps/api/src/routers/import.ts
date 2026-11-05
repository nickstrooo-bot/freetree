import { z } from "zod";
import { type ImportProposal, importProposalSchema, safeWebUrlSchema } from "@kytelink/schemas";
import { router } from "@kytelink/trpc";
import { authed } from "../trpc/procedures";
// FreeTree: AI-powered import (OpenAI) is disabled for $0 operation.
// The free deterministic HTML parser below handles Linktree and other platforms.
import {
  detectPlatform,
  emptyProposal,
  parseHtmlToProposal,
  parseLinktreeToProposal,
} from "../import/parsers";
import { ssrfSafeFetchText } from "../import/ssrf-fetch";

export async function buildProposal(
  url: string,
  _aiEnabled: boolean,
  html: string,
): Promise<ImportProposal> {
  // FreeTree: deterministic-only import. The AI extractor is disabled —
  // parseHtmlToProposal and parseLinktreeToProposal handle all platforms for free.
  const platform = detectPlatform(url);
  if (platform === "linktree") {
    const parsed = parseLinktreeToProposal(html);
    if (parsed) return parsed;
  }
  if (platform !== "generic") {
    const parsed = parseHtmlToProposal(html);
    if (parsed.links.length > 0 || parsed.displayName || parsed.description) return parsed;
  }
  return parseHtmlToProposal(html);
}

export const importRouter = router({
  fromUrl: authed
    .input(z.object({ url: safeWebUrlSchema }))
    .output(importProposalSchema)
    .mutation(async ({ ctx, input }) => {
      let proposal: ImportProposal;
      try {
        const html = await ssrfSafeFetchText(input.url);
        proposal = await buildProposal(input.url, ctx.config.capabilities.moderation, html);
      } catch {
        proposal = emptyProposal();
      }
      return proposal;
    }),
});
