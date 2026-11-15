import { normalizeKeyword, validateKeyword } from "./normalize.ts";

export type ScrubMode = "research" | "passive";

// Starter list. Matched as whole words (or word prefixes ending in *). Extend with care.
const SENSITIVE_TERMS = [
  // health
  "hiv", "aids", "std", "sti", "herpes", "chlamydia", "gonorrhea", "syphilis", "cancer", "tumor",
  "depression", "suicide", "suicidal", "self harm", "anxiety", "bipolar", "schizophrenia", "overdose",
  "pregnan*", "abortion", "miscarriage", "rehab", "addiction", "symptom*", "diagnos*", "chemo*",
  // adult
  "porn*", "xxx", "nude*", "naked", "escort*", "onlyfans", "sex", "sexual", "fetish",
  // legal / crime
  "arrest*", "lawyer", "attorney", "divorce", "custody", "warrant", "dui", "bail", "lawsuit",
  "criminal record", "mugshot*",
  // finance distress / identity
  "bankrupt*", "debt", "loan", "payday", "foreclosure", "ssn", "social security number", "passport",
  // people lookup
  "who is", "address of", "phone number", "people search", "background check",
  // orientation / religion / politics as personal queries
  "am i gay", "am i trans", "coming out",
];

const SENSITIVE_RES: RegExp[] = SENSITIVE_TERMS.map((t) => {
  const prefix = t.endsWith("*");
  const body = (prefix ? t.slice(0, -1) : t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${body}${prefix ? "" : "(?=$|\\s)"}`);
});

export function isSensitive(norm: string): boolean {
  return SENSITIVE_RES.some((re) => re.test(norm));
}

/**
 * On-device scrub. Returns the normalized keyword to send, or null to drop it.
 * research = seed typed into our tool. passive = query captured from a search engine (stricter).
 */
export function scrubQuery(raw: string, mode: ScrubMode): string | null {
  const norm = normalizeKeyword(raw);
  if (validateKeyword(norm) !== null) return null;
  if (mode === "passive" && isSensitive(norm)) return null;
  return norm;
}
