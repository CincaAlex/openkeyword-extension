// When the popup asks for a Chrome Web Store review: once the extension has proven useful
// (3+ days installed, 10+ searches shared, sharing on), at most once, with "Not now" waiting 14 days.
import type { ReviewPrompt, Stats } from "./types.ts";

export const REVIEW_RULES = { MIN_AGE_MS: 3 * 24 * 3600_000, MIN_SENT: 10, SNOOZE_MS: 14 * 24 * 3600_000 };

export function shouldAskForReview(
  prompt: ReviewPrompt,
  installedAt: number | undefined,
  stats: Stats,
  sharing: boolean,
  now = Date.now(),
): boolean {
  if (prompt.state !== "pending" || !sharing || !installedAt) return false;
  if (prompt.snoozeUntil && now < prompt.snoozeUntil) return false;
  return now - installedAt >= REVIEW_RULES.MIN_AGE_MS && stats.totalSent >= REVIEW_RULES.MIN_SENT;
}
