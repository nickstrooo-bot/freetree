import {
  type ProfileContent,
  profileContentSchema,
  type ThemeKey,
  themeKeySchema,
  aboutSchema,
  liveBadgeSchema,
  milestoneSchema,
  nowLineSchema,
  scheduledBlockSchema,
  tipJarSchema,
} from "@kytelink/schemas";
import { Prisma } from "@kytelink/db";

interface ContentColumns {
  displayName: string | null;
  description: string | null;
  theme: string;
  customFont: string | null;
  customColor: string | null;
  customBackground: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  redirectUrl: string | null;
  shouldRedirect: boolean;
  hideWatermark: boolean;
  links: unknown;
  icons: unknown;
  bookingBlocks: unknown;
  scheduledBlocks: unknown;
  liveBadge: unknown;
  tipJar: unknown;
  about: unknown;
  nowLine: unknown;
  milestone: unknown;
}

function safeTheme(theme: string): ThemeKey {
  const parsed = themeKeySchema.safeParse(theme);
  return parsed.success ? parsed.data : "default";
}

export function columnsToContent(row: ContentColumns): ProfileContent {
  // A malformed stored jar must never break the whole profile — fall back
  // to no jar and let the seller re-save it from the editor.
  const tipJarParsed = tipJarSchema.safeParse(row.tipJar);
  // Same guard for scheduled blocks: a malformed stored block drops just the
  // scheduled section, never the whole profile.
  const scheduledParsed = scheduledBlockSchema.array().safeParse(row.scheduledBlocks);
  // And for the live badge: malformed stored config means no badge.
  const liveBadgeParsed = liveBadgeSchema.safeParse(row.liveBadge);
  // Same guard for the soul blocks: a malformed stored value drops just that
  // block, never the whole profile. (about is a TEXT column so it can only
  // ever be a string or null, but a row written outside the editor could
  // still exceed the length cap — guard it the same way.)
  const aboutParsed = aboutSchema.nullable().safeParse(row.about);
  const nowLineParsed = nowLineSchema.safeParse(row.nowLine);
  const milestoneParsed = milestoneSchema.safeParse(row.milestone);
  const candidate = {
    displayName: row.displayName,
    description: row.description,
    theme: safeTheme(row.theme),
    customFont: row.customFont,
    customColor: row.customColor,
    customBackground: row.customBackground,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    redirectUrl: row.redirectUrl,
    shouldRedirect: row.shouldRedirect,
    hideWatermark: row.hideWatermark,
    links: Array.isArray(row.links) ? row.links : [],
    icons: Array.isArray(row.icons) ? row.icons : [],
    bookingBlocks: Array.isArray(row.bookingBlocks) ? row.bookingBlocks : [],
    scheduledBlocks: scheduledParsed.success ? scheduledParsed.data : [],
    liveBadge: liveBadgeParsed.success ? liveBadgeParsed.data : null,
    tipJar: tipJarParsed.success ? tipJarParsed.data : null,
    about: aboutParsed.success ? aboutParsed.data : null,
    nowLine: nowLineParsed.success ? nowLineParsed.data : null,
    milestone: milestoneParsed.success ? milestoneParsed.data : null,
    avatar: null,
    // Voice intro is a projection (voiceIntroAssetId column + Asset row),
    // resolved by the caller like avatar — never carried in the row itself.
    voiceIntro: null,
  };
  const parsed = profileContentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : profileContentSchema.parse({ ...candidate, links: [], icons: [] });
}

export function contentToColumns(content: ProfileContent): {
  displayName: string | null;
  description: string | null;
  theme: string;
  customFont: string | null;
  customColor: string | null;
  customBackground: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  redirectUrl: string | null;
  shouldRedirect: boolean;
  hideWatermark: boolean;
  links: ProfileContent["links"];
  icons: ProfileContent["icons"];
  bookingBlocks: ProfileContent["bookingBlocks"];
  scheduledBlocks: ProfileContent["scheduledBlocks"];
  liveBadge: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  tipJar: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  about: string | null;
  nowLine: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  milestone: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
} {
  return {
    displayName: content.displayName,
    description: content.description,
    theme: content.theme,
    customFont: content.customFont,
    customColor: content.customColor,
    customBackground: content.customBackground,
    seoTitle: content.seoTitle,
    seoDescription: content.seoDescription,
    redirectUrl: content.redirectUrl,
    shouldRedirect: content.shouldRedirect,
    hideWatermark: content.hideWatermark,
    links: content.links,
    icons: content.icons,
    bookingBlocks: content.bookingBlocks,
    scheduledBlocks: content.scheduledBlocks,
    liveBadge: content.liveBadge ?? Prisma.JsonNull,
    tipJar: content.tipJar ?? Prisma.JsonNull,
    about: content.about,
    nowLine: content.nowLine ?? Prisma.JsonNull,
    milestone: content.milestone ?? Prisma.JsonNull,
  };
}
