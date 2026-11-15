// Toolbar popup: sharing on/off, pause, personal stats, the waiting list, settings, link to the website.
// Looks like a small keyboard: lock lights on top, a typing strip, the outbox, and a row of keycaps.
import { FEEDBACK_URL, IS_DEV, PRIVACY_URL, WEB_APP_URL, reviewUrl } from "./config.ts";
import { LANGS, langName, makeT, rich, type LangSetting, type T } from "./i18n/index.ts";
import {
  authClient,
  disablePassiveCapture,
  enablePassiveCapture,
  getApiBase,
  getLocal,
  getQueue,
  getSettings,
  getStats,
  hasSearchPermissions,
  onLocalChange,
  setLocal,
  updateSettings,
} from "./lib/chrome.ts";
import { sendToBackground } from "./lib/messages.ts";
import { QUEUE_RULES } from "./lib/queue.ts";
import { REVIEW_RULES, shouldAskForReview } from "./lib/review.ts";
import { INITIAL_REVIEW_PROMPT, type FlushState, type QueueItem, type ReviewPrompt } from "./lib/types.ts";
import { $, fmtDate, fmtDateTime, h, replaceChildren } from "./ui/dom.ts";

type View = "main" | "queue" | "settings";
let view: View = "main";
let confirmingDelete = false;
let note = "";
/** Review card: "sorry" after the person answered "Not really". */
let reviewStep: "ask" | "sorry" = "ask";
/** Queue tab page (0-based). A full page must still fit Chrome's 600px popup height. */
let queuePage = 0;
const QUEUE_PAGE_SIZE = 10;
const root = $("app");
let t: T = makeT("auto");

const ENGINE_LABEL: Record<string, string> = { google: "Google", bing: "Bing", duckduckgo: "DuckDuckGo", youtube: "YouTube", amazon: "Amazon" };

function go(v: View): void {
  view = v;
  confirmingDelete = false;
  note = "";
  if (v === "queue") queuePage = 0;
  void render();
}

/** Whole minutes until an item is sent, never below 0. */
function minsLeft(item: QueueItem, now: number): number {
  return Math.max(0, Math.ceil((item.addedAt + QUEUE_RULES.HOLD_MS - now) / 60_000));
}

function ago(ts: number, now = Date.now()): string {
  const min = Math.round((now - ts) / 60_000);
  if (min < 1) return t.m.time.justNow;
  if (min < 60) return t.p(t.m.time.minAgo, min);
  const hours = Math.round(min / 60);
  if (hours < 24) return t.p(t.m.time.hAgo, hours);
  return t.p(t.m.time.dAgo, Math.round(hours / 24));
}

function turnOn(): void {
  // Must run synchronously in the click so Chrome shows the permission prompt.
  enablePassiveCapture().then(
    (granted) => {
      note = granted ? "" : t.m.popup.denied;
      void render();
    },
    () => undefined,
  );
}

function openTab(url: string): void {
  void chrome.tabs.create({ url });
  window.close();
}

function openLogin(): void {
  openTab(chrome.runtime.getURL("login.html"));
}

async function removeItem(id: string): Promise<void> {
  await sendToBackground({ type: "queueRemove", id });
  void render();
}

// ---- keyboard parts ---------------------------------------------------------------------

function logo(): HTMLElement {
  return h("span", { class: "brand" }, h("img", { src: "logo.svg", alt: "" }), "OpenKeyword");
}

/** A lock light, like Caps Lock on a keyboard: a dot over a short label. */
function lockLight(label: string, lit: boolean, title: string): HTMLElement {
  return h("span", { class: "lock", title }, h("span", { class: lit ? "led" : "led off" }), h("span", { class: "lock-label" }, label));
}

