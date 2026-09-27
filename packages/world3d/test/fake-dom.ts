// A tiny DOM for the DOM-free test run (no jsdom in the repo): just what start/flow.ts,
// start/hint-chip.ts, ui/bubble.ts and ui/line.ts touch. Elements with attributes, classList,
// dataset, style, children, text, events (bubbling), focus, and querySelector(All) over compound
// selectors (tag, #id, .class, [attr], [attr="v"], :not(...)) joined by the descendant combinator.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener = (e: any) => void;

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: any = null;
  currentTarget: any = null;
  constructor(
    public type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
}

class Target {
  private listeners = new Map<string, Listener[]>();
  parentNode: any = null;
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  dispatchEvent(e: FakeEvent): boolean {
    if (!e.target) e.target = this;
    for (let n: any = this; n; n = n.parentNode ?? (n === fakeDocument.documentElement ? fakeDocument : null)) {
      e.currentTarget = n;
      for (const fn of [...((n as Target).listeners.get(e.type) ?? [])]) fn(e);
      if (e.propagationStopped) break;
      if (n === fakeDocument) break;
    }
    return !e.defaultPrevented;
  }
}

class TextNode {
  parentNode: any = null;
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
}

class ClassList {
  constructor(private el: FakeElement) {}
  private get set() {
    return new Set(this.el.className.split(/\s+/).filter(Boolean));
  }
  private write(s: Set<string>) {
    this.el.className = [...s].join(" ");
  }
  add(...c: string[]) {
    const s = this.set;
    c.forEach((x) => s.add(x));
    this.write(s);
  }
  remove(...c: string[]) {
    const s = this.set;
    c.forEach((x) => s.delete(x));
    this.write(s);
  }
  toggle(c: string, force?: boolean) {
    const on = force ?? !this.set.has(c);
    if (on) this.add(c);
    else this.remove(c);
    return on;
  }
  contains(c: string) {
    return this.set.has(c);
  }
}

export class FakeElement extends Target {
  readonly tagName: string;
  className = "";
  attributes = new Map<string, string>();
  childNodes: (FakeElement | TextNode)[] = [];
  style: Record<string, string> & { setProperty?: (k: string, v: string) => void } = {};
  dataset: Record<string, string> = {};
  classList = new ClassList(this);
  innerHTMLValue = "";
  value = "";
  disabled = false;
  type = "";
  tabIndex = 0;
  title = "";
  src = "";
  onload: (() => void) | null = null;
  offsetWidth = 0;
  offsetHeight = 0;
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get id() {
    return this.attributes.get("id") ?? "";
  }
  set id(v: string) {
    this.attributes.set("id", v);
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  setAttribute(k: string, v: string) {
    if (k === "class") this.className = String(v);
    else if (k === "id") this.id = String(v);
    else if (k.startsWith("data-")) {
      this.attributes.set(k, String(v));
      this.dataset[k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = String(v);
    } else if (k === "disabled") this.disabled = true;
    else if (k === "type") this.type = String(v);
    else this.attributes.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    if (k === "class") return this.className || null;
    if (k.startsWith("data-")) {
      const d = this.dataset[k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())];
      return d ?? null;
    }
    if (k === "type") return this.type || null;
    return this.attributes.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.getAttribute(k) !== null || (k === "disabled" && this.disabled);
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
  }
  private adopt(kids: (FakeElement | TextNode | string)[]) {
    return kids.map((k) => {
      const n = typeof k === "string" ? new TextNode(k) : k;
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      return n;
    });
  }
  append(...kids: (FakeElement | TextNode | string)[]) {
    this.childNodes.push(...this.adopt(kids));
  }
  prepend(...kids: (FakeElement | TextNode | string)[]) {
    this.childNodes.unshift(...this.adopt(kids));
  }
  replaceChildren(...kids: (FakeElement | TextNode | string)[]) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...kids);
  }
  removeChild(n: FakeElement | TextNode) {
    this.childNodes = this.childNodes.filter((c) => c !== n);
    n.parentNode = null;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  replaceWith(n: FakeElement) {
    const p = this.parentNode as FakeElement | null;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = p;
    p.childNodes.splice(i, 1, n);
    this.parentNode = null;
  }
  contains(n: any): boolean {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.replaceChildren(...(v ? [String(v)] : []));
  }
  get innerHTML() {
    return this.innerHTMLValue;
  }
  set innerHTML(v: string) {
    this.replaceChildren();
    this.innerHTMLValue = v;
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent("click"));
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  /** every element under this one, depth first */
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  matches(sel: string): boolean {
    return sel.split(",").some((a) => matchSelector(this, a.trim()));
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.descendants().filter((d) => d.matches(sel));
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  closest(sel: string): FakeElement | null {
    for (let x: any = this; x instanceof FakeElement; x = x.parentNode) if (x.matches(sel)) return x;
    return null;
  }
}

/** Compounds joined by spaces (descendant combinator): the last matches `el`, the others its ancestors in order. */
function matchSelector(el: FakeElement, sel: string): boolean {
  const parts = sel.split(/\s+/).filter(Boolean);
  if (!matchCompound(el, parts.at(-1)!)) return false;
  let at: any = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (at instanceof FakeElement && !matchCompound(at, parts[i])) at = at.parentNode;
    if (!(at instanceof FakeElement)) return false;
    at = at.parentNode;
  }
  return true;
}

