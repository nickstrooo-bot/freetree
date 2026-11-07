import { z } from "zod";
import {
  linkEmojiSchema,
  linkTitleSchema,
  safeCssColorSchema,
  safeWebUrlSchema,
} from "./content-policy";
import { linkCardSchema } from "./link-card";

export const linkSchema = z.object({
  title: linkTitleSchema,
  link: safeWebUrlSchema,
  emoji: linkEmojiSchema.optional(),
  color: safeCssColorSchema.optional(),
  // Photo link-card: OpenGraph metadata captured when the seller added the
  // link (see ./link-card). Optional — every link saved before this feature
  // has no card and renders exactly as before.
  card: linkCardSchema.optional(),
});

export type Link = z.infer<typeof linkSchema>;

export * from "./link-data";
