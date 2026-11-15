import { describe, expect, it } from "vitest";
import { scrubQuery } from "../shared/index.ts";
import { checkRecent, extractSearch, RECENT_WINDOW_MS } from "../src/lib/extract.ts";

describe("extractSearch", () => {
  it.each([
    ["https://www.google.com/search?q=running+shoes&oq=running", "google", "running shoes"],
    ["https://www.google.com/search?q=running%20shoes&start=0", "google", "running shoes"],
    ["https://www.bing.com/search?q=coffee+grinder&form=QBLH", "bing", "coffee grinder"],
    ["https://www.bing.com/search?q=coffee&first=1", "bing", "coffee"],
    ["https://duckduckgo.com/?q=hiking+boots&t=h_&ia=web", "duckduckgo", "hiking boots"],
    ["https://www.youtube.com/results?search_query=guitar+lessons", "youtube", "guitar lessons"],
    ["https://www.amazon.com/s?k=usb+c+cable&ref=nb_sb_noss", "amazon", "usb c cable"],
    ["https://www.amazon.com/s?k=desk+lamp&page=1", "amazon", "desk lamp"],
  ])("extracts %s", (url, engine, query) => {
    expect(extractSearch(url)).toEqual({ engine, query });
  });

  it.each([
    // pagination
    "https://www.google.com/search?q=shoes&start=10",
    "https://www.bing.com/search?q=shoes&first=11",
    "https://www.amazon.com/s?k=shoes&page=2",
    // Google vertical tabs
    "https://www.google.com/search?q=shoes&tbm=isch",
    "https://www.google.com/search?q=shoes&tbm=nws",
    "https://www.google.com/search?q=shoes&udm=2",
    // DuckDuckGo verticals
    "https://duckduckgo.com/?q=shoes&iax=images&ia=images",
    "https://duckduckgo.com/?q=shoes&ia=videos",
    // non-search pages on the same hosts
    "https://www.google.com/maps?q=shoes",
    "https://www.google.com/",
    "https://www.youtube.com/watch?v=abc",
    "https://www.amazon.com/dp/B000123?k=shoes",
    "https://duckduckgo.com/about?q=shoes",
    "https://www.bing.com/images/search?q=shoes",
    // other hosts / malformed / empty
    "https://www.google.co.uk/search?q=shoes",
    "https://example.com/search?q=shoes",
    "chrome://newtab/",
    "not a url",
    "https://www.google.com/search?q=",
    "https://www.google.com/search?q=+++",
    "https://www.youtube.com/results",
  ])("skips %s", (url) => {
    expect(extractSearch(url)).toBeNull();
  });

  it("returns the raw query, which passive scrubbing can still drop", () => {
    const sensitive = extractSearch("https://www.google.com/search?q=hiv+symptoms");
    expect(sensitive?.query).toBe("hiv symptoms");
    expect(scrubQuery(sensitive!.query, "passive")).toBeNull();
    const ok = extractSearch("https://www.bing.com/search?q=Best%20Running%20Shoes");
    expect(scrubQuery(ok!.query, "passive")).toBe("best running shoes");
  });
});

describe("checkRecent", () => {
  const t0 = 1_700_000_000_000;

  it("flags a repeat within 30 minutes", () => {
    const a = checkRecent({}, "shoes", t0);
    expect(a.isRepeat).toBe(false);
    const b = checkRecent(a.recent, "shoes", t0 + 29 * 60_000);
    expect(b.isRepeat).toBe(true);
  });

  it("allows the same query again after the window and prunes old entries", () => {
    const a = checkRecent({ shoes: t0, hats: t0 }, "socks", t0 + 1000);
    const b = checkRecent(a.recent, "shoes", t0 + RECENT_WINDOW_MS);
    expect(b.isRepeat).toBe(false);
    expect(Object.keys(b.recent).sort()).toEqual(["shoes", "socks"]);
  });
});
