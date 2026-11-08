import { useRef, useState, type CSSProperties } from "react";
import type { ThemeExtras } from "../theme-extras";

// ─── Soul blocks (public profile) ────────────────────────────────────────────
// About / story, now line, milestone meter, voice intro. All four read from
// profileContent and render near the top of the profile, above the links.
// The milestone count is passed in by the parent — it is computed server-side
// from completed purchases and is never stored or seller-typed, so the number
// on the bar is always the real one.

interface SoulBlockProps {
  extras: ThemeExtras;
  linkColor: string;
  textShadow: string | undefined;
  font: string;
}

function cardStyle(extras: ThemeExtras, linkColor: string, textShadow: string | undefined): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    width: "100%",
    padding: "16px 18px",
    borderRadius: extras.linkRadius,
    background: extras.link.background,
    border: extras.link.border,
    boxShadow: extras.link.boxShadow,
    backdropFilter: extras.link.backdropFilter,
    WebkitBackdropFilter: extras.link.backdropFilter,
    color: linkColor,
    textShadow,
    textAlign: "left",
  };
}

// Voice intro: a play button under the photo. Tap to play, never auto-play
// (no autoPlay attribute, preload="none" — the clip is fetched only when the
// visitor taps). The button flips to pause while playing and resets on ended.
export function VoiceIntroButton({
  url,
  name,
  extras,
  linkColor,
  textShadow,
  font,
}: SoulBlockProps & { url: string; name: string }) {
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
    <div data-freetree-voice-intro="" style={{ marginTop: "14px" }}>
      <audio ref={audioRef} src={url} preload="none" onEnded={() => setPlaying(false)} />
      <button
        type="button"
        onClick={toggle}
        aria-pressed={playing}
        aria-label={playing ? `Pause ${name || "seller"}'s voice intro` : `Play ${name || "seller"}'s voice intro`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "8px 16px",
          borderRadius: "9999px",
          background: extras.link.background,
          border: extras.link.border,
          boxShadow: extras.link.boxShadow,
          color: linkColor,
          fontFamily: font,
          fontSize: "14px",
          fontWeight: 600,
          cursor: "pointer",
          textShadow,
        }}
      >
        <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
        {playing ? "Pause intro" : "Hear my intro"}
      </button>
    </div>
  );
}

// About / story block: a few "who I am" lines above the links.
export function AboutBlock({
  text,
  extras: _extras,
  linkColor,
  textShadow,
  font,
}: SoulBlockProps & { text: string }) {
  return (
    <p
      data-freetree-about=""
      style={{
        margin: 0,
        paddingTop: "14px",
        fontFamily: font,
        fontSize: "14px",
        color: linkColor,
        lineHeight: 1.6,
        maxWidth: "100%",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        textShadow,
      }}
    >
      {text}
    </p>
  );
}

// Now line: what the seller is up to this week, with the date it was written
// — so a stale line is visibly stale.
export function NowLineBlock({
  text,
  updatedAt,
  extras,
  linkColor,
  textShadow,
  font,
}: SoulBlockProps & { text: string; updatedAt: string }) {
  const written = new Date(updatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <div data-freetree-now-line="" style={{ ...cardStyle(extras, linkColor, textShadow), marginTop: "18px" }}>
      <p
        style={{
          margin: 0,
          fontFamily: font,
          fontSize: "14px",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text}
      </p>
      <p
        style={{
          margin: 0,
          fontFamily: font,
          fontSize: "12px",
          opacity: 0.75,
        }}
      >
        Written {written}
      </p>
    </div>
  );
}

// Milestone meter: a goal bar whose number is the real count of completed
// purchases (product sales + tips). The goal is the only thing stored.
export function MilestoneMeter({
  goal,
  label,
  count,
  extras,
  linkColor,
  textShadow,
  font,
}: SoulBlockProps & { goal: number; label: string; count: number }) {
  const pct = Math.min(100, Math.round((count / goal) * 100));
  const reached = count >= goal;
  return (
    <div data-freetree-milestone="" style={{ ...cardStyle(extras, linkColor, textShadow), marginTop: "18px" }}>
      <p
        style={{
          margin: 0,
          fontFamily: font,
          fontSize: "14px",
          fontWeight: 700,
        }}
      >
        Help me reach {goal} {label}
      </p>
      <div
        role="progressbar"
        aria-valuenow={count}
        aria-valuemin={0}
        aria-valuemax={goal}
        aria-label={`${count} of ${goal} ${label}`}
        style={{
          width: "100%",
          height: "10px",
          borderRadius: "9999px",
          background: extras.link.background,
          border: extras.link.border,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: "9999px",
            background: linkColor,
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <p
        style={{
          margin: 0,
          fontFamily: font,
          fontSize: "13px",
          opacity: 0.85,
        }}
      >
        {reached
          ? `Goal reached — ${count} ${label}! Thank you.`
          : `${count} of ${goal} ${label} so far`}
      </p>
    </div>
  );
}
