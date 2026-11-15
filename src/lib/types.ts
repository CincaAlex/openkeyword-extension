import type { LangSetting } from "../../shared/i18n.ts";

export type CaptureEngine = "google" | "bing" | "duckduckgo" | "youtube" | "amazon";

/** One pending contribution. Only kw/country/lang are ever sent to the server. */
export interface QueueItem {
  id: string;
  kw: string;
  country: string;
  lang: string;
  /** When the search happened. Each item is held for QUEUE_RULES.HOLD_MS from this time. */
  addedAt: number;
  /** Local display only (which search engine it came from). Never sent. */
  engine?: CaptureEngine;
}

export interface FlushState {
  /** Jittered earliest send time once some items are due. null = not scheduled. */
  nextSendAfter: number | null;
  /** Do not send before this time (exponential backoff after failures). */
  backoffUntil: number | null;
  /** Consecutive failed sends. */
  failures: number;
}

export interface SentLogEntry {
  at: number;
  count: number;
}

/** Personal stats, kept only on this device. */
export interface Stats {
  totalSent: number;
  firstSentAt: number | null;
}

export interface Settings {
  /** The one opt-in: share searches made on supported search engines. */
  sharePassive: boolean;
  /** Pause all sending. Items stay queued. */
  paused: boolean;
  /** Dev builds only: override API base URL. */
  apiBaseOverride: string | null;
  /** Language of the extension's pages: "auto" follows Chrome. */
  lang: LangSetting;
}

/** The "rate us" card in the popup: asked once the extension has been useful for a while. */
export interface ReviewPrompt {
  /** "asked" = answered yes or no; "never" = dismissed for good. */
  state: "pending" | "asked" | "never";
  /** "Not now" hides it until this time. */
  snoozeUntil: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  sharePassive: false,
  paused: false,
  apiBaseOverride: null,
  lang: "auto",
};

export const INITIAL_REVIEW_PROMPT: ReviewPrompt = { state: "pending", snoozeUntil: null };

export const INITIAL_FLUSH_STATE: FlushState = { nextSendAfter: null, backoffUntil: null, failures: 0 };
export const INITIAL_STATS: Stats = { totalSent: 0, firstSentAt: null };
