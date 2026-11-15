import { describe, expect, it } from "vitest";
import {
  afterSendFailure,
  afterSendSuccess,
  appendLog,
  backoffDelayMs,
  decideFlush,
  enqueue,
  dueItems,
  failureAction,
  nextWakeAt,
  nextDueAt,
  QUEUE_RULES,
  removeIds,
  takeBatch,
} from "../src/lib/queue.ts";
import { INITIAL_FLUSH_STATE, type QueueItem } from "../src/lib/types.ts";

const MIN = 60_000;
const T = 1_700_000_000_000;

function item(n: number, addedAt: number, kw = `keyword ${n}`): QueueItem {
  return { id: `id${n}`, kw, country: "us", lang: "en", addedAt };
}
const items = (count: number, addedAt: (i: number) => number) =>
  Array.from({ length: count }, (_, i) => item(i, addedAt(i)));

describe("per-search 30 minute hold", () => {
  it("nothing is due in an empty queue", () => {
    expect(dueItems([], T)).toEqual([]);
    expect(nextDueAt([])).toBeNull();
  });
  it("each search becomes due 30 minutes after it happened, on its own clock", () => {
    const q = [{ addedAt: T - 30 * MIN }, { addedAt: T - 29 * MIN }, { addedAt: T - 5 * MIN }];
    expect(dueItems(q, T)).toEqual([{ addedAt: T - 30 * MIN }]);
  });
  it("many fast searches do not send early (no count trigger)", () => {
    expect(dueItems(items(200, () => T - MIN), T)).toHaveLength(0);
  });
  it("a heavy searcher who never pauses still sends: new searches don't reset old clocks", () => {
    // searches every minute for an hour; at the end the first 30 are due
    const q = items(61, (i) => T - (60 - i) * MIN);
    expect(dueItems(q, T)).toHaveLength(31);
  });
  it("matches the user's example: 10:00 and 10:05 go together, 10:40 later", () => {
    const at = (h: number, m: number) => T + (h * 60 + m) * MIN;
    const q = [{ addedAt: at(10, 0) }, { addedAt: at(10, 5) }, { addedAt: at(10, 40) }];
    expect(dueItems(q, at(10, 35))).toHaveLength(2);
    expect(dueItems(q, at(11, 9))).toHaveLength(2);
    expect(dueItems(q, at(11, 10))).toHaveLength(3);
  });
  it("nextDueAt is the oldest item + 30 min", () => {
    expect(nextDueAt([{ addedAt: T }, { addedAt: T - 10 * MIN }])).toBe(T + 20 * MIN);
  });
});

describe("decideFlush", () => {
  const due = items(3, () => T - 31 * MIN);

  it("schedules a jittered send the first time the rule is met", () => {
    const d = decideFlush(due, INITIAL_FLUSH_STATE, T, { paused: false, random: () => 0.5 });
    expect(d.send).toBe(false);
    expect(d.state.nextSendAfter).toBe(T + 2.5 * MIN);
  });

  it("sends immediately with zero jitter", () => {
    const d = decideFlush(due, INITIAL_FLUSH_STATE, T, { paused: false, random: () => 0 });
    expect(d.send).toBe(true);
  });

  it("jitter never exceeds 5 minutes", () => {
    const d = decideFlush(due, INITIAL_FLUSH_STATE, T, { paused: false, random: () => 1 });
    expect(d.state.nextSendAfter! - T).toBeLessThan(QUEUE_RULES.JITTER_MAX_MS);
  });

  it("sends once nextSendAfter has passed and keeps the stored time", () => {
    const state = { ...INITIAL_FLUSH_STATE, nextSendAfter: T + 3 * MIN };
    expect(decideFlush(due, state, T + 2 * MIN, { paused: false }).send).toBe(false);
    const d = decideFlush(due, state, T + 3 * MIN, { paused: false, random: () => 0.9 });
    expect(d.send).toBe(true);
    expect(d.state.nextSendAfter).toBe(T + 3 * MIN);
  });

  it("does not schedule while every search is younger than 30 minutes", () => {
    const d = decideFlush(items(20, () => T - 29 * MIN), INITIAL_FLUSH_STATE, T, { paused: false, random: () => 0 });
    expect(d.send).toBe(false);
    expect(d.state.nextSendAfter).toBeNull();
  });

  it("clears the schedule if the rule no longer holds", () => {
    const state = { ...INITIAL_FLUSH_STATE, nextSendAfter: T + MIN };
    const d = decideFlush(items(2, () => T), state, T + 2 * MIN, { paused: false });
    expect(d.send).toBe(false);
    expect(d.state.nextSendAfter).toBeNull();
  });

  it("never sends while paused", () => {
    const d = decideFlush(due, INITIAL_FLUSH_STATE, T, { paused: true, random: () => 0 });
    expect(d.send).toBe(false);
  });

  it("respects backoff", () => {
    const state = { ...INITIAL_FLUSH_STATE, backoffUntil: T + 5 * MIN, failures: 2 };
    expect(decideFlush(due, state, T + 4 * MIN, { paused: false, random: () => 0 }).send).toBe(false);
    expect(decideFlush(due, state, T + 5 * MIN, { paused: false, random: () => 0 }).send).toBe(true);
  });
});

