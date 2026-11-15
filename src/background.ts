// Background service worker: install key, onboarding, passive capture, contribution queue + flush.
import { resolveLang, scrubQuery } from "../shared/index.ts";
import { DEFAULT_COUNTRY, DEFAULT_LANG, SEARCH_ORIGINS, UNINSTALL_URL } from "./config.ts";
import { createApi } from "./lib/api.ts";
import {
  authClient,
  getApiBase,
  getFlushState,
  getInstallKey,
  getLocal,
  getQueue,
  getSession,
  getSettings,
  getStats,
  hasSearchPermissions,
  newId,
  PENDING_ENABLE_MS,
  rotateInstallKey,
  setLocal,
  setSession,
  updateSettings,
} from "./lib/chrome.ts";
import { checkRecent, extractSearch } from "./lib/extract.ts";
import type { BgMessage, BgReply } from "./lib/messages.ts";
import {
  afterSendFailure,
  afterSendSuccess,
  appendLog,
  decideFlush,
  enqueue,
  failureAction,
  nextWakeAt,
  QUEUE_RULES,
  removeIds,
  takeBatch,
} from "./lib/queue.ts";
import type { QueueItem } from "./lib/types.ts";
import { INITIAL_FLUSH_STATE, INITIAL_STATS } from "./lib/types.ts";

const FLUSH_ALARM = "contrib-flush";
/** One-shot alarm at the exact moment the next search may be sent (see scheduleWake). */
const WAKE_ALARM = "contrib-wake";
/** Chrome's minimum alarm delay for published extensions. */
const MIN_ALARM_DELAY_MS = 30_000;
/** One alarm for the whole extension; each tick sends whatever has waited 30+ minutes. */
const FLUSH_PERIOD_MIN = 5;

// ---- Serialize every queue/state mutation -------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(() => fn());
  chain = p.catch(() => undefined);
  return p;
}

// ---- Lifecycle ----------------------------------------------------------------------------

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(FLUSH_ALARM);
  if (!existing) await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MIN, delayInMinutes: 1 });
}

/** Install age in coarse buckets for the uninstall survey (never an exact date). */
function ageBucket(days: number): string {
  return days < 1 ? "0" : days < 7 ? "1-6" : days < 30 ? "7-29" : days < 90 ? "30-89" : "90+";
}

/**
 * The page Chrome opens after the extension is removed: a short, anonymous "why did you uninstall?"
 * survey on the website. The URL carries only the version, page language, a coarse install age and
 * whether sharing was on, so answers can be grouped. Nothing that identifies the person.
 */
async function updateUninstallUrl(): Promise<void> {
  const [s, installedAt] = await Promise.all([getSettings(), getLocal("installedAt")]);
  const ui = (() => {
    try {
      return [chrome.i18n.getUILanguage()];
    } catch {
      return [];
    }
  })();
  const lang = resolveLang(s.lang, [...ui, ...(navigator.languages ?? [])]);
  const days = installedAt ? Math.floor((Date.now() - installedAt) / 86_400_000) : 0;
  const q = new URLSearchParams({
    v: chrome.runtime.getManifest().version,
    lang,
    age: ageBucket(days),
    sharing: s.sharePassive ? "1" : "0",
  });
  try {
    await chrome.runtime.setUninstallURL(`${UNINSTALL_URL}?${q.toString()}`);
  } catch {
    /* only http(s) URLs are allowed; a bad dev override must not break the worker */
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await getInstallKey(); // generates the key on first install
    if (!(await getLocal("installedAt"))) await setLocal("installedAt", Date.now()); // updates: the review prompt waits again
    await ensureAlarm();
    await scheduleWake();
    await updateUninstallUrl();
    if (details.reason === "install") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
  void scheduleWake().catch(() => undefined);
  void updateUninstallUrl();
});

// ---- Contribution queue -------------------------------------------------------------------

async function addToQueue(items: QueueItem[]): Promise<number> {
  const { queue, added } = enqueue(await getQueue(), items);
  await setLocal("queue", queue);
  return added;
}

async function purgeDisabledSources(): Promise<void> {
  // Turning sharing off throws away anything not yet sent.
  if (!(await getSettings()).sharePassive && (await getQueue()).length > 0) await setLocal("queue", []);
}

