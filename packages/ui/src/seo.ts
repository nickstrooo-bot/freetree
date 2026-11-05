import type { DefaultSeoProps, NextSeoProps } from "next-seo";

export const KYTELINK_ORIGIN = "https://freetree.link";
export const GITHUB_OWNER = "nickstrooo-bot";
export const GITHUB_REPO = "freetree";
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const SEO_TITLE_TEMPLATE = "%s | FreeTree";
export const SEO_DEFAULT_TITLE = "FreeTree — your links, free forever";
export const SEO_DEFAULT_DESCRIPTION =
  "FreeTree is the free link-in-bio: unlimited links, custom domains, themes. No subscriptions, no paywalls, no ads. We keep 4% only when you sell — that's how we keep the lights on.";

export const defaultSeoConfig: DefaultSeoProps = {
  titleTemplate: SEO_TITLE_TEMPLATE,
  defaultTitle: SEO_DEFAULT_TITLE,
  description: SEO_DEFAULT_DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "FreeTree",
    url: KYTELINK_ORIGIN,
    title: SEO_DEFAULT_TITLE,
    description: SEO_DEFAULT_DESCRIPTION,
  },
  twitter: {
    cardType: "summary_large_image",
    site: "@Nick173490",
  },
};

export interface ProfileSeoInput {
  username: string;
  displayName: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImageUrl: string | null;
}

// Canonical is ALWAYS the apex profile URL, even for custom domains.
export function buildProfileSeo(input: ProfileSeoInput): NextSeoProps {
  const name = input.displayName ?? input.username;
  const title = input.seoTitle ?? `${name} | FreeTree`;
  const description =
    input.seoDescription ?? `Check out ${name}'s FreeTree to grab their links!`;
  const canonical = `${KYTELINK_ORIGIN}/${input.username}`;

  return {
    title,
    description,
    canonical,
    openGraph: {
      type: "profile",
      url: canonical,
      title,
      description,
      images: input.ogImageUrl
        ? [{ url: input.ogImageUrl, width: 1200, height: 630, alt: title }]
        : undefined,
    },
    twitter: {
      cardType: "summary_large_image",
    },
  };
}