describe("backoff", () => {
  it("steps 1, 5, 15, 60 minutes and stays at 60", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffDelayMs)).toEqual([1, 5, 15, 60, 60, 60].map((m) => m * MIN));
  });

  it("afterSendFailure increments failures and sets backoffUntil", () => {
    let s = afterSendFailure(INITIAL_FLUSH_STATE, T);
    expect(s).toEqual({ nextSendAfter: null, backoffUntil: T + MIN, failures: 1 });
    s = afterSendFailure(s, T + MIN);
    expect(s.backoffUntil).toBe(T + MIN + 5 * MIN);
    s = afterSendFailure(afterSendFailure(s, T), T);
    expect(s.failures).toBe(4);
    expect(s.backoffUntil).toBe(T + 60 * MIN);
  });

  it("afterSendSuccess resets everything", () => {
    expect(afterSendSuccess()).toEqual(INITIAL_FLUSH_STATE);
  });
});

describe("queue", () => {
  it("caps at 500 and drops the oldest", () => {
    const start = items(495, (i) => T + i);
    const incoming = Array.from({ length: 10 }, (_, i) => item(1000 + i, T + 1000 + i));
    const r = enqueue(start, incoming);
    expect(r.queue).toHaveLength(QUEUE_RULES.CAP);
    expect(r.added).toBe(10);
    expect(r.dropped).toBe(5);
    expect(r.queue[0]!.id).toBe("id5"); // id0..id4 dropped
    expect(r.queue.at(-1)!.id).toBe("id1009");
  });

  it("supports a custom cap", () => {
    const r = enqueue(items(3, (i) => T + i), [item(9, T + 9)], 2);
    expect(r.queue.map((i) => i.id)).toEqual(["id2", "id9"]);
  });

  it("skips keywords already queued for the same market", () => {
    const q = [item(1, T, "shoes")];
    const r = enqueue(q, [item(2, T + 1, "shoes"), item(3, T + 2, "hats"), item(4, T + 3, "hats")]);
    expect(r.queue.map((i) => i.kw)).toEqual(["shoes", "hats"]);
    expect(r.added).toBe(1);
  });

  it("does not mutate the input", () => {
    const q = [item(1, T)];
    enqueue(q, [item(2, T + 1)]);
    expect(q).toHaveLength(1);
  });

  it("takes oldest-first batches of at most 50 and removes by id", () => {
    const q = items(120, (i) => T + i);
    expect(takeBatch(q, T + 29 * MIN)).toHaveLength(0); // still held
    const batch = takeBatch(q, T + 31 * MIN);
    expect(batch).toHaveLength(50);
    expect(batch[0]!.id).toBe("id0");
    const rest = removeIds(q, batch.map((i) => i.id));
    expect(rest).toHaveLength(70);
    expect(rest[0]!.id).toBe("id50");
  });

  it("a batch only contains searches that have waited 30 minutes", () => {
    const q = [item(1, T - 40 * MIN), item(2, T - 31 * MIN), item(3, T - 2 * MIN)];
    expect(takeBatch(q, T).map((i) => i.id)).toEqual(["id1", "id2"]);
  });

  it("keeps the last 20 log entries, newest first", () => {
    let log: { at: number; count: number }[] = [];
    for (let i = 0; i < 25; i++) log = appendLog(log, { at: i, count: 1 });
    expect(log).toHaveLength(20);
    expect(log[0]!.at).toBe(24);
    expect(log.at(-1)!.at).toBe(5);
  });
});

describe("after a send", () => {
  it("removes exactly the sent items and keeps the ones still waiting", () => {
    const q = [item(1, T - 40 * MIN), item(2, T - 31 * MIN), item(3, T - 5 * MIN)];
    const batch = takeBatch(q, T);
    expect(batch.map((i) => i.id)).toEqual(["id1", "id2"]);
    const left = removeIds(q, batch.map((i) => i.id));
    expect(left.map((i) => i.id)).toEqual(["id3"]);
  });

  it("drops a batch the server will never accept, retries everything else", () => {
    expect(failureAction(400)).toBe("drop");
    expect(failureAction(413)).toBe("drop");
    for (const s of [undefined, 0, 401, 429, 500, 502, 503]) expect(failureAction(s)).toBe("retry");
  });
});

describe("nextWakeAt", () => {
  const S = INITIAL_FLUSH_STATE;
  it("wakes when the oldest search's 30 minutes are up", () => {
    expect(nextWakeAt([item(1, T), item(2, T + 10 * MIN)], S, { paused: false })).toBe(T + QUEUE_RULES.HOLD_MS);
  });
  it("waits for the random delay or the backoff when they are later", () => {
    const due = [item(1, T - 40 * MIN)];
    expect(nextWakeAt(due, { ...S, nextSendAfter: T + 3 * MIN }, { paused: false })).toBe(T + 3 * MIN);
    expect(nextWakeAt(due, { ...S, backoffUntil: T + 15 * MIN, failures: 2 }, { paused: false })).toBe(T + 15 * MIN);
  });
  it("sleeps when paused or empty", () => {
    expect(nextWakeAt([], S, { paused: false })).toBeNull();
    expect(nextWakeAt([item(1, T)], S, { paused: true })).toBeNull();
  });
});
