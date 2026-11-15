// Minimal DOM helpers. Text is always set via textContent (never innerHTML).
type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "class") {
        el.className = String(v);
      } else if (k === "checked" || k === "disabled" || k === "value" || k === "selected" || k === "hidden") {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: (Child | Child[])[]): void {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function replaceChildren(el: Element, ...children: (Child | Child[])[]): void {
  el.replaceChildren();
  append(el, children);
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

export function fmtTime(ts: number, lang?: string): string {
  return new Date(ts).toLocaleTimeString(lang ? [lang] : [], { hour: "2-digit", minute: "2-digit" });
}

export function fmtDateTime(ts: number | string, lang?: string): string {
  return new Date(ts).toLocaleString(lang ? [lang] : [], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtDate(ts: number | string, lang?: string): string {
  return new Date(ts).toLocaleDateString(lang ? [lang] : [], { year: "numeric", month: "short", day: "numeric" });
}
