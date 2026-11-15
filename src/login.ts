// Login tab (opened from the popup). A full tab instead of the popup, because the popup closes as soon
// as the user switches to their email to read the code.
import { AuthError } from "../shared/index.ts";
import { PRIVACY_URL } from "./config.ts";
import { makeT, type T } from "./i18n/index.ts";
import { authClient, getSettings, onLocalChange } from "./lib/chrome.ts";
import { $, h, replaceChildren } from "./ui/dom.ts";

const root = $("app");
let t: T = makeT("auto");
let step: "email" | "code" | "done" = "email";
let email = "";
let error = "";
let busy = false;

function message(e: unknown): string {
  const L = t.m.login;
  if (e instanceof AuthError) {
    if (e.code === "invalid_email") return L.errEmail;
    if (e.code === "invalid_code") return L.errCode;
    if (e.code === "rate_limited") return L.errRate;
    if (e.code === "network") return L.errNetwork;
  }
  return L.errServer;
}

async function run(fn: () => Promise<void>): Promise<void> {
  busy = true;
  error = "";
  render();
  try {
    await fn();
  } catch (e) {
    error = message(e);
  }
  busy = false;
  render();
}

function render(): void {
  const L = t.m.login;
  document.title = L.title;
  document.documentElement.lang = t.lang;
  const parts: (HTMLElement | string)[] = [h("p", { class: "eyebrow" }, L.eyebrow), h("h1", null, L.h1)];
  const card = h("section", { class: "card" });
  if (step === "done") {
    parts.push(h("p", { class: "lead" }, t.f(L.doneLead, { email })));
    card.append(
      h("p", null, L.doneBody),
      h("p", null, h("button", { class: "primary", type: "button", onclick: () => window.close() }, L.close)),
    );
  } else if (step === "email") {
    const input = h("input", { type: "email", id: "email", autocomplete: "email", placeholder: "you@example.com", value: email, class: "wide" });
    parts.push(h("p", { class: "lead" }, L.emailLead));
    card.append(
      h(
        "form",
        {
          onsubmit: (e: Event) => {
            e.preventDefault();
            email = input.value.trim().toLowerCase();
            void run(async () => {
              await authClient.sendCode(email);
              step = "code";
            });
          },
        },
        h("label", { for: "email" }, L.email),
        h("div", { class: "row" }, input, h("button", { class: "primary", type: "submit", disabled: busy }, busy ? L.sending : L.send)),
      ),
    );
    setTimeout(() => input.focus(), 0);
  } else {
    const input = h("input", { type: "text", id: "code", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "123456", maxlength: "12" });
    parts.push(h("p", { class: "lead" }, t.f(L.codeLead, { email })));
    card.append(
      h(
        "form",
        {
          onsubmit: (e: Event) => {
            e.preventDefault();
            void run(async () => {
              await authClient.verifyCode(email, input.value);
              step = "done";
            });
          },
        },
        h("label", { for: "code" }, L.code),
        h("div", { class: "row" }, input, h("button", { class: "primary", type: "submit", disabled: busy }, busy ? L.checking : L.logIn)),
      ),
      h(
        "p",
        { class: "small" },
        h("button", { type: "button", class: "linkish", onclick: () => void run(() => authClient.sendCode(email)) }, L.resend),
        " · ",
        h("button", { type: "button", class: "linkish", onclick: () => { step = "email"; error = ""; render(); } }, L.other),
      ),
    );
    setTimeout(() => input.focus(), 0);
  }
  if (error) card.append(h("p", { class: "note warn", role: "alert" }, error));
  parts.push(card);
  parts.push(h("p", { class: "small muted" }, L.foot, " ", h("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener" }, t.m.common.privacy)));
  replaceChildren(root, parts);
}

async function load(): Promise<void> {
  t = makeT((await getSettings()).lang);
}

void Promise.all([load(), authClient.getSession()]).then(([, s]) => {
  if (s) {
    email = s.email;
    step = "done";
  }
  render();
});
onLocalChange(["settings"], () => void load().then(render));
