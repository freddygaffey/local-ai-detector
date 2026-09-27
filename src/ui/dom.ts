// Tiny vanilla-DOM helper. Not a framework: one function that saves the
// createElement/setAttribute/appendChild boilerplate the popup and options
// pages would otherwise repeat everywhere.

type Child = Node | string | null | undefined | false;

/**
 * `h("button", { class: "btn", onclick: fn }, "Analyze page")`. Attribute
 * keys starting with "on" (lowercase, e.g. `onclick`) are wired as event
 * listeners instead of attributes; `class`/`className` and `dataset.*`-style
 * `data-x` keys are handled normally as attributes.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, unknown> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el: HTMLElement, attrs?: Record<string, unknown> | null): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class" || key === "className") {
      el.className = String(value);
    } else if (typeof value === "boolean") {
      if (value) el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
}

export function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function text(value: string): Text {
  return document.createTextNode(value);
}