/** A keycap button. `pressed` sinks it and lights its own dot (for toggles). */
function key(label: string, onclick: () => void, opts: { pressed?: boolean; dark?: boolean; wide?: boolean; aria?: string } = {}): HTMLElement {
  const cls = ["key", opts.dark ? "dark" : "", opts.wide ? "wide" : "", opts.pressed ? "pressed" : ""].filter(Boolean).join(" ");
  const props: Record<string, unknown> = { type: "button", class: cls, onclick, "aria-label": opts.aria };
  if (opts.pressed !== undefined) props["aria-pressed"] = String(opts.pressed);
  return h("button", props, opts.pressed !== undefined ? h("span", { class: opts.pressed ? "key-dot on" : "key-dot" }) : null, label);
}

/** Logo and the three lock lights; shared by the Home and Queue tabs. */
function topBar(on: boolean, paused: boolean, email: string | null): HTMLElement {
  const P = t.m.popup;
  return h(
    "header",
    { class: "pop-head" },
    logo(),
    h(
      "span",
      { class: "locks" },
      lockLight(P.lockShare, on, on ? P.sharingOn : P.sharingOff),
      lockLight(P.lockPause, on && paused, paused ? P.pausedYes : P.pausedNo),
      lockLight(P.lockAcct, !!email, email ? t.f(P.loggedInAs, { email }) : P.notLoggedIn),
    ),
  );
}

/** Home / Queue tabs. The queue count turns orange while searches are waiting. */
function tabs(active: "main" | "queue", waiting: number): HTMLElement {
  const P = t.m.popup;
  const tab = (v: "main" | "queue", label: string, extra?: HTMLElement) =>
    h("button", { type: "button", class: "tab", role: "tab", "aria-selected": String(active === v), onclick: () => active !== v && go(v) }, label, extra ?? null);
  return h(
    "nav",
    { class: "tabs", role: "tablist", "aria-label": P.sections },
    tab("main", P.home),
    tab("queue", P.queue, h("span", { class: waiting > 0 ? "count hot" : "count" }, String(waiting))),
  );
}

/** The wide "spacebar" key that opens the website. */
function spacebar(): HTMLElement {
  return h("a", { class: "key dark wide space", href: WEB_APP_URL, target: "_blank", rel: "noopener" }, t.m.popup.research);
}

/** Back key for the sub-views. */
function escKey(): HTMLElement {
  return h("button", { type: "button", class: "key esc", onclick: () => go("main"), "aria-label": t.m.popup.back }, h("span", { class: "key-sub" }, "esc"), t.m.popup.backKey);
}

/** The recessed strip that shows the newest captured search, typed out, with a cursor. */
function typingStrip(on: boolean, paused: boolean, newest: QueueItem | undefined, flush: FlushState | undefined): HTMLElement {
  const P = t.m.popup;
  let label: string;
  let text: string;
  let typing = false;
  let warn = false;
  const now = Date.now();
  if (!on) {
    label = P.stripOff;
    text = P.stripOffText;
  } else if (flush && flush.failures > 0 && newest && !paused) {
    // The last send failed (server down, offline, rate limit). Nothing is lost: items stay queued.
    const mins = flush.backoffUntil ? Math.ceil((flush.backoffUntil - now) / 60_000) : 0;
    label = P.stripFail;
    text = t.f(P.stripRetry, { when: mins > 0 ? t.p(P.inMin, mins) : P.soon });
    warn = true;
  } else if (newest) {
    label = paused ? P.stripCapturedPaused : P.stripLast;
    text = newest.kw;
    typing = true;
  } else {
    label = paused ? P.stripPaused : P.stripListening;
    text = P.stripWaiting;
    typing = true;
  }
  return h(
    "section",
    { class: warn ? "strip warn-strip" : "strip", "aria-live": "polite" },
    h("span", { class: "strip-label" }, label),
    h("span", { class: "strip-text" }, text, typing ? h("span", { class: "cursor", "aria-hidden": "true" }) : null),
  );
}

