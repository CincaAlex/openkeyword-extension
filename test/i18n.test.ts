import { describe, expect, it } from "vitest";
import locales from "../store-listing/locales.json";
import { de } from "../src/i18n/de.ts";
import { en } from "../src/i18n/en.ts";
import { es } from "../src/i18n/es.ts";
import { fr } from "../src/i18n/fr.ts";
import { it as itLang } from "../src/i18n/it.ts";
import { ja } from "../src/i18n/ja.ts";
import { ptBR } from "../src/i18n/pt-BR.ts";
import { ro } from "../src/i18n/ro.ts";
import { REVIEW_RULES, shouldAskForReview } from "../src/lib/review.ts";

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 10, 20);
const pending = { state: "pending" as const, snoozeUntil: null };
const used = { totalSent: 25, firstSentAt: NOW - 10 * DAY };

describe("review prompt", () => {
  it("waits until the extension has been useful", () => {
    expect(shouldAskForReview(pending, NOW - 1 * DAY, used, true, NOW)).toBe(false); // too new
    expect(shouldAskForReview(pending, NOW - 5 * DAY, { totalSent: 3, firstSentAt: NOW }, true, NOW)).toBe(false); // too little use
    expect(shouldAskForReview(pending, NOW - 5 * DAY, used, false, NOW)).toBe(false); // sharing off
    expect(shouldAskForReview(pending, undefined, used, true, NOW)).toBe(false);
    expect(shouldAskForReview(pending, NOW - 5 * DAY, used, true, NOW)).toBe(true);
  });

  it("asks once, and 'Not now' waits", () => {
    expect(shouldAskForReview({ state: "asked", snoozeUntil: null }, NOW - 9 * DAY, used, true, NOW)).toBe(false);
    expect(shouldAskForReview({ state: "never", snoozeUntil: null }, NOW - 9 * DAY, used, true, NOW)).toBe(false);
    const snoozed = { state: "pending" as const, snoozeUntil: NOW + DAY };
    expect(shouldAskForReview(snoozed, NOW - 9 * DAY, used, true, NOW)).toBe(false);
    expect(shouldAskForReview(snoozed, NOW - 9 * DAY, used, true, NOW + 2 * DAY)).toBe(true);
    expect(REVIEW_RULES.SNOOZE_MS).toBe(14 * DAY);
  });
});

function strings(obj: unknown, path = "", out: Record<string, string[]> = {}): Record<string, string[]> {
  if (typeof obj === "string") (out[path] ??= []).push(obj);
  else if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    const isPlural = typeof o.other === "string" && Object.keys(o).every((k) => ["zero", "one", "two", "few", "many", "other"].includes(k));
    if (isPlural) for (const v of Object.values(o)) (out[path] ??= []).push(v as string);
    else for (const [k, v] of Object.entries(o)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}
const vars = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort();

describe("extension translations", () => {
  const source = strings(en);
  for (const [lang, cat] of Object.entries({ ro, es, de, it: itLang, ja, "pt-BR": ptBR, fr })) {
    it(`${lang}: same placeholders as English, nothing empty`, () => {
      const got = strings(cat);
      for (const [path, forms] of Object.entries(source)) {
        expect(got[path], `${lang} ${path} missing`).toBeDefined();
        for (const f of got[path]!) expect(f.trim().length, `${lang} ${path} empty`).toBeGreaterThan(0);
        expect(vars(got[path]!.join(" ")), `${lang} ${path}`).toEqual(vars(forms.join(" ")));
      }
      // The footer splits on {login}: exactly one, so the link renders once.
      expect(cat.popup.footLogin.split("{login}")).toHaveLength(2);
    });
  }
});

describe("store names and summaries", () => {
  it("fit Chrome's limits in every language", () => {
    for (const [code, l] of Object.entries(locales as Record<string, { name: string; summary: string; summaryOpenSource: string }>)) {
      expect(l.name.length, `${code} name`).toBeLessThanOrEqual(75);
      expect(l.summary.length, `${code} summary`).toBeLessThanOrEqual(132);
      expect(l.summaryOpenSource.length, `${code} summaryOpenSource`).toBeLessThanOrEqual(132);
      expect(l.name.startsWith("OpenKeyword"), `${code} name brand`).toBe(true);
    }
    expect(Object.keys(locales).sort()).toEqual(["de", "en", "es", "fr", "it", "ja", "pt_BR", "ro"]);
  });
});