async function flush(force: boolean): Promise<string> {
  const settings = await getSettings();
  const queue = settings.sharePassive ? await getQueue() : [];
  const state = await getFlushState();
  const now = Date.now();

  let send: boolean;
  if (force) {
    send = queue.length > 0 && !settings.paused;
  } else {
    const d = decideFlush(queue, state, now, { paused: settings.paused });
    if (d.state !== state) await setLocal("flushState", d.state);
    send = d.send;
  }
  if (!send) return settings.paused ? "paused" : "not_due";

  // "Send now" (dev) skips the 30-minute hold; normal ticks send only items that have waited.
  const batch = takeBatch(queue, force ? now + QUEUE_RULES.HOLD_MS : now);
  if (batch.length === 0) return "not_due";
  const api = createApi(await getApiBase(), getInstallKey, undefined, () => authClient.accessToken());
  try {
    // Only keyword, country and language leave the device.
    await api.contribute(batch.map(({ kw, country, lang }) => ({ kw, country, lang })));
  } catch (e) {
    const status = (e as { status?: number } | null)?.status;
    if (failureAction(status) === "drop") {
      // The server will never accept this batch: remove it rather than retrying forever. Not counted as sent.
      await setLocal("queue", removeIds(await getQueue(), batch.map((i) => i.id)));
      await setLocal("flushState", afterSendSuccess());
      return `dropped ${batch.length}`;
    }
    await setLocal("flushState", afterSendFailure(await getFlushState(), Date.now()));
    return "failed";
  }
  await setLocal("queue", removeIds(await getQueue(), batch.map((i) => i.id)));
  await setLocal("sentLog", appendLog((await getLocal("sentLog")) ?? [], { at: Date.now(), count: batch.length }));
  await setLocal("flushState", afterSendSuccess());
  const stats = await getStats();
  await setLocal("stats", { totalSent: stats.totalSent + batch.length, firstSentAt: stats.firstSentAt ?? Date.now() });
  return `sent ${batch.length}`;
}

/**
 * Sets the one-shot alarm for the next send: when the oldest search's 30 minutes are up (or the
 * random delay / retry backoff ends). Re-run whenever the queue, flush state or settings change.
 * The periodic FLUSH_ALARM stays as a safety net.
 */
async function scheduleWake(): Promise<void> {
  const [settings, queue, state] = await Promise.all([getSettings(), getQueue(), getFlushState()]);
  const at = settings.sharePassive ? nextWakeAt(queue, state, { paused: settings.paused }) : null;
  if (at === null) {
    await chrome.alarms.clear(WAKE_ALARM);
    return;
  }
  await chrome.alarms.create(WAKE_ALARM, { when: Math.max(at, Date.now() + MIN_ALARM_DELAY_MS) });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM || alarm.name === WAKE_ALARM) {
    void locked(() => flush(false))
      .catch(() => undefined)
      .finally(() => void scheduleWake().catch(() => undefined));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    void locked(purgeDisabledSources);
    void updateUninstallUrl(); // language or sharing changed
  }
  if (changes.queue || changes.flushState || changes.settings) void scheduleWake().catch(() => undefined);
});

// ---- Passive capture ----------------------------------------------------------------------

async function handleCapture(url: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.sharePassive) return;
  const found = extractSearch(url);
  if (!found) return;
  const kw = scrubQuery(found.query, "passive");
  if (!kw) return;
  const now = Date.now();
  const { isRepeat, recent } = checkRecent((await getSession("recentSearches")) ?? {}, kw, now);
  await setSession("recentSearches", recent);
  if (isRepeat) return;
  await addToQueue([
    { id: newId(), kw, country: DEFAULT_COUNTRY, lang: DEFAULT_LANG, addedAt: now, engine: found.engine },
  ]);
}

// Without the `tabs` permission, changeInfo.url is only present for hosts we have host
// permission for, i.e. the search result pages, and only after the user opted in.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!changeInfo.url || tab.incognito) return;
  const url = changeInfo.url;
  void locked(() => handleCapture(url)).catch(() => undefined);
});

// Finish "turn on sharing" when the popup closed before it heard the permission answer.
chrome.permissions.onAdded.addListener((added) => {
  if (!added.origins?.some((o) => SEARCH_ORIGINS.includes(o))) return;
  void (async () => {
    const at = await getSession("pendingEnableAt");
    if (at && Date.now() - at < PENDING_ENABLE_MS && (await hasSearchPermissions())) {
      await updateSettings({ sharePassive: true });
    }
    await chrome.storage.session.remove("pendingEnableAt");
  })();
});

// If the user revokes site access from chrome://extensions, turn passive capture off.
chrome.permissions.onRemoved.addListener((removed) => {
  if (removed.origins?.some((o) => SEARCH_ORIGINS.includes(o))) {
    void updateSettings({ sharePassive: false });
  }
});

// ---- Messages from extension pages --------------------------------------------------------

async function handleMessage(msg: BgMessage): Promise<BgReply> {
  switch (msg.type) {
    case "queueRemove":
      await setLocal("queue", removeIds(await getQueue(), [msg.id]));
      return { ok: true };
    case "queueClear":
      await setLocal("queue", []);
      await setLocal("flushState", INITIAL_FLUSH_STATE);
      return { ok: true };
    case "flushNow":
      return { ok: true, detail: await flush(true) };
    case "deleteData": {
      const api = createApi(await getApiBase(), getInstallKey, undefined, () => authClient.accessToken());
      await api.deleteInstall();
      await rotateInstallKey();
      await setLocal("queue", []);
      await setLocal("sentLog", []);
      await setLocal("stats", INITIAL_STATS);
      await setLocal("flushState", INITIAL_FLUSH_STATE);
      await setSession("recentSearches", {});
      return { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener((msg: BgMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  locked(() => handleMessage(msg))
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // async response
});