/** "Enjoying OpenKeyword?" card. Yes → store reviews; Not really → feedback form; Not now → 14 days. */
function reviewCard(): HTMLElement {
  const P = t.m.popup;
  const done = (state: ReviewPrompt["state"], snoozeUntil: number | null = null) => setLocal("reviewPrompt", { state, snoozeUntil });
  if (reviewStep === "sorry") {
    return h(
      "section",
      { class: "review", "aria-live": "polite" },
      h("p", { class: "muted small" }, P.reviewSorry),
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "btn primary", onclick: () => openTab(`${FEEDBACK_URL}?from=popup&lang=${t.lang}`) }, P.reviewFeedback),
        h("button", { type: "button", class: "btn", onclick: () => { reviewStep = "ask"; void render(); } }, t.m.common.cancel),
      ),
    );
  }
  return h(
    "section",
    { class: "review", "aria-labelledby": "review-h" },
    h("p", { class: "review-stars", "aria-hidden": "true" }, "★★★★★"),
    h("p", { class: "intro-title", id: "review-h" }, P.reviewTitle),
    h("p", { class: "muted small" }, P.reviewBody),
    h(
      "div",
      { class: "row" },
      h("button", {
        type: "button",
        class: "btn primary",
        onclick: async () => {
          await done("asked");
          openTab(reviewUrl(chrome.runtime.id));
        },
      }, P.reviewYes),
      h("button", {
        type: "button",
        class: "btn",
        onclick: async () => {
          reviewStep = "sorry";
          await done("asked");
        },
      }, P.reviewNo),
      h("button", { type: "button", class: "linkish small", onclick: () => void done("pending", Date.now() + REVIEW_RULES.SNOOZE_MS) }, P.reviewLater),
    ),
  );
}

// ---- views ------------------------------------------------------------------------------

async function renderMain(): Promise<HTMLElement[]> {
  const P = t.m.popup;
  const [s, queue, stats, log, account, flush, prompt, installedAt] = await Promise.all([
    getSettings(),
    getQueue(),
    getStats(),
    getLocal("sentLog"),
    authClient.getSession(),
    getLocal("flushState"),
    getLocal("reviewPrompt"),
    getLocal("installedAt"),
  ]);
  const on = s.sharePassive;
  const newestFirst = [...queue].reverse();
  const lastSent = log?.[0]?.at;

  const parts: HTMLElement[] = [
    topBar(on, s.paused, account?.email ?? null),
    tabs("main", queue.length),
    typingStrip(on, s.paused, newestFirst[0], flush),
  ];

  if (!on) {
    parts.push(
      h(
        "section",
        { class: "intro" },
        h("p", { class: "intro-title" }, P.introTitle),
        h("p", { class: "muted" }, t.f(P.introBody, { engines: t.m.engines })),
        h("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener", class: "small" }, P.whatShared),
      ),
    );
  }

  if (on || stats.totalSent > 0) {
    const bits = [t.p(P.queued, queue.length), P.waits, t.f(P.sent, { n: stats.totalSent })];
    if (lastSent) bits.push(t.f(P.last, { ago: ago(lastSent) }));
    parts.push(h("p", { class: "meta", title: lastSent ? t.f(P.lastTitle, { time: fmtDateTime(lastSent, t.lang) }) : "" }, bits.join(" · ")));
  }

  if (note) parts.push(h("p", { class: "note warn" }, note));

  if (reviewStep === "sorry" || shouldAskForReview(prompt ?? INITIAL_REVIEW_PROMPT, installedAt, stats, on)) parts.push(reviewCard());

  // Key row: Share toggles sharing (turning on needs the click for Chrome's permission prompt), Pause toggles sending.
  parts.push(
    h(
      "div",
      { class: "keys" },
      key(P.keyShare, on ? () => void disablePassiveCapture() : turnOn, { pressed: on, aria: on ? P.turnOff : P.turnOn }),
      key(P.keyPause, () => void updateSettings({ paused: !s.paused }), { pressed: on && s.paused, aria: s.paused ? P.resumeSending : P.pauseSending }),
      key(P.keySetup, () => go("settings")),
    ),
  );
  parts.push(on ? spacebar() : key(P.turnOn, turnOn, { dark: true, wide: true }));

  if (!account) {
    const [before, after] = P.footLogin.split("{login}");
    parts.push(h("p", { class: "foot-line" }, before ?? "", h("button", { type: "button", class: "linkish", onclick: openLogin }, t.m.common.logIn), after ?? ""));
  } else if (stats.firstSentAt) {
    parts.push(h("p", { class: "foot-line" }, t.f(P.since, { date: fmtDate(stats.firstSentAt, t.lang) })));
  }
  return parts;
}

