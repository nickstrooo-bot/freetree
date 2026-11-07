import { GITHUB_REPO_URL } from "./site";
import { LEGAL_CONTACT_EMAIL, SUPPORT_EMAIL } from "../lib/legal/contact";

export const ABOUT_HEADLINE = "A link-in-bio that costs nothing, hides nothing.";

export const ABOUT_PARAGRAPHS = [
  "FreeTree is a free, open-source link-in-bio platform: one page that holds every link, social icon, and theme you want to share. Custom domains, analytics, scheduled publishing, and team workspaces are all included, and none of it sits behind a paid tier — there isn't one.",
  "It started as an open-source project built by a developer who thought charging $15/month for a page with links was absurd. That frustration grew into a full platform — and now it's FreeTree: the same free, open-source foundation, with a simple deal. Your page is free forever. If you sell through it, we keep 4%. That's how we keep the lights on.",
  "The whole stack is MIT-licensed and public on GitHub. You can read every line, self-host your own instance with the same features as the hosted one, and export your data as JSON whenever you like. Hosting is paid for out of pocket — no ads, no trackers, no selling data, no investors to answer to.",
  "Every page published on getfreetree.com is reviewed before it goes live, every suspension is decided by a person, and our anti-phishing statement explains the whole system in public. Trust is easier to keep when there's nothing to hide.",
];

export const CONTACT_HEADLINE = "Talk to a person, not a portal.";
export const CONTACT_INTRO =
  "FreeTree is a small operation, which means your email lands with someone who can actually fix things. Pick the channel that fits and we'll take it from there.";

export const REPORT_HEADLINE =
  "Seen a FreeTree impersonating a company or running a scam?";
export const REPORT_INTRO = "Tell us where, and why. We review every report.";

export const APPEAL_HEADLINE = "Think we got it wrong?";
export const APPEAL_INTRO =
  "Tell us what was suspended and why it shouldn't have been. A person reads every appeal, and nothing is deleted while we look.";

export interface ContactChannel {
  title: string;
  description: string;
  href: string;
  linkLabel: string;
}

export const CONTACT_CHANNELS: ContactChannel[] = [
  {
    title: "Support",
    description:
      "Questions about your account, your page, custom domains, or anything not working the way it should. A human reads every email.",
    href: `mailto:${SUPPORT_EMAIL}`,
    linkLabel: SUPPORT_EMAIL,
  },
  {
    title: "Privacy & legal",
    description:
      "Data export and deletion requests, privacy questions, and legal correspondence — everything covered by our privacy policy and terms.",
    href: `mailto:${LEGAL_CONTACT_EMAIL}`,
    linkLabel: LEGAL_CONTACT_EMAIL,
  },
  {
    title: "Report abuse",
    description:
      "Found a getfreetree.com page phishing or impersonating a brand? Report it and the moderation pipeline takes it from there.",
    href: "/report",
    linkLabel: "getfreetree.com/report",
  },
  {
    title: "Appeal a suspension",
    description:
      "If your page was suspended and you believe the call was wrong, appeal it — a person reviews every appeal.",
    href: "/appeal",
    linkLabel: "getfreetree.com/appeal",
  },
  {
    title: "Bugs & contributions",
    description:
      "The entire codebase is open source. File bugs, request features, or send a pull request on GitHub.",
    href: `${GITHUB_REPO_URL}/issues`,
    linkLabel: "GitHub issues",
  },
];
