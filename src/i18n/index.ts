// Extension translations. All languages are bundled (small), so pages render without waiting.
// The choice lives in settings.lang ("auto" follows Chrome's UI language and the browser's languages).
import { LANG_NAMES, fmt, parseRich, plural, resolveLang, type Lang, type LangSetting, type Plural } from "../../shared/i18n.ts";
import { de } from "./de.ts";
import { en, type Messages } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { it } from "./it.ts";
import { ja } from "./ja.ts";
import { ptBR } from "./pt-BR.ts";
import { ro } from "./ro.ts";

export { LANGS, LANG_NAMES, type Lang, type LangSetting } from "../../shared/i18n.ts";

const CATALOGS: Record<Lang, Messages> = { en, ro, es, de, it, ja, "pt-BR": ptBR, fr };

/** Browser language preferences, Chrome's UI language first. */
export function browserLangs(): string[] {
  const out: string[] = [];
  try {
    const ui = chrome.i18n?.getUILanguage?.();
    if (ui) out.push(ui);
  } catch {
    /* not in an extension context (tests) */
  }
  if (typeof navigator !== "undefined") out.push(...(navigator.languages ?? [navigator.language]));
  return out;
}

export interface T {
  lang: Lang;
  setting: LangSetting;
  m: Messages;
  f: (s: string, vars?: Record<string, string | number>) => string;
  p: (pl: Plural, n: number, vars?: Record<string, string | number>) => string;
}

export function makeT(setting: LangSetting): T {
  const lang = resolveLang(setting, browserLangs());
  return {
    lang,
    setting,
    m: CATALOGS[lang],
    f: (s, vars) => fmt(s, vars, lang),
    p: (pl, n, vars) => plural(pl, n, lang, vars),
  };
}

export function catalog(lang: Lang): Messages {
  return CATALOGS[lang];
}

export const langName = (l: Lang): string => LANG_NAMES[l];

/** Rich text (**bold**, [link](https://...)) as DOM nodes. Built with textContent only, never innerHTML. */
export function rich(text: string): Node[] {
  return parseRich(text).map((p) => {
    if (p.t === "b") {
      const b = document.createElement("strong");
      b.textContent = p.v;
      return b;
    }
    if (p.t === "a") {
      const a = document.createElement("a");
      a.href = p.href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = p.v;
      return a;
    }
    return document.createTextNode(p.v);
  });
}
