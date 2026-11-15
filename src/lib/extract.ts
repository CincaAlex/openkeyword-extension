// URL → search query extraction for passive capture. Pure; no chrome.* access.
import type { CaptureEngine } from "./types.ts";

export interface CapturedSearch {
  engine: CaptureEngine;
  /** Raw query exactly as in the URL (decoded). Must still go through scrubQuery(..., "passive"). */
  query: string;
}

// DuckDuckGo vertical tabs (images, videos, news, maps, shopping) are not web searches.
const DDG_VERTICALS = new Set(["images", "videos", "news", "maps", "shopping"]);

function intParam(p: URLSearchParams, key: string): number {
  const v = p.get(key);
  if (v === null) return 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function result(engine: CaptureEngine, q: string | null): CapturedSearch | null {
  const query = (q ?? "").trim();
  return query ? { engine, query } : null;
}

/**
 * Returns the search query for a first-page web search on a supported engine, else null.
 * Skip rules: non-search paths, pagination (Google start>0, Bing first>1, Amazon page>1),
 * Google vertical tabs (tbm=, udm=), DuckDuckGo vertical tabs.
 */
export function extractSearch(rawUrl: string): CapturedSearch | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const p = u.searchParams;
  switch (u.hostname) {
    case "www.google.com":
      if (u.pathname !== "/search") return null;
      if (p.has("tbm") || p.has("udm")) return null;
      if (intParam(p, "start") > 0) return null;
      return result("google", p.get("q"));
    case "www.bing.com":
      if (u.pathname !== "/search") return null;
      if (intParam(p, "first") > 1) return null;
      return result("bing", p.get("q"));
    case "duckduckgo.com":
      if (u.pathname !== "/") return null;
      if (p.has("iax")) return null;
      if (DDG_VERTICALS.has(p.get("ia") ?? "")) return null;
      return result("duckduckgo", p.get("q"));
    case "www.youtube.com":
      if (u.pathname !== "/results") return null;
      return result("youtube", p.get("search_query"));
    case "www.amazon.com":
      if (u.pathname !== "/s") return null;
      if (intParam(p, "page") > 1) return null;
      return result("amazon", p.get("k"));
    default:
      return null;
  }
}

export const RECENT_WINDOW_MS = 30 * 60_000;

/**
 * Repeat filter. `recent` maps keyword → last-seen time. Returns whether this keyword
 * is new within the window, and the pruned/updated map to persist.
 */
export function checkRecent(
  recent: Record<string, number>,
  kw: string,
  now: number,
  windowMs: number = RECENT_WINDOW_MS,
): { isRepeat: boolean; recent: Record<string, number> } {
  const next: Record<string, number> = {};
  for (const [k, t] of Object.entries(recent)) if (now - t < windowMs) next[k] = t;
  const isRepeat = kw in next;
  next[kw] = now;
  return { isRepeat, recent: next };
}
