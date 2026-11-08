import type { ProfileContent } from "@kytelink/schemas";
import { mockProfileByUsername } from "./mock-client";
import { isMockApi } from "./client";
import { signedInternalGet } from "./internal-hmac";

export interface PublishedProfileResult {
  status: "APPROVED" | "SUSPENDED" | "NOT_FOUND";
  content: ProfileContent | null;
  kyteId: string | null;
  ogImageUrl: string | null;
  suspensionReason: string | null;
  publishedAt: string | null;
  /** Completed purchases (product sales + tips) — the milestone meter's number. */
  supporterCount: number;
}

// The frozen internal payload (07-analytics / 06-api): profiles resolve to
// content + moderation status; `kyteId`/`ogImageUrl` are read opportunistically
// so a future contract addition needs no web change.
interface InternalProfilePayload {
  username: string;
  content: ProfileContent;
  publishSeq: number;
  // EFFECTIVE status: the API already folds an org-scoped suspension into this,
  // so a kyte with its own APPROVED verdict can still arrive as SUSPENDED.
  moderationStatus: string;
  suspensionReason?: string | null;
  kyteId?: string;
  ogImageUrl?: string | null;
  publishedAt?: string | null;
  supporterCount?: number;
}

const MISS: PublishedProfileResult = {
  status: "NOT_FOUND",
  content: null,
  kyteId: null,
  ogImageUrl: null,
  suspensionReason: null,
  publishedAt: null,
  supporterCount: 0,
};

export async function fetchPublishedProfile(username: string): Promise<PublishedProfileResult> {
  if (isMockApi()) {
    const { content, status, kyteId, suspensionReason } = mockProfileByUsername(username);
    return { status, content, kyteId, ogImageUrl: null, suspensionReason, publishedAt: null, supporterCount: 0 };
  }

  const response = await signedInternalGet(`/internal/profiles/${encodeURIComponent(username)}`);
  if (!response.ok) return MISS;

  const data = (await response.json()) as InternalProfilePayload;
  return {
    status: data.moderationStatus === "SUSPENDED" ? "SUSPENDED" : "APPROVED",
    content: data.content,
    kyteId: data.kyteId ?? null,
    ogImageUrl: data.ogImageUrl ?? null,
    suspensionReason: data.suspensionReason ?? null,
    publishedAt: data.publishedAt ?? null,
    // Payloads cached before the milestone meter shipped carry no count.
    supporterCount: data.supporterCount ?? 0,
  };
}
