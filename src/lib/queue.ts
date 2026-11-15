// Pure contribution-queue logic: no chrome.* and no clock access. Time is always injected.
import type { FlushState, QueueItem } from "./types.ts";

const MIN = 60_000;

export const QUEUE_RULES = {
  /** Every search waits at least this long on its own clock, so the user can remove it. */
  HOLD_MS: 30 * MIN,
  /** Random delay added once some items are due, so send times don't reveal search times. */
  JITTER_MAX_MS: 5 * MIN,
  /** Items per POST /v1/contribute (server max 50). */
  BATCH_SIZE: 50,
  /** Hard cap; oldest dropped beyond this. */
  CAP: 500,
  /** Backoff after the 1st, 2nd, 3rd, 4th+ consecutive failure. */
  BACKOFF_MS: [1 * MIN, 5 * MIN, 15 * MIN, 60 * MIN],
  /** Sent-batch log length. */
  LOG_SIZE: 20,
} as const;

const itemKey = (i: Pick<QueueItem, "kw" | "country" | "lang">) => `${i.kw}|${i.country}|${i.lang}`;

/**
 * Append items, skipping keywords already queued (same kw/country/lang),
 * then enforce the cap by dropping the oldest entries.
 */
export function enqueue(
  queue: QueueItem[],
  incoming: QueueItem[],
  cap: number = QUEUE_RULES.CAP,
): { queue: QueueItem[]; added: number; dropped: number } {
  const seen = new Set(queue.map(itemKey));
  const next = queue.slice();
  let added = 0;
  for (const item of incoming) {
    const k = itemKey(item);
    if (seen.has(k)) continue;
    seen.add(k);
    next.push(item);
    added++;
  }
  // Keep chronological order so "oldest" is always at the front.
  next.sort((a, b) => a.addedAt - b.addedAt);
  const dropped = Math.max(0, next.length - cap);
  return { queue: dropped ? next.slice(dropped) : next, added, dropped };
}

export function removeIds(queue: QueueItem[], ids: Iterable<string>): QueueItem[] {
  const drop = new Set(ids);
  return queue.filter((i) => !drop.has(i.id));
}

/** Items that have waited at least HOLD_MS (each on its own clock). */
export function dueItems<T extends Pick<QueueItem, "addedAt">>(queue: T[], now: number): T[] {
  return queue.filter((i) => now - i.addedAt >= QUEUE_RULES.HOLD_MS);
}

/** Oldest-first batch of due items to send. */
export function takeBatch<T extends Pick<QueueItem, "addedAt">>(queue: T[], now: number, size: number = QUEUE_RULES.BATCH_SIZE): T[] {
  return dueItems(queue, now).slice(0, size);
}

/** When the next item becomes due (null if the queue is empty). Used for the "sends in ~N min" hint. */
export function nextDueAt(queue: Pick<QueueItem, "addedAt">[]): number | null {
  if (queue.length === 0) return null;
  return Math.min(...queue.map((i) => i.addedAt)) + QUEUE_RULES.HOLD_MS;
}

/**
 * Called on every alarm tick. Returns whether to send now and the state to persist.
 * When some items first become due a jittered nextSendAfter (0-5 min) is stored; we send
 * once that time has passed. If nothing is due any more (e.g. user removed them) it is cleared.
 */
export function decideFlush(
  queue: Pick<QueueItem, "addedAt">[],
  state: FlushState,
  now: number,
  opts: { paused: boolean; random?: () => number },
): { send: boolean; state: FlushState } {
  if (opts.paused) return { send: false, state };
  if (state.backoffUntil !== null && now < state.backoffUntil) return { send: false, state };
  if (dueItems(queue, now).length === 0) {
    return { send: false, state: state.nextSendAfter === null ? state : { ...state, nextSendAfter: null } };
  }
  let nextSendAfter = state.nextSendAfter;
  if (nextSendAfter === null) {
    const r = (opts.random ?? Math.random)();
    nextSendAfter = now + Math.floor(Math.min(Math.max(r, 0), 0.999999) * QUEUE_RULES.JITTER_MAX_MS);
  }
  return { send: now >= nextSendAfter, state: { ...state, nextSendAfter } };
}

/** Backoff for the n-th consecutive failure (n ≥ 1): 1, 5, 15, 60, 60, ... minutes. */
export function backoffDelayMs(failures: number): number {
  const steps = QUEUE_RULES.BACKOFF_MS;
  const idx = Math.min(Math.max(failures, 1), steps.length) - 1;
  return steps[idx]!;
}

/**
 * What to do with a batch after a failed send. "drop": the server will never accept this body
 * (400 bad request, 413 too large), so the items are removed instead of being retried forever.
 * "retry": temporary (offline, 429, 5xx, 401); the items stay queued and backoff applies.
 */
export function failureAction(status: number | undefined): "drop" | "retry" {
  return status === 400 || status === 413 ? "drop" : "retry";
}

/**
 * When the background should wake next to send, so a finished 30-minute timer is sent promptly
 * instead of waiting for the next 5-minute tick. null = nothing to wait for.
 */
export function nextWakeAt(queue: Pick<QueueItem, "addedAt">[], state: FlushState, opts: { paused: boolean }): number | null {
  if (opts.paused || queue.length === 0) return null;
  const due = nextDueAt(queue)!;
  const after = Math.max(due, state.nextSendAfter ?? 0, state.backoffUntil ?? 0);
  return after;
}

export function afterSendSuccess(): FlushState {
  return { nextSendAfter: null, backoffUntil: null, failures: 0 };
}

export function afterSendFailure(state: FlushState, now: number): FlushState {
  const failures = state.failures + 1;
  return { nextSendAfter: null, backoffUntil: now + backoffDelayMs(failures), failures };
}

export function appendLog<T>(log: T[], entry: T, size: number = QUEUE_RULES.LOG_SIZE): T[] {
  return [entry, ...log].slice(0, size);
}
