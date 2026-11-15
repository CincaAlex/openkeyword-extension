// Languages shared by the website and the extension: the list, browser-language detection,
// plurals, placeholders and a tiny safe rich-text format for translated paragraphs.

export const LANGS = ["en", "ro", "es", "de", "it", "ja", "pt-BR", "fr"] as const;
export type Lang = (typeof LANGS)[number];
/** What the user picked: a language, or "auto" to follow the browser. */
export type LangSetting = Lang | "auto";

/** Each language's own name for itself (shown in the language picker). */
export const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  ro: "Română",
  es: "Español",
  de: "Deutsch",
  it: "Italiano",
  ja: "日本語",
  "pt-BR": "Português (Brasil)",
  fr: "Français",
};

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && (LANGS as readonly string[]).includes(v);
}

export function parseLangSetting(v: unknown): LangSetting {
  return v === "auto" || isLang(v) ? v : "auto";
}

/**
 * Best supported language for the browser's preferred list (navigator.languages), else English.
 * Matches the base language, so "pt-PT" or "pt" get Brazilian Portuguese and "de-AT" gets German.
 */
export function detectLang(preferred: readonly string[] | undefined): Lang {
  for (const raw of preferred ?? []) {
    const tag = raw.toLowerCase();
    const exact = LANGS.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split("-")[0];
    const byBase = LANGS.find((l) => l.toLowerCase().split("-")[0] === base);
    if (byBase) return byBase;
  }
  return "en";
}

export function resolveLang(setting: LangSetting, preferred: readonly string[] | undefined): Lang {
  return setting === "auto" ? detectLang(preferred) : setting;
}

/** A message with plural forms (CLDR categories). `other` is always required. */
export interface Plural {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** Marks a plural entry in a catalog (keeps the type `Plural` so languages may add `few`, `many`). */
export const pl = (p: Plural): Plural => p;

/** Replaces {name} placeholders. Unknown names are left as they are. */
export function fmt(s: string, vars: Record<string, string | number> = {}, locale = "en"): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    if (v === undefined) return m;
    return typeof v === "number" ? v.toLocaleString(locale) : v;
  });
}

const pluralRules = new Map<string, Intl.PluralRules>();

/** Picks the plural form for n in this language, then fills {n} and other placeholders. */
export function plural(p: Plural, n: number, locale: string, vars: Record<string, string | number> = {}): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  const form = p[rules.select(n) as keyof Plural] ?? p.other;
  return fmt(form, { n, ...vars }, locale);
}

/**
 * Rich text in translations: **bold** and [link text](href). Nothing else is interpreted, and only
 * in-app links ("#/...") and https links are allowed, so a translation can never inject markup.
 */
export type RichPart = { t: "text"; v: string } | { t: "b"; v: string } | { t: "a"; v: string; href: string };

export function parseRich(s: string): RichPart[] {
  const out: RichPart[] = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ t: "text", v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "b", v: m[1] });
    else {
      const href = m[3]!;
      if (href.startsWith("#/") || href.startsWith("https://")) out.push({ t: "a", v: m[2]!, href });
      else out.push({ t: "text", v: m[2]! });
    }
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}