async function renderQueue(): Promise<HTMLElement[]> {
  const P = t.m.popup;
  const [s, queue, account] = await Promise.all([getSettings(), getQueue(), authClient.getSession()]);
  const now = Date.now();
  // Soonest to send first, so the searches about to leave are the ones on page 1.
  const sorted = [...queue].sort((a, b) => a.addedAt - b.addedAt);
  const pages = Math.max(1, Math.ceil(sorted.length / QUEUE_PAGE_SIZE));
  queuePage = Math.min(queuePage, pages - 1);
  const start = queuePage * QUEUE_PAGE_SIZE;
  const pageItems = sorted.slice(start, start + QUEUE_PAGE_SIZE);

  const list =
    sorted.length === 0
      ? h("p", { class: "empty-list" }, P.queueEmpty)
      : h(
          "ul",
          { class: "qlist" },
          pageItems.map((i) => {
            const m = minsLeft(i, now);
            const engine = i.engine ? ENGINE_LABEL[i.engine] : "";
            return h(
              "li",
              { title: `${engine ? engine + " · " : ""}${m > 0 ? t.f(P.sendsIn, { n: m }) : P.sendingSoon}` },
              h("span", { class: "q-kw" }, i.kw),
              h("span", { class: m <= 5 ? "q-time soon" : "q-time" }, m > 0 ? t.f(P.minShort, { n: m }) : P.now),
              h("button", { type: "button", class: "key mini", "aria-label": t.f(P.removeKw, { kw: i.kw }), onclick: () => void removeItem(i.id) }, "✕"),
            );
          }),
        );

  const parts: HTMLElement[] = [topBar(s.sharePassive, s.paused, account?.email ?? null), tabs("queue", queue.length)];
  if (sorted.length > 0) parts.push(h("div", { class: "q-head" }, h("span", null, P.colKeyword), h("span", null, P.colSendsIn)));
  parts.push(list);

  if (pages > 1) {
    parts.push(
      h(
        "div",
        { class: "pager" },
        h("span", { class: "pager-range" }, t.f(P.range, { from: start + 1, to: start + pageItems.length, total: sorted.length })),
        h(
          "span",
          { class: "pager-keys" },
          key("‹", () => { queuePage = Math.max(0, queuePage - 1); void render(); }, { aria: P.prev }),
          h("span", { class: "pager-pos" }, `${queuePage + 1} / ${pages}`),
          key("›", () => { queuePage = Math.min(pages - 1, queuePage + 1); void render(); }, { aria: P.next }),
        ),
      ),
    );
  }

  const actions = h("div", { class: "queue-actions" });
  if (queue.length > 0) {
    actions.append(key(queue.length > 1 ? t.f(P.removeAll, { n: queue.length }) : P.remove, async () => { await sendToBackground({ type: "queueClear" }); void render(); }));
  }
  if (IS_DEV && queue.length > 0) {
    actions.append(
      key("Send now (dev)", async () => { const r = await sendToBackground({ type: "flushNow" }); note = r.ok ? `Dev: ${r.detail}` : `Dev: ${r.error}`; void render(); }),
    );
  }
  if (actions.childElementCount) parts.push(actions);
  parts.push(h("p", { class: "foot-line" }, P.footQueue));
  if (note) parts.push(h("p", { class: "note" }, note));
  return parts;
}

