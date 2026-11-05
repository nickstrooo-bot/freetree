import Link from "next/link";
import { Section } from "../ui/section";
import { SIGNUP_URL } from "../../consts/site";
import { trackClickedGetStarted } from "../../lib/beacon";

/**
 * The Customer Promise — Nick's words, verbatim. A dark-green panel that
 * reads like a handshake, not a pricing page. This is the soul of FreeTree.
 */
export function CustomerPromise() {
  return (
    <Section className="bg-freetree-dark">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-freetree-bright">
          Our promise to you
        </p>
        <h2 className="mt-3 text-balance text-3xl font-bold tracking-tight text-freetree-cream sm:text-4xl lg:text-[44px] lg:leading-[1.1]">
          Free means free.
        </h2>

        <div className="mx-auto mt-8 max-w-2xl space-y-5 text-left sm:text-center">
          <p className="text-pretty text-[17px] leading-relaxed text-freetree-cream/90 sm:text-[19px]">
            FreeTree is free. Not &ldquo;free trial&rdquo; free. Not &ldquo;free
            with ads&rdquo; free. <strong className="font-bold text-freetree-cream">Free forever.</strong> No
            subscriptions, no paywalls, no ads on your page.
          </p>
          <p className="text-pretty text-[17px] leading-relaxed text-freetree-cream/90 sm:text-[19px]">
            When you sell through FreeTree, we keep{" "}
            <strong className="font-bold text-freetree-cream">4%</strong> — that&apos;s how we keep
            the lights on. Compare that to 12% elsewhere.
          </p>
          <p className="text-pretty text-[17px] leading-relaxed text-freetree-cream/90 sm:text-[19px]">
            And we&apos;re not stopping here. If you&apos;re getting squeezed by
            another platform,{" "}
            <strong className="font-bold text-freetree-cream">we&apos;re coming for them next.</strong>{" "}
            This is just the beginning.
          </p>
        </div>

        <div className="mt-10 flex justify-center">
          <Link
            href={SIGNUP_URL}
            onClick={() => trackClickedGetStarted("cta-band")}
            className="btn-metal inline-flex cursor-pointer items-center justify-center rounded-pill px-10 py-4 text-base font-semibold outline-none"
          >
            Take the promise — it&apos;s free
          </Link>
        </div>
        <p className="mt-4 text-[13px] text-freetree-cream/50">
          No credit card. No trial clock. Just your page.
        </p>
      </div>
    </Section>
  );
}
