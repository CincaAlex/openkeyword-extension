// Welcome page, opened once after install. Rendered from the catalog so it follows the language setting.
import { WEB_APP_URL } from "./config.ts";
import { makeT, rich, type T } from "./i18n/index.ts";
import { getSettings, onLocalChange } from "./lib/chrome.ts";
import { $, h, replaceChildren } from "./ui/dom.ts";
import { mountShareSwitch, whatIsSent } from "./ui/optins.ts";

const root = $("app");
let t: T = makeT("auto");
const optins = h("div", { id: "optins" });
let switchMounted = false;

function render(): void {
  const W = t.m.welcome;
  document.title = W.title;
  document.documentElement.lang = t.lang;
  replaceChildren(
    root,
    h("p", { class: "eyebrow" }, W.eyebrow),
    h("h1", null, W.h1),
    h("p", { class: "lead" }, W.lead),
    h("section", { class: "card" }, h("h2", null, W.card1Title), h("p", { class: "muted" }, rich(W.card1Body)), optins),
    h("section", { class: "card" }, h("h2", null, W.card2Title), whatIsSent(t)),
    h(
      "section",
      { class: "card" },
      h("h2", null, W.card3Title),
      h("p", { class: "muted" }, W.card3Body, " ", h("a", { href: WEB_APP_URL, target: "_blank", rel: "noopener" }, W.card3Link)),
    ),
    h("p", null, h("button", { id: "done", class: "primary", type: "button", onclick: () => window.close() }, W.done)),
  );
  if (!switchMounted) {
    switchMounted = true;
    mountShareSwitch(optins, () => t);
  }
}

async function load(): Promise<void> {
  t = makeT((await getSettings()).lang);
  render();
}

void load();
onLocalChange(["settings"], () => void load());
