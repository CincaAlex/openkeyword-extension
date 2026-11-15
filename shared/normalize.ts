import { LIMITS } from "./types.ts";

/** Canonical form of a keyword. Used everywhere a keyword is stored, compared or hashed. */
export function normalizeKeyword(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const OPERATOR_RE = /(^|\s)-?(site|inurl|intitle|allintitle|allinurl|intext|allintext|filetype|ext|cache|related|info|define|link|before|after):/;
const URL_RE = /(https?:\/\/|www\.)|\b[a-z0-9-]+\.(com|net|org|io|co|uk|de|fr|es|it|ro|ru|info|biz|app|dev|xyz|me|tv|us|ca|au|in)\b/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const LONG_DIGITS_RE = /\d{6,}/;
const LETTER_RE = /\p{L}/u;

/** Returns null when the normalized keyword is acceptable, otherwise a short reason. */
export function validateKeyword(norm: string): string | null {
  // Count Unicode code points (not UTF-16 units) to match the server-side length check.
  const len = [...norm].length;
  if (len < LIMITS.KEYWORD_MIN_LEN) return "too_short";
  if (len > LIMITS.KEYWORD_MAX_LEN) return "too_long";
  if (norm.split(" ").length > LIMITS.KEYWORD_MAX_WORDS) return "too_many_words";
  if (!LETTER_RE.test(norm)) return "no_letter";
  if (OPERATOR_RE.test(norm)) return "search_operator";
  if (EMAIL_RE.test(norm)) return "email";
  if (URL_RE.test(norm)) return "url";
  if (LONG_DIGITS_RE.test(norm)) return "long_digits";
  if (PHONE_RE.test(norm)) return "phone";
  return null;
}
