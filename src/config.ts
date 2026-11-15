import hosts from "./hosts.json";

// Build-time configuration. Values are injected by build.mjs (esbuild `define`).
// The typeof guards keep this module importable from unit tests, where nothing is defined.
declare const __API_BASE__: string;
declare const __WEB_BASE__: string;
declare const __SITE_BASE__: string;
declare const __DEV__: boolean;
declare const __SOURCE_URL__: string;

export const API_BASE: string = typeof __API_BASE__ === "string" ? __API_BASE__ : "http://localhost:8787";
export const WEB_BASE: string = typeof __WEB_BASE__ === "string" ? __WEB_BASE__ : "http://localhost:5173";
/** The landing site (openkeyword.org). Its privacy policy is the one that covers the extension. */
export const SITE_BASE: string = typeof __SITE_BASE__ === "string" ? __SITE_BASE__ : "http://localhost:4321";
export const IS_DEV: boolean = typeof __DEV__ === "boolean" ? __DEV__ : true;

/** Public source code of the extension. Empty until published: the "open source" line stays hidden. */
export const SOURCE_URL: string = typeof __SOURCE_URL__ === "string" ? __SOURCE_URL__ : "";

export const PRIVACY_URL = `${SITE_BASE}/privacy`;
/** Feedback form on the website ("Not really" in the review card). */
export const FEEDBACK_URL = `${WEB_BASE}/#/feedback`;
/** Opened by Chrome after the extension is removed (chrome.runtime.setUninstallURL). */
export const UNINSTALL_URL = `${WEB_BASE}/#/bye`;
/** This extension's reviews on the Chrome Web Store (the store id is the runtime id once published). */
export const reviewUrl = (id: string): string => `https://chromewebstore.google.com/detail/${id}/reviews`;
export const WEB_APP_URL = `${WEB_BASE}/`;

/** Default market. All captured searches are tagged with this market for now. */
export const DEFAULT_COUNTRY = "us";
export const DEFAULT_LANG = "en";

/**
 * Search result pages we may observe, only after the user opts in (optional host permissions).
 * Same file feeds manifest.json in build.mjs, so they cannot drift apart.
 */
export const SEARCH_ORIGINS: string[] = hosts.search;
