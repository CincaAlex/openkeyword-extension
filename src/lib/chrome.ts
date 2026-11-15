// Small wrappers around chrome.* so the rest of the code stays testable and readable.
import { API_BASE, IS_DEV, SEARCH_ORIGINS } from "../config.ts";
import { createAuthClient, type AuthSession } from "../../shared/index.ts";
import type { FlushState, QueueItem, ReviewPrompt, SentLogEntry, Settings, Stats } from "./types.ts";
import { DEFAULT_SETTINGS, INITIAL_FLUSH_STATE, INITIAL_STATS } from "./types.ts";

/** Everything kept in chrome.storage.local (persists until uninstall). */
export interface LocalSchema {
  installKey: string;
  settings: Settings;
  queue: QueueItem[];
  flushState: FlushState;
  sentLog: SentLogEntry[];
  stats: Stats;
  /** Optional account login (email code). Null/absent = not logged in. */
  auth: AuthSession | null;
  /** When the extension was first installed (ms). Drives the review prompt's timing. */
  installedAt: number;
  reviewPrompt: ReviewPrompt;
}

/** Everything kept in chrome.storage.session (memory only, cleared when the browser closes). */
export interface SessionSchema {
  /** Passive-capture repeat filter: normalized keyword → last seen time. */
  recentSearches: Record<string, number>;
  /** Set when the user clicks "turn on sharing"; see enablePassiveCapture. */
  pendingEnableAt: number;
}

export async function getLocal<K extends keyof LocalSchema>(key: K): Promise<LocalSchema[K] | undefined> {
  const r = await chrome.storage.local.get(key);
  return r[key] as LocalSchema[K] | undefined;
}

export async function setLocal<K extends keyof LocalSchema>(key: K, value: LocalSchema[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSession<K extends keyof SessionSchema & string>(key: K): Promise<SessionSchema[K] | undefined> {
  const r = await chrome.storage.session.get(key);
  return r[key] as SessionSchema[K] | undefined;
}

export async function setSession<K extends keyof SessionSchema & string>(key: K, value: SessionSchema[K]): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await getLocal("settings")) ?? {}) };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await setLocal("settings", next);
  return next;
}

export async function getQueue(): Promise<QueueItem[]> {
  return (await getLocal("queue")) ?? [];
}

export async function getStats(): Promise<Stats> {
  return (await getLocal("stats")) ?? INITIAL_STATS;
}

export async function getFlushState(): Promise<FlushState> {
  return (await getLocal("flushState")) ?? INITIAL_FLUSH_STATE;
}

export async function getApiBase(): Promise<string> {
  if (IS_DEV) {
    const s = await getSettings();
    if (s.apiBaseOverride) return s.apiBaseOverride;
  }
  return API_BASE;
}

/** Subscribe to changes of local-storage keys. Returns an unsubscribe function. */
export function onLocalChange(keys: (keyof LocalSchema)[], fn: () => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && keys.some((k) => k in changes)) fn();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ---- Install key ---------------------------------------------------------------------------

/** 32 random bytes as 64 lowercase hex chars. */
export function generateInstallKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getInstallKey(): Promise<string> {
  const existing = await getLocal("installKey");
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const key = generateInstallKey();
  await setLocal("installKey", key);
  return key;
}

export async function rotateInstallKey(): Promise<string> {
  const key = generateInstallKey();
  await setLocal("installKey", key);
  return key;
}

// ---- Optional host permissions for passive capture ----------------------------------------

export function hasSearchPermissions(): Promise<boolean> {
  return chrome.permissions.contains({ origins: SEARCH_ORIGINS });
}

/**
 * Must be called directly from a click handler (user gesture), before any other await.
 * Returns true if the user granted access.
 */
export function requestSearchPermissions(): Promise<boolean> {
  return chrome.permissions.request({ origins: SEARCH_ORIGINS });
}

export async function removeSearchPermissions(): Promise<void> {
  try {
    await chrome.permissions.remove({ origins: SEARCH_ORIGINS });
  } catch {
    /* already removed */
  }
}

/**
 * Turn passive capture on: ask for host access first (needs user gesture), then flip the setting.
 * Chrome may close the popup while its permission prompt is open, which kills this promise, so we
 * also leave a short-lived marker that the background uses to finish the job (permissions.onAdded).
 */
export async function enablePassiveCapture(): Promise<boolean> {
  const request = requestSearchPermissions(); // must be the first call inside the click
  void chrome.storage.session.set({ pendingEnableAt: Date.now() });
  const granted = await request;
  if (granted) await updateSettings({ sharePassive: true });
  return granted;
}

/** Window in which a permission grant counts as the user's "turn on sharing" click. */
export const PENDING_ENABLE_MS = 2 * 60_000;

export async function disablePassiveCapture(): Promise<void> {
  await updateSettings({ sharePassive: false });
  await removeSearchPermissions();
}

export function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- Optional account ------------------------------------------------------------------------

/** Email-code login; the session lives in chrome.storage.local (this browser profile only). */
export const authClient = createAuthClient({
  store: {
    get: async () => (await getLocal("auth")) ?? null,
    set: async (s) => {
      if (s) await setLocal("auth", s);
      else await chrome.storage.local.remove("auth");
    },
  },
});
