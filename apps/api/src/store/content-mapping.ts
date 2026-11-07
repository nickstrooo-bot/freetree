import {
  type ProfileContent,
  profileContentSchema,
  type ThemeKey,
  themeKeySchema,
  liveBadgeSchema,
  scheduledBlockSchema,
  tipJarSchema,
} from "@kytelink/schemas";

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
    avatar: null,
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
  liveBadge: ProfileContent["liveBadge"];
  tipJar: ProfileContent["tipJar"];
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
    liveBadge: content.liveBadge,
    tipJar: content.tipJar,
  };
}
