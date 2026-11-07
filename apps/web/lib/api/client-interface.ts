import type {
  AssetKind,
  OrgInvitePayload,
  ProfileContent,
  Role,
  KyteAccess,
} from "@kytelink/schemas";
import type {
  AccountInfo,
  AnalyticsOverview,
  AuditEntry,
  CountriesResult,
  DevicesResult,
  DomainRecord,
  ImportProposal,
  KyteGet,
  KyteSummary,
  Member,
  MyInvite,
  OrgStorage,
  OrgSummary,
  Passkey,
  PreviewLinkResult,
  ReferrersResult,
  ScheduleSummary,
  TimeSeriesResult,
  TopLinksResult,
} from "./types";

export interface UsernameCheck {
  available: boolean;
  reason: "empty" | "too_long" | "invalid_chars" | "reserved" | "unsafe_dot" | "taken" | null;
  suggestions: string[];
}

export interface AnalyticsWindow {
  kyteId: string;
  days: number;
}

export interface CommerceProduct {
  id: string;
  kyteId: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  fileName: string | null;
  fileSizeBytes: number | null;
  hasFile: boolean;
  externalUrl: string | null;
  kind: string;
  active: boolean;
  allowPromoCodes: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectStatus {
  configured: boolean;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface CommerceSale {
  id: string;
  productId: string;
  productName: string;
  buyerEmail: string | null;
  amountCents: number;
  feeCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

export interface CommerceSales {
  sales: CommerceSale[];
  nextCursor: string | null;
  totals: {
    grossCents: number;
    feesCents: number;
    netCents: number;
    count: number;
  };
}

export interface Tip {
  id: string;
  buyerEmail: string | null;
  amountCents: number;
  feeCents: number;
  tipMessage: string | null;
  currency: string;
  status: string;
  createdAt: string;
}

export interface TipList {
  tips: Tip[];
  nextCursor: string | null;
  totals: {
    grossCents: number;
    feesCents: number;
    netCents: number;
    count: number;
  };
}

export interface EmailCaptureBlock {
  id: string;
  kyteId: string;
  heading: string;
  description: string | null;
  buttonText: string;
  pendingText: string;
  successText: string;
  active: boolean;
  sortOrder: number;
  subscriberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailSubscriber {
  id: string;
  email: string;
  status: string;
  confirmedAt: string | null;
  createdAt: string;
}

interface CreateUploadResult {
  assetId: string;
  uploadUrl: string;
  fields: Record<string, string> | null;
  key: string;
}

export interface ApiClient {
  org: {
    listMine(): Promise<{ orgs: OrgSummary[] }>;
    create(input: { name?: string }): Promise<{ orgId: string }>;
    rename(input: { orgId: string; name: string }): Promise<void>;
    delete(input: { orgId: string; confirm: string }): Promise<void>;
    storage(input: { orgId: string }): Promise<OrgStorage>;
    leave(input: { orgId: string }): Promise<void>;
    auditLog(input: {
      orgId?: string;
      kyteId?: string;
      action?: string;
      actorUserId?: string;
    }): Promise<{ entries: AuditEntry[]; nextCursor: string | null }>;
  };
  kyte: {
    get(input: { kyteId: string }): Promise<KyteGet>;
    create(input: { orgId?: string; username: string }): Promise<{ kyteId: string }>;
    updateDraft(input: {
      kyteId: string;
      content: ProfileContent;
      baseUpdatedAt: string;
    }): Promise<{ updatedAt: string }>;
    publish(input: { kyteId: string }): Promise<{ publishSeq: number; publishedAt: string }>;
    checkUsername(input: { username: string; kyteId?: string }): Promise<UsernameCheck>;
    changeUsername(input: { kyteId: string; username: string }): Promise<void>;
    delete(input: { kyteId: string; confirm: string }): Promise<void>;
  };
  team: {
    members(input: { orgId: string }): Promise<{ members: Member[] }>;
    invite(input: { orgId: string } & OrgInvitePayload): Promise<{ inviteId: string }>;
    revokeInvite(input: { inviteId: string }): Promise<void>;
    updateAccess(input: {
      orgId: string;
      membershipId: string;
      role: Role;
      kyteAccess: KyteAccess;
      kyteGrants?: { kyteId: string; role: Role }[];
    }): Promise<void>;
    removeMember(input: { orgId: string; membershipId: string }): Promise<void>;
  };
  invites: {
    listMine(): Promise<{ invites: MyInvite[] }>;
    accept(input: { inviteId: string }): Promise<{ orgId: string }>;
    decline(input: { inviteId: string }): Promise<void>;
  };
  domains: {
    list(input: { kyteId: string }): Promise<{ domains: DomainRecord[] }>;
    add(input: { kyteId: string; host: string }): Promise<DomainRecord>;
    status(input: { domainId: string }): Promise<{ status: DomainRecord["status"]; records: DomainRecord["records"] }>;
    verify(input: { domainId: string }): Promise<{ status: DomainRecord["status"]; records: DomainRecord["records"] }>;
    remove(input: { domainId: string }): Promise<void>;
  };
  schedule: {
    list(input: { kyteId: string }): Promise<{ schedules: ScheduleSummary[] }>;
    create(input: { kyteId: string; scheduledFor: string; timezone: string }): Promise<{ scheduleId: string }>;
    updateSnapshot(input: { scheduleId: string }): Promise<void>;
    reschedule(input: { scheduleId: string; scheduledFor: string; timezone: string }): Promise<void>;
    cancel(input: { scheduleId: string }): Promise<void>;
  };
  preview: {
    ensure(input: { kyteId: string }): Promise<PreviewLinkResult>;
    rotate(input: { kyteId: string }): Promise<PreviewLinkResult>;
    verify(input: {
      token: string;
      passcode: string;
    }): Promise<{ content: ProfileContent; username: string | null } | null>;
  };
  import: {
    fromUrl(input: { url: string }): Promise<ImportProposal>;
  };
  assets: {
    createUploadUrl(input: {
      kyteId: string;
      kind: AssetKind;
      contentType: string;
      sizeBytes: number;
    }): Promise<CreateUploadResult>;
    finalize(input: { assetId: string }): Promise<{ url: string; lqip: string | null }>;
  };
  analytics: {
    overview(input: AnalyticsWindow): Promise<AnalyticsOverview>;
    timeSeries(input: AnalyticsWindow): Promise<TimeSeriesResult>;
    topLinks(input: AnalyticsWindow): Promise<TopLinksResult>;
    referrers(input: AnalyticsWindow): Promise<ReferrersResult>;
    devices(input: AnalyticsWindow): Promise<DevicesResult>;
    countries(input: AnalyticsWindow): Promise<CountriesResult>;
  };
  account: {
    get(): Promise<AccountInfo>;
    changeEmail(input: { newEmail: string }): Promise<{ ok: true; otpSent: boolean }>;
    setAvatar(input: { image: string | null }): Promise<void>;
    passkeys: {
      list(): Promise<{ passkeys: Passkey[] }>;
      add(input: { name: string }): Promise<void>;
      rename(input: { id: string; name: string }): Promise<void>;
      remove(input: { id: string }): Promise<void>;
    };
  };
  commerce: {
    listProducts(input: { kyteId: string }): Promise<{ products: CommerceProduct[] }>;
    createProduct(input: {
      kyteId: string;
      name: string;
      description?: string;
      priceCents: number;
      currency?: string;
      fileBase64?: string;
      fileName?: string;
      externalUrl?: string;
      allowPromoCodes?: boolean;
    }): Promise<CommerceProduct>;
    updateProduct(input: {
      kyteId: string;
      productId: string;
      name?: string;
      description?: string | null;
      priceCents?: number;
      fileBase64?: string | null;
      fileName?: string | null;
      externalUrl?: string | null;
      active?: boolean;
      allowPromoCodes?: boolean;
      sortOrder?: number;
    }): Promise<CommerceProduct>;
    deleteProduct(input: { kyteId: string; productId: string }): Promise<void>;
    getConnectStatus(input: { kyteId: string }): Promise<ConnectStatus>;
    createOnboardingLink(input: {
      kyteId: string;
      returnUrl: string;
      refreshUrl: string;
    }): Promise<{ url: string }>;
    getSales(input: {
      kyteId: string;
      limit?: number;
      cursor?: string;
    }): Promise<CommerceSales>;
  };
  emailCapture: {
    getBlock(input: { kyteId: string }): Promise<{ block: EmailCaptureBlock | null }>;
    upsertBlock(input: {
      kyteId: string;
      heading?: string;
      description?: string | null;
      buttonText?: string;
      pendingText?: string;
      successText?: string;
      active?: boolean;
      sortOrder?: number;
    }): Promise<EmailCaptureBlock>;
    deleteBlock(input: { kyteId: string }): Promise<{ ok: true }>;
    listSubscribers(input: {
      kyteId: string;
      status?: "pending" | "confirmed" | "unsubscribed" | "all";
      limit?: number;
      cursor?: string;
    }): Promise<{ subscribers: EmailSubscriber[]; nextCursor: string | null }>;
    deleteSubscriber(input: { kyteId: string; subscriberId: string }): Promise<{ ok: true }>;
    exportCsv(input: { kyteId: string }): Promise<{ csv: string; filename: string }>;
  };
  tipJar: {
    listTips(input: {
      kyteId: string;
      limit?: number;
      cursor?: string;
    }): Promise<TipList>;
  };
  resolveKyteSummary(kyteId: string): Promise<KyteSummary | null>;
}
