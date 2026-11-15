// Types and limits shared with the OpenKeyword API.

/** One contributed search, exactly as sent to the API. */
export interface ContributeItem {
  kw: string;
  country: string;
  lang: string;
}

export const LIMITS = {
  KEYWORD_MIN_LEN: 2,
  KEYWORD_MAX_LEN: 80,
  KEYWORD_MAX_WORDS: 10,
} as const;
