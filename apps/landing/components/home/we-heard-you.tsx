import { Section } from "../ui/section";
import { FaqJsonLd, type FaqEntry } from "../seo/json-ld";

/**
 * "We heard you" — a complaint-response section that speaks directly to
 * Linktree's angriest users. Each card pairs a real complaint theme
 * (sourced from Trustpilot, Reddit, G2, and creator-economy press) with
 * FreeTree's answer. Conversational, not a feature list.
 */

interface HeardItem {
  complaint: string;
  answer: string;
  detail: string;
  icon: string;
}

const ITEMS: HeardItem[] = [
  {
    complaint: "Tired of the 67% price hike?",
    answer: "We heard you.",
    detail:
      "FreeTree is free. Forever. No tiers, no renewals, no surprise charges landing mid-holiday-season. Your page costs $0 today, $0 next year, $0 always.",
    icon: "💸",
  },
  {
    complaint: "Paying 12% on every sale?",
    answer: "We take 4%. That's it.",
    detail:
      "Sell a $20 digital product and keep $19.20 instead of $17.60. That $1.60 comes back to you on every single sale — no subscription required to get the better rate.",
    icon: "🛒",
  },
  {
    complaint: "Got banned with no warning?",
    answer: "We warn before we act.",
    detail:
      "Every enforcement gets human review. You'll get a warning and 72 hours to fix it — never a public shaming page, never an algorithm deciding your livelihood overnight.",
    icon: "🛡️",
  },
  {
    complaint: "Analytics locked behind a paywall?",
    answer: "Yours are free for a full year.",
    detail:
      "It's your data — we're not holding it hostage for $15 a month. A full 12 months of page views and click history, included, forever.",
    icon: "📊",
  },
  {
    complaint: "Forced branding on your page?",
    answer: "Your page. Your brand.",
    detail:
      "Zero ads, zero forced logos. The small watermark removes with one click — free, not gated behind a Pro plan you never wanted.",
    icon: "🏷️",
  },
  {
    complaint: "Support that never answers?",
    answer: "A human answers here.",
    detail:
      "No login loops that last for months, no AI auto-replies that solve nothing. We're small enough that a real person reads your message: support@freetree.link.",
    icon: "🎧",
  },
];

export const HEARD_YOU_FAQS: FaqEntry[] = ITEMS.map((item) => ({
  question: `${item.complaint} ${item.answer}`,
  answer: item.detail,
}));

export function HeardYouFaqJsonLd() {
  return <FaqJsonLd faqs={HEARD_YOU_FAQS} />;
}

export function WeHeardYou() {
  return (
    <Section className="paper-warm border-y border-freetree/10">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-freetree">
          We heard you
        </p>
        <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-ink sm:text-4xl lg:text-[44px] lg:leading-[1.1]">
          The free Linktree alternative, built from real complaints
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-[16px] leading-relaxed text-secondary sm:text-[18px]">
          We read the one-star reviews, the angry threads, the &ldquo;I&apos;ve
          been loyal for five years and I&apos;m done&rdquo; posts. Every card
          below is something a real person said about link-in-bio platforms —
          and our answer.
        </p>
      </div>

      <div className="mx-auto mt-12 grid max-w-5xl gap-5 sm:mt-14 sm:grid-cols-2 lg:grid-cols-3">
        {ITEMS.map((item) => (
          <article
            key={item.complaint}
            className="flex flex-col rounded-card border border-freetree/15 bg-white/90 p-6 shadow-[0_2px_10px_rgba(27,67,50,0.06)] transition-transform duration-150 hover:-translate-y-0.5"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-freetree-cream text-[20px] ring-1 ring-freetree/15">
              <span aria-hidden="true">{item.icon}</span>
            </div>
            <h3 className="mt-4 text-[17px] font-bold tracking-tight text-ink">
              &ldquo;{item.complaint}&rdquo;
            </h3>
            <p className="mt-1.5 text-[15px] font-semibold text-freetree">{item.answer}</p>
            <p className="mt-2.5 text-sm leading-relaxed text-secondary">{item.detail}</p>
          </article>
        ))}
      </div>

      <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-relaxed text-faint">
        Complaint themes sourced from Trustpilot, Reddit, G2, and creator-economy
        coverage of Linktree&apos;s 2025–2026 pricing and policy changes.
      </p>
    </Section>
  );
}
