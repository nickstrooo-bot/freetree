import type { ReactNode } from "react";
import { Container } from "../ui/container";
import { Eyebrow } from "../ui/section";

const CHART_POINTS = [
  34, 33, 35, 32, 36, 38, 37, 40, 42, 41, 44, 47, 46, 50, 53, 52, 56, 60, 63, 62, 67, 72, 76, 74,
];

function AnalyticsChart() {
  const width = 480;
  const height = 120;
  const max = 80;
  const step = width / (CHART_POINTS.length - 1);
  const points = CHART_POINTS.map((value, index) => `${index * step},${height - (value / max) * height}`);
  const line = points.join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-6 w-full" aria-hidden="true">
      <polygon points={area} fill="#6D5AE6" opacity="0.08" />
      <polyline
        points={line}
        fill="none"
        stroke="#6D5AE6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Illustrative trend line only — no real or sample numbers. The live
// stats (page views, clicks, click rate) appear here once a page has traffic.
function AnalyticsCard() {
  return (
    <div className="rounded-panel border border-cardline bg-card p-5 shadow-card-rest sm:p-7">
      <AnalyticsChart />
      <p className="mt-4 text-center text-sm text-tertiary">
        Page views, link clicks, and click rate — shown live once your page has traffic.
      </p>
    </div>
  );
}

function SpeedCard() {
  const scores = [
    { label: "Performance", value: "100" },
    { label: "Accessibility", value: "100" },
    { label: "Best practices", value: "100" },
    { label: "SEO", value: "100" },
  ];
  return (
    <div className="rounded-panel border border-cardline bg-card px-5 py-10 shadow-card-rest sm:px-7 sm:py-14">
      <div className="text-center">
        <div className="text-[56px] font-bold leading-none tracking-[-0.03em] text-ink">
          0.2<span className="text-[28px] font-semibold text-faint">s</span>
        </div>
        <div className="mt-2 text-sm text-tertiary">median page load</div>
      </div>
      <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
        {scores.map((score) => (
          <div key={score.label} className="text-center">
            <div className="text-[22px] font-bold tracking-[-0.02em] text-accent">{score.value}</div>
            <div className="mt-1 text-xs text-tertiary">{score.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FeatureRow({
  eyebrow,
  title,
  body,
  bullets,
  card,
  flip = false,
}: {
  eyebrow: string;
  title: ReactNode;
  body: string;
  bullets?: string[];
  card: ReactNode;
  flip?: boolean;
}) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-20">
      <div className={flip ? "lg:order-2" : ""}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="mt-3 max-w-md text-balance text-[28px] font-bold leading-tight tracking-[-0.025em] text-ink sm:text-4xl">
          {title}
        </h2>
        <p className="mt-4 max-w-lg text-pretty text-[15px] leading-relaxed text-secondary sm:text-base">
          {body}
        </p>
        {bullets ? (
          <ul className="mt-6 flex flex-col gap-2.5">
            {bullets.map((bullet) => (
              <li key={bullet} className="flex items-center gap-3 text-sm text-secondary">
                <span className="h-1.5 w-1.5 flex-shrink-0 rounded-pill bg-accent" aria-hidden="true" />
                {bullet}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className={flip ? "lg:order-1" : ""}>{card}</div>
    </div>
  );
}

export function DeepFeatures() {
  return (
    <Container className="flex flex-col gap-24 py-16 sm:gap-32 sm:py-24">
      <FeatureRow
        eyebrow="Analytics"
        title={
          <>
            Know what&apos;s working.
            <br />
            Privately.
          </>
        }
        body="Page views, link clicks, traffic sources, devices, and countries — all measured without cookies or creepy trackers. Your visitors' data stays theirs; your numbers stay yours."
        card={<AnalyticsCard />}
      />
      <FeatureRow
        flip
        eyebrow="Speed"
        title="Faster than your bio deserves."
        body="Every page is statically rendered and cached at the edge, close to your visitors. No render-blocking scripts, no megabytes of tracker JavaScript — just your links, instantly."
        card={<SpeedCard />}
      />
    </Container>
  );
}
