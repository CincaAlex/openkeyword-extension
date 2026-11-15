// The sharing opt-in and its explanation, used by the onboarding page and the popup.
import { PRIVACY_URL, SOURCE_URL } from "../config.ts";
import { rich, type T } from "../i18n/index.ts";
import { disablePassiveCapture, enablePassiveCapture, getSettings, hasSearchPermissions, onLocalChange, updateSettings } from "../lib/chrome.ts";
import { h, replaceChildren } from "./dom.ts";

export function whatIsSent(t: T): HTMLElement {
  const S = t.m.share;
  return h(
    "div",
    { class: "explain" },
    h("p", null, rich(S.exactly)),
    h("ul", null, h("li", null, S.li1), h("li", null, S.li2), h("li", null, S.li3), h("li", null, S.li4)),
    SOURCE_URL ? h("p", null, rich(t.f(S.openSource, { url: SOURCE_URL }))) : null,
    h("p", null, h("a", { href: PRIVACY_URL, target: "_blank", rel: "noopener" }, S.readPrivacy)),
  );
}

/** One switch for sharing, kept in sync with storage. Used on the onboarding page. */
export function mountShareSwitch(container: HTMLElement, getT: () => T): void {
  const note = h("p", { class: "note", role: "status" });

  async function render(): Promise<void> {
    const t = getT();
    const S = t.m.share;
    const s = await getSettings();
    if (s.sharePassive && !(await hasSearchPermissions())) {
      await updateSettings({ sharePassive: false });
      return; // storage change triggers another render
    }
    const box = h("input", {
      type: "checkbox",
      role: "switch",
      id: "opt-share",
      checked: s.sharePassive,
      onchange: () => {
        if (box.checked) {
          // Called synchronously inside the click so Chrome shows the permission prompt.
          enablePassiveCapture().then(
            (granted) => {
              if (!granted) box.checked = false;
              note.textContent = granted ? S.onThanks : S.denied;
            },
            () => (box.checked = false),
          );
        } else {
          note.textContent = "";
          void disablePassiveCapture();
        }
      },
    });
    replaceChildren(
      container,
      h(
        "div",
        { class: "optin" },
        h("label", { for: "opt-share" }, box, h("span", null, t.f(S.label, { engines: t.m.engines }))),
        h("p", { class: "hint" }, S.hint),
      ),
      note,
    );
  }

  void render();
  onLocalChange(["settings"], () => void render());
}
