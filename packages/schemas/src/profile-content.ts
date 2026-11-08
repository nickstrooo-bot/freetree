import { z } from "zod";
import { linkSchema } from "./link";
import { bookingBlockSchema, MAX_PROFILE_BOOKING_BLOCKS } from "./booking";
import { liveBadgeSchema } from "./live-badge";
import {
  MAX_PROFILE_SCHEDULED_BLOCKS,
  scheduledBlockSchema,
} from "./scheduled-block";
import { tipJarSchema } from "./tip-jar";
import { aboutSchema } from "./about";
import { nowLineSchema } from "./now-line";
import { milestoneSchema } from "./milestone";
import { voiceIntroSchema } from "./voice-intro";
import { iconSchema } from "./icon";
import { themeKeySchema } from "./themes";
import { fontKeySchema } from "./fonts";
import {
  safeWebUrlSchema,
  safeCssColorSchema,
  descriptionSchema,
  displayNameSchema,
  seoDescriptionSchema,
  seoTitleSchema,
} from "./content-policy";

// Hard caps on content collections. These are the real DoS backstop (Phase 4 H3);
// the editor's own MAX_ICONS picker limit (5) is only a client-side nicety.
export const MAX_PROFILE_LINKS = 100;
export const MAX_PROFILE_ICONS = 50;

export const avatarSchema = z
  .object({
    url: z.string(),
    lqip: z.string().nullable(),
  })
  .nullable();

export type Avatar = z.infer<typeof avatarSchema>;

// The ONE definition of a kyte's content. Kyte drafts, PublishedKyte, and
// scheduled-publish snapshots all derive their content fields from this schema
// so the three representations can never drift (03-database.md, 04-organizations.md).
export const profileContentSchema = z.object({
  displayName: displayNameSchema.nullable(),
  description: descriptionSchema.nullable(),
  theme: themeKeySchema,
  customFont: fontKeySchema.nullable(),
  // Any safe CSS color (hex from the picker, or a legacy Chakra token / preset).
  // safeCssColorSchema is a strict superset of the old COLOR_KEYS enum, so every
  // previously stored customColor still validates.
  customColor: safeCssColorSchema.nullable(),
  // Optional solid background layered over the chosen theme's own background.
  // null = use the theme's background. Same safe-color policy as customColor.
  customBackground: safeCssColorSchema.nullable(),
  seoTitle: seoTitleSchema.nullable(),
  seoDescription: seoDescriptionSchema.nullable(),
  redirectUrl: safeWebUrlSchema.nullable(),
  shouldRedirect: z.boolean(),
  // Stored profiles predate the watermark toggle, so absent = shown.
  hideWatermark: z.boolean().default(false),
  links: z.array(linkSchema).max(MAX_PROFILE_LINKS),
  icons: z.array(iconSchema).max(MAX_PROFILE_ICONS),
  // Booking buttons (Calendly/Cal.com URLs). Same JSON-array pattern as links.
  bookingBlocks: z.array(bookingBlockSchema).max(MAX_PROFILE_BOOKING_BLOCKS).default([]),
  // Scheduled blocks: link buttons that go live at startsAt, optionally expire
  // at endsAt, and count down until they open. Same JSON-array pattern.
  scheduledBlocks: z
    .array(scheduledBlockSchema)
    .max(MAX_PROFILE_SCHEDULED_BLOCKS)
    .default([]),
  // Live badge: a "LIVE NOW" pill driven by the seller's YouTube channel.
  // Null = no badge on this profile.
  liveBadge: liveBadgeSchema.nullable().default(null),
  // Tip jar ("leave a tip" block). null = no tip jar on this profile.
  // Stored profiles predate the tip jar, so absent = null.
  tipJar: tipJarSchema.nullable().default(null),
  // About / story block: a few "who I am" lines at the top of the profile,
  // above the links. The photo is the avatar (Design tab). Null = no block.
  // Stored profiles predate the about block, so absent = null.
  about: aboutSchema.nullable().default(null),
  // Now line: what the seller is up to this week + the date it was written.
  // Null = no now line.
  nowLine: nowLineSchema.nullable().default(null),
  // Milestone meter: the goal only. The count is computed at read time from
  // completed purchases — never stored, never seller-typed. Null = no meter.
  milestone: milestoneSchema.nullable().default(null),
  avatar: avatarSchema,
  // Voice intro: a short recorded clip, play button under the photo.
  // Projection of the voiceIntroAssetId column + its Asset row, like avatar.
  voiceIntro: voiceIntroSchema.nullable().default(null),
});

export type ProfileContent = z.infer<typeof profileContentSchema>;

export const PROFILE_CONTENT_FIELDS = Object.keys(
  profileContentSchema.shape,
) as (keyof ProfileContent)[];

// The ONE mapping ProfileContent field -> Prisma content column. `satisfies
// Record<keyof ProfileContent, string>` forces every ProfileContent field to
// appear here, so adding a field breaks compilation until it is mapped. avatar
// is a PROJECTION: ProfileContent.avatar {url,lqip} is resolved from the
// `avatarAssetId` column + its Asset row, not stored 1:1.
export const PROFILE_CONTENT_FIELD_TO_COLUMN = {
  displayName: "displayName",
  description: "description",
  theme: "theme",
  customFont: "customFont",
  customColor: "customColor",
  customBackground: "customBackground",
  seoTitle: "seoTitle",
  seoDescription: "seoDescription",
  redirectUrl: "redirectUrl",
  shouldRedirect: "shouldRedirect",
  hideWatermark: "hideWatermark",
  links: "links",
  icons: "icons",
  bookingBlocks: "bookingBlocks",
  scheduledBlocks: "scheduledBlocks",
  liveBadge: "liveBadge",
  tipJar: "tipJar",
  about: "about",
  nowLine: "nowLine",
  milestone: "milestone",
  avatar: "avatarAssetId",
  voiceIntro: "voiceIntroAssetId",
} as const satisfies Record<keyof ProfileContent, string>;

export type ProfileContentColumn =
  (typeof PROFILE_CONTENT_FIELD_TO_COLUMN)[keyof typeof PROFILE_CONTENT_FIELD_TO_COLUMN];

export const PROFILE_CONTENT_COLUMNS = Object.values(
  PROFILE_CONTENT_FIELD_TO_COLUMN,
) as ProfileContentColumn[];

export function emptyProfileContent(): ProfileContent {
  return {
    displayName: null,
    description: null,
    theme: "default",
    customFont: null,
    customColor: null,
    customBackground: null,
    seoTitle: null,
    seoDescription: null,
    redirectUrl: null,
    shouldRedirect: false,
    hideWatermark: false,
    links: [],
    icons: [],
    bookingBlocks: [],
    scheduledBlocks: [],
    liveBadge: null,
    tipJar: null,
    about: null,
    nowLine: null,
    milestone: null,
    avatar: null,
    voiceIntro: null,
  };
}