function languageSelect(setting: LangSetting): HTMLElement {
  const select = h(
    "select",
    { id: "lang", class: "wide", onchange: () => void updateSettings({ lang: select.value as LangSetting }) },
    h("option", { value: "auto", selected: setting === "auto" }, t.f(t.m.common.langAuto, { lang: langName(makeT("auto").lang) })),
    LANGS.map((l) => h("option", { value: l, lang: l, selected: setting === l }, langName(l))),
  );
  return h("section", { class: "card" }, h("label", { class: "label", for: "lang" }, t.m.common.language), select);
}

async function renderSettings(): Promise<HTMLElement[]> {
  const P = t.m.popup;
  const [s, granted, apiBase, account] = await Promise.all([getSettings(), hasSearchPermissions(), getApiBase(), authClient.getSession()]);
  const parts: HTMLElement[] = [
    h("header", { class: "pop-head" }, escKey(), h("span", { class: "view-name" }, P.setup)),
    h(
      "section",
      { class: "card" },
      h("p", { class: "label" }, P.access),
      h("p", null, granted ? P.granted : P.notGranted, h("span", { class: "muted" }, ` · ${t.m.engines}`)),
      h("p", { class: "muted small" }, P.accessHint),
      granted
        ? h("button", { type: "button", class: "btn", onclick: () => void disablePassiveCapture() }, P.turnOffRemove)
        : h("button", { type: "button", class: "btn primary", onclick: turnOn }, P.turnOn),
    ),
    languageSelect(s.lang),
  ];

  parts.push(
    h(
      "section",
      { class: "card" },
      h("p", { class: "label" }, P.account),
      account ? h("p", null, rich(t.f(P.loggedInRich, { email: account.email }))) : h("p", { class: "muted small" }, P.accountHint),
      account
        ? h("button", { type: "button", class: "btn", onclick: async () => { await authClient.signOut(); void render(); } }, t.m.common.logOut)
        : h("button", { type: "button", class: "btn primary", onclick: openLogin }, t.m.common.logIn),
    ),
  );

  const del = h("section", { class: "card" }, h("p", { class: "label" }, P.deleteTitle));
  if (!confirmingDelete) {
    del.append(
      h("p", { class: "muted small" }, P.deleteHint),
      h("button", { type: "button", class: "btn danger", onclick: () => { confirmingDelete = true; void render(); } }, P.deleteBtn),
    );
  } else {
    del.append(
      h("p", null, P.deleteConfirm),
      h(
        "div",
        { class: "row" },
        h("button", {
          type: "button",
          class: "btn danger",
          onclick: async () => {
            const r = await sendToBackground({ type: "deleteData" });
            confirmingDelete = false;
            note = r.ok ? P.deleted : P.deleteFailed;
            void render();
          },
        }, P.deleteYes),
        h("button", { type: "button", class: "btn", onclick: () => { confirmingDelete = false; void render(); } }, t.m.common.cancel),
      ),
    );
  }
  parts.push(del);
  if (note) parts.push(h("p", { class: "note" }, note));

  if (IS_DEV) {
    const input = h("input", { type: "url", value: s.apiBaseOverride ?? "", placeholder: apiBase, class: "wide" });
    parts.push(
      h(
        "section",
        { class: "card dev" },
        h("p", { class: "label" }, "Developer"),
        h("p", { class: "muted small" }, `API: ${apiBase}`),
        input,
        h("button", { type: "button", class: "btn", onclick: () => void updateSettings({ apiBaseOverride: input.value.trim() || null }) }, "Save API base"),
      ),
    );
  }
  parts.push(
    h(
      "p",
      { class: "foot-line" },
      h("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener" }, t.m.common.privacy),
      ` · v${chrome.runtime.getManifest().version}`,
    ),
  );
  return parts;
}

async function render(): Promise<void> {
  t = makeT((await getSettings()).lang);
  document.documentElement.lang = t.lang;
  const parts = view === "queue" ? await renderQueue() : view === "settings" ? await renderSettings() : await renderMain();
  replaceChildren(root, h("div", { class: "board" }, parts));
}

void render();
onLocalChange(["settings", "queue", "stats", "sentLog", "auth", "flushState", "reviewPrompt"], () => void render());
