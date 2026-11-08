import { useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Container } from "../ui/container";
import { ProfileDemo } from "./profile-demo";
import { GithubIcon } from "../ui/brand-icons";
import { SIGNUP_URL, GITHUB_REPO_URL } from "../../consts/site";
import { trackClickedGetStarted } from "../../lib/beacon";

const BLURBS = [
  { icon: "🌐", title: "Custom domains", body: "Point your own domain at your page. Free, obviously." },
  { icon: "🎨", title: "12 themes", body: "Minimal looks that stay out of the way of your content." },
  { icon: "📈", title: "Detailed analytics", body: "A full year of page views and link clicks, private to you." },
  { icon: "🛒", title: "Sell & keep 96%", body: "Digital products with checkout built in. We keep 4% — that's it." },
];

// FreeTree's own intro (Atlas, 22s): a play button under the hero CTAs.
// Tap to play, never auto-play (no autoPlay attribute, preload="none" — the
// clip is fetched only when a visitor taps).
function SiteIntroAudio() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  async function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  }

  return (
    <div className="mt-4 flex justify-center">
      <audio
        ref={audioRef}
        src="/atlas-freetree-intro.mp3"
        preload="none"
        onEnded={() => setPlaying(false)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-pressed={playing}
        aria-label={
          playing ? "Pause the FreeTree intro" : "Play the FreeTree intro (22 seconds)"
        }
        className="btn-metal-ghost inline-flex cursor-pointer items-center justify-center gap-2 rounded-pill px-5 py-2.5 text-sm font-medium outline-none"
      >
        <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
        {playing ? "Pause the intro" : "Hear what FreeTree is about (22s)"}
      </button>
    </div>
  );
}

export function Hero() {
  return (
    <Container className="flex flex-col items-center pb-16 pt-16 sm:pb-24 sm:pt-32">
      <div className="flex flex-col items-center text-center">
        <h1 className="max-w-[820px] text-balance text-[40px] font-bold leading-[1.05] tracking-[-0.035em] text-ink sm:text-6xl lg:text-[72px]">
          Your links.
          <br />
          Free forever.
        </h1>
        <p className="mt-6 max-w-[520px] text-pretty text-[17px] leading-relaxed text-secondary sm:mt-7 sm:text-[19px]">
          The free link-in-bio. Unlimited links, custom domains, and themes — no subscriptions, no
          paywalls, no ads on your page. If you sell through FreeTree, we keep 4% — that&apos;s how
          we keep the lights on.
        </p>
        <div className="mt-9 flex flex-col items-center gap-3 sm:mt-11 sm:flex-row sm:gap-4">
          <Link
            href={SIGNUP_URL}
            onClick={() => trackClickedGetStarted("hero")}
            className="btn-metal inline-flex cursor-pointer items-center justify-center rounded-pill px-8 py-4 text-base font-semibold outline-none"
          >
            Create your FreeTree
          </Link>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="btn-metal-ghost inline-flex cursor-pointer items-center justify-center gap-2 rounded-pill px-6 py-4 text-base font-medium outline-none"
          >
            <GithubIcon width={18} height={18} />
            Star on GitHub
          </a>
        </div>
        <div className="mt-5 text-[13px] text-faint">
          getfreetree.com/<span className="text-ink">yourname</span> — claimed in 30 seconds
        </div>
        <SiteIntroAudio />
      </div>

      {/* The walkaway — Nick's hero image, full-bleed and proud */}
      <figure className="mt-14 w-full max-w-[1080px] sm:mt-20">
        <div className="overflow-hidden rounded-panel shadow-[0_24px_70px_rgba(27,67,50,0.22)] ring-1 ring-freetree/20">
          <Image
            src="/hero-image.jpg"
            alt="A man walking away from a tree covered in dollar bills instead of leaves, whistling, pushing a wheelbarrow full of cash — leaving overpriced link-in-bio platforms behind"
            width={1600}
            height={1066}
            priority
            className="h-auto w-full"
          />
        </div>
        <figcaption className="mt-4 text-center text-sm italic text-faint">
          Walk away from the money tree. Your links were never supposed to cost you.
        </figcaption>
      </figure>

      <div className="mt-16 flex w-full max-w-[960px] flex-col items-center gap-10 overflow-hidden rounded-panel bg-hero-wash px-6 pt-12 sm:mt-20 sm:flex-row sm:items-end sm:justify-center sm:gap-12 sm:px-14 sm:pt-14">
        <ProfileDemo />
        <div className="flex flex-col gap-7 pb-12 sm:max-w-[340px] sm:pb-14">
          {BLURBS.map((blurb) => (
            <div key={blurb.title} className="flex items-start gap-3.5">
              <div className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[10px] border border-border bg-white text-[15px]">
                {blurb.icon}
              </div>
              <div>
                <div className="text-sm font-semibold text-ink">{blurb.title}</div>
                <div className="mt-0.5 text-[13px] leading-normal text-secondary">{blurb.body}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Container>
  );
}
