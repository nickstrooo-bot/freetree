// Pure scheduled-block evaluation — no zod, so render-time consumers can import
// this through @kytelink/schemas/profile-data without pulling the zod runtime
// into the public profile's client bundle.
//
// Model adapted from Kitab-Link (MIT, https://github.com/Kurohiko-id/Kitab-Link-Self-Hosted):
// its lib/schedule-evaluate.ts (pure, `now`-injected evaluation) and its
// components/countdown-link-card.tsx (digital HH:MM:SS countdown, locked card
// before the moment, live link after). Two deliberate differences:
// - Kitab-Link schedules by day-of-week (+ an until-date). FreeTree schedules by
//   absolute date/time window — a drop goes live at a moment and expires at a
//   moment, which is the shape sellers actually ask for. Weekly recurrence is a
//   later step, not this one.
// - Kitab-Link evaluates server-side on a cron and flips stored visibility.
//   FreeTree evaluates at render time (server + a client ticker), so no cron or
//   stored state is needed to open a block on schedule.

export type ScheduledBlockState = "upcoming" | "live" | "expired";

export interface ScheduledBlockWindow {
  startsAt: string;
  endsAt: string | null;
}

/**
 * Where a scheduled block stands right now. An unparseable startsAt can never
 * go live, so it reads as expired (hidden) rather than breaking the profile.
 */
export function evaluateScheduledBlock(
  block: ScheduledBlockWindow,
  now: Date = new Date(),
): ScheduledBlockState {
  const start = new Date(block.startsAt).getTime();
  if (Number.isNaN(start)) return "expired";
  if (now.getTime() < start) return "upcoming";
  if (block.endsAt) {
    const end = new Date(block.endsAt).getTime();
    if (!Number.isNaN(end) && now.getTime() > end) return "expired";
  }
  return "live";
}

/** Digital countdown — "HH:MM:SS", with a "D:" day prefix past 24h. */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return days > 0
    ? `${days}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