/** tag, #id, .class, [attr], [attr="v"], :not(<compound>) */
function matchCompound(el: FakeElement, sel: string): boolean {
  let rest = sel;
  const nots: string[] = [];
  rest = rest.replace(/:not\(([^()]*)\)/g, (_, inner: string) => {
    nots.push(inner);
    return "";
  });
  if (nots.some((n) => matchCompound(el, n))) return false;
  const attrs: [string, string | null][] = [];
  rest = rest.replace(/\[([\w-]+)(?:="([^"]*)")?\]/g, (_, k: string, v: string | undefined) => {
    attrs.push([k, v ?? null]);
    return "";
  });
  for (const [k, v] of attrs) {
    const got = el.getAttribute(k);
    if (got === null) return false;
    if (v !== null && got !== v) return false;
  }
  const m = rest.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (!m) throw new Error(`fake-dom: unsupported selector "${sel}"`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === "." && !el.classList.contains(part.slice(1))) return false;
    if (part[0] === "#" && el.id !== part.slice(1)) return false;
  }
  return true;
}

class FakeDocument extends Target {
  documentElement = new FakeElement("html");
  body = new FakeElement("body");
  activeElement: FakeElement | null = null;
  constructor() {
    super();
    this.documentElement.append(this.body);
  }
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  createTextNode(s: string) {
    return new TextNode(s);
  }
  querySelector(sel: string) {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel: string) {
    return this.documentElement.querySelectorAll(sel);
  }
}

export let fakeDocument = new FakeDocument();

/** Installs a fresh fake document (and CustomEvent, HTMLInputElement) on globalThis; returns it. */
export function installFakeDom(): FakeDocument {
  fakeDocument = new FakeDocument();
  const g = globalThis as any;
  g.document = fakeDocument;
  g.CustomEvent = class extends FakeEvent {
    detail: unknown;
    constructor(type: string, init: { detail?: unknown } = {}) {
      super(type);
      this.detail = init.detail;
    }
  };
  g.HTMLInputElement = class {
    static [Symbol.hasInstance](x: unknown) {
      return x instanceof FakeElement && x.tagName === "INPUT";
    }
  };
  g.HTMLElement = FakeElement;
  return fakeDocument;
}

/** Fires an event of `type` at `el` (bubbling); `init` becomes its fields (key, clientX, ...). */
export function fire(el: FakeElement | FakeDocument, type: string, init: Record<string, unknown> = {}) {
  return el.dispatchEvent(new FakeEvent(type, init));
}

/** Types into an input: sets its value and fires `input`. */
export function type(input: FakeElement, text: string) {
  input.value = text;
  fire(input, "input");
}
