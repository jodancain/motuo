// Minimal DOM double for motion lifecycle contracts. It records animations and
// geometry; it is not a layout or compositing engine.
const noopContext = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => 1 : noopContext, set: () => true, apply: () => noopContext });
export function createDom() {
  const animations = [];
  const registry = new Map();
  const all = new Set();
  function makeNode(name, rect = { left: 0, top: 0, width: 100, height: 50 }) {
    const classes = new Set();
    const node = {
      name, rect, style: { setProperty(k, v) { this[k] = v; } }, dataset: {}, attributes: {}, children: [], parentNode: null, hidden: false, removed: false, _text: '',
      classList: {
        contains: v => classes.has(v),
        add: (...v) => v.forEach(x => classes.add(x)),
        remove: (...v) => v.forEach(x => classes.delete(x)),
        toggle: (v, force) => { const on = force === undefined ? !classes.has(v) : !!force; if (on) classes.add(v); else classes.delete(v); return on; },
      },
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => classes.add(x)); },
      get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; },
      set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); },
      get firstChild() { return this.children[0] || (this._text ? { text: this._text } : null); },
      getBoundingClientRect: () => ({ ...node.rect }),
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      removeAttribute(k) { delete this.attributes[k]; },
      append(...kids) { for (const kid of kids) { kid.parentNode?.children && (kid.parentNode.children = kid.parentNode.children.filter(c => c !== kid)); this.children.push(kid); kid.parentNode = this; kid.removed = false; } },
      appendChild(kid) { this.append(kid); return kid; },
      replaceChildren(...kids) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = ''; this.append(...kids); },
      remove() { this.removed = true; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; },
      descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); },
      querySelectorAll(selector) {
        if (/^\.[\w-]+$/.test(selector)) return this.descendants().filter(n => n.classList.contains(selector.slice(1)));
        const hit = registry.get(selector); return hit ? [].concat(hit) : [];
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      closest(selector) { let n = this; while (n) { if (selector === '#' + n.id) return n; n = n.parentNode; } return null; },
      // Any 2D/WebGL call is a recorded no-op; this double does not rasterize.
      getContext: () => noopContext,
      animate(frames, options) {
        let resolve, reject;
        const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
        const animation = { node, frames, options, finished, cancels: 0, done: false,
          finish() { if (!this.done) { this.done = true; resolve(); } },
          cancel() { this.cancels++; if (!this.done) { this.done = true; reject(new Error('cancelled')); } } };
        animations.push(animation);
        return animation;
      },
    };
    all.add(node);
    return node;
  }
  const doc = {
    body: makeNode('body'),
    createElement(tag) { return makeNode(tag); },
    querySelector(selector) { const hit = registry.get(selector); return hit ? [].concat(hit)[0] : null; },
    querySelectorAll(selector) { const hit = registry.get(selector); return hit ? [].concat(hit) : []; },
  };
  function add(selector, rect, parent = null) {
    const node = makeNode(selector, rect);
    if (selector.startsWith('#')) node.id = selector.slice(1);
    if (/^\.[\w-]+$/.test(selector)) node.classList.add(selector.slice(1));
    registry.set(selector, node);
    if (parent) parent.append(node);
    return node;
  }
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const live = () => animations.filter(a => !a.done);
  const finishAll = async () => { for (const a of live()) a.finish(); await flush(); };
  return { doc, add, registry, animations, live, finishAll, flush, makeNode };
}

export function fakeClock() {
  let time = 0, next = 1;
  const queue = new Map();
  return {
    raf: fn => { const id = next++; queue.set(id, fn); return id; },
    caf: id => queue.delete(id),
    now: () => time,
    hidden: () => false,
    pending: () => queue.size,
    step(ms = 1000 / 60) { time += ms; const due = [...queue.values()]; queue.clear(); due.forEach(fn => fn(time)); },
    run(ms, frame = 1000 / 60) { for (let t = 0; t < ms; t += frame) this.step(frame); },
  };
}
