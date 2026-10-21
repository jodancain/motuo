import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Departure with the shared motion kit present (as on the page). Choreography and
// lifecycle contracts only; visual quality is checked in the browser.
function load() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../motion-kit.js', import.meta.url), 'utf8'), sandbox);
  vm.runInContext(readFileSync(new URL('../departure-transition.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.MotuoDeparture;
}
const Departure = load();
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(options = {}) {
  const animations = [], nodes = new Map();
  const makeNode = (name, rect = { left: 0, top: 0, width: 100, height: 50 }) => {
    const classes = new Set();
    const node = {
      name, rect, style: {}, children: [], hidden: false, removed: false, attributes: {},
      classList: { contains: v => classes.has(v), add: (...v) => v.forEach(x => classes.add(x)), remove: (...v) => v.forEach(x => classes.delete(x)) },
      getBoundingClientRect: () => ({ ...node.rect }),
      setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; },
      addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; },
      appendChild(child) { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(c => c !== child); this.children.push(child); child.parentNode = this; child.removed = false; return child; },
      append(child) { this.appendChild(child); },
      remove() { this.removed = true; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; },
      animate(frames, opts) {
        let resolve, reject;
        const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
        const animation = { node, frames, options: opts, finished, cancels: 0, finish: () => resolve(), cancel() { this.cancels++; reject(new Error('cancelled')); } };
        animations.push(animation); return animation;
      },
    };
    node.className = '';
    Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set: v => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => classes.add(x)); } });
    return node;
  };
  for (const name of ['#app', '#cockpit', '#speed-flight', '#speed', '.vehicle-render img', '#sound-trend-open', '#accel-meter', '.music', '.page-head', '.bottom', '.vehicle-title', '#fx-canvas', '.vehicle-floor', '.vehicle-orbit', '#energy-arc', '#game-world', '.speed-digits'])
    nodes.set(name, makeNode(name));
  nodes.get('#cockpit').rect = { left: 0, top: 0, width: 800, height: 400 };
  nodes.get('#speed').rect = { left: 350, top: 120, width: 100, height: 90 };
  nodes.get('#energy-arc').style.strokeDashoffset = '410';
  const body = makeNode('body');
  const doc = { body, querySelector: s => nodes.get(s) || null, createElement: tag => makeNode(tag) };
  nodes.get('#cockpit').classList.add('vehicle-rest');
  Object.assign(nodes.get('.vehicle-render img'), { complete: true, naturalWidth: 600, naturalHeight: 300, currentSrc: 'assets/panda.png', rect: { left: 10, top: 20, width: 300, height: 300 } });
  return { controller: Departure.create(doc, options), nodes, body, animations, cockpit: nodes.get('#cockpit') };
}
const end = a => (a.options.delay || 0) + a.options.duration;
const lightLayers = h => h.cockpit.children.filter(n => /departure-(sweep|ring)/.test(n.className));

test('with the motion kit every departure layer finishes within 1.6 s; the 3D wheel spin keeps its length', () => {
  const h = harness();
  h.controller.play(h.controller.capture());
  assert.ok(h.animations.length >= 10);
  for (const a of h.animations) assert.ok(end(a) <= Departure.maxTotal, `${a.node.name} ends at ${end(a)}`);
  assert.equal(Departure.maxTotal, 1600);
  assert.equal(Departure.duration, 1150);
  h.controller.cancel();
});

test('shared surfaces keep full opacity throughout (no second fade-in) and stagger within 200 ms', () => {
  const h = harness();
  h.controller.play(h.controller.capture());
  const surfaces = ['#sound-trend-open', '#accel-meter', '.music', '.page-head', '.bottom'].map(s => h.animations.find(a => a.node === h.nodes.get(s)));
  for (const a of surfaces) {
    assert.ok(a, 'every measured surface flies');
    assert.ok(a.frames.every(f => f.opacity === 1), `${a.node.name} never dims`);
    assert.ok((a.options.delay || 0) <= 200);
    assert.equal(a.options.fill, 'both', 'held at the old bounds while waiting: nothing jumps');
  }
  assert.ok(new Set(surfaces.map(a => a.options.delay)).size > 1, 'staggered, not simultaneous');
  const camera = h.animations.find(a => a.node === h.nodes.get('#fx-canvas'));
  assert.equal(camera.frames[0].scale, '1.12');
  assert.equal(camera.frames.at(-1).scale, '1');
  const arc = h.animations.find(a => a.node === h.nodes.get('#energy-arc'));
  assert.deepEqual([arc.frames[0].strokeDashoffset, arc.frames[1].strokeDashoffset], ['970', '410'], 'arc draws on to its current rendered value');
  h.controller.cancel();
});

test('light layers live in the cockpit, are aria-hidden, centre on the speed, and never stack', () => {
  const h = harness(), snapshot = h.controller.capture();
  h.controller.play(snapshot);
  h.controller.play(snapshot);
  const layers = lightLayers(h);
  assert.deepEqual(layers.map(n => n.className).sort(), ['departure-ring', 'departure-sweep']);
  assert.ok(layers.every(n => n.attributes['aria-hidden'] === 'true'));
  assert.equal(h.body.children.length, 1, 'only the vehicle ghost lives in body');
  const ring = layers.find(n => n.className === 'departure-ring');
  const size = parseFloat(ring.style.width);
  assert.equal(parseFloat(ring.style.left) + size / 2, 400);
  assert.equal(parseFloat(ring.style.top) + size / 2, 165);
  h.controller.cancel();
});

test('natural completion and cancel both remove light layers before onSettled', async () => {
  let settled = 0, h;
  h = harness({ onSettled() { settled++; assert.equal(lightLayers(h).length, 0); assert.equal(h.cockpit.classList.contains('departing'), false); } });
  const snapshot = h.controller.capture();
  h.controller.play(snapshot);
  h.animations.forEach(a => a.finish());
  await flush();
  assert.equal(settled, 1);
  h.controller.play(snapshot);
  assert.equal(lightLayers(h).length, 2);
  h.controller.cancel(); h.controller.cancel();
  await flush();
  assert.equal(settled, 2);
  assert.equal(lightLayers(h).length, 0);
  assert.equal(h.body.children.length, 0);
});

test('reduced motion and pause-style cancellation leave no temporary layer', async () => {
  const h = harness(), snapshot = h.controller.capture();
  h.controller.play(snapshot, { reduced: true });
  assert.equal(lightLayers(h).length, 0);
  assert.equal(h.animations.length, 0);
  h.controller.play(snapshot);
  h.controller.play(snapshot, { reduced: true });     // e.g. user enables reduced motion mid-flight
  await flush();
  assert.equal(lightLayers(h).length, 0);
  assert.equal(h.body.children.length, 0);
  assert.ok(h.animations.every(a => a.cancels === 1));
});

// Cinematic mode (standard / extreme intensity).
const cineLayers = h => [...h.body.children, ...h.cockpit.children].filter(n => /cine-|departure-vehicle/.test(n.className));
test('cinematic departure runs 2–3 s, keeps the speed visible, and spends at most two flashes', () => {
  let flashes = 0;
  const h = harness({ allowFlash: () => (++flashes, true) });
  h.controller.play(h.controller.capture(), { cinematic: true });
  const ends = h.animations.map(end);
  assert.ok(Math.max(...ends) >= 2000 && Math.max(...ends) <= Departure.cinematic.total, `ends at ${Math.max(...ends)}`);
  assert.ok(flashes <= 2, 'headlight + impact only');
  const speed = h.animations.find(a => a.node === h.nodes.get('#speed-flight'));
  assert.ok(speed.frames.every(f => f.opacity === undefined || f.opacity === 1), 'the reading never fades');
  assert.ok(h.cockpit.classList.contains('cine'), 'cockpit (with the speed) is raised above the black backdrop and the bike');
  assert.ok(h.body.children.some(n => n.className === 'cine-skip'), 'skip control');
  assert.equal(h.controller.active, true);
  h.controller.cancel();
});

test('skip jumps to the end and cleans every cinematic layer before onSettled', async () => {
  let settled = 0, h;
  h = harness({ onSettled() { settled++; assert.equal(cineLayers(h).length, 0); assert.equal(h.cockpit.classList.contains('cine'), false); } });
  h.controller.play(h.controller.capture(), { cinematic: true });
  assert.ok(cineLayers(h).length >= 4);
  h.controller.skip();
  await flush();
  assert.equal(settled, 1);
  assert.equal(h.controller.active, false);
  assert.equal(h.nodes.get('#app').classList.contains('cine-active'), false);
});

test('cinematic: cancel (pause / rotate / background) and reduced motion leave nothing behind', async () => {
  const h = harness(), snapshot = h.controller.capture();
  h.controller.play(snapshot, { cinematic: true });
  h.controller.cancel();
  await flush();
  assert.equal(cineLayers(h).length, 0);
  assert.equal(h.cockpit.classList.contains('cine-hold'), false);
  h.controller.play(snapshot, { cinematic: true, reduced: true });
  assert.equal(cineLayers(h).length, 0);
  const none = harness({ allowFlash: () => false });
  none.controller.play(none.controller.capture(), { cinematic: true });
  assert.equal([...none.body.children].flatMap(n => n.children).filter(n => /cine-(white|flare)/.test(n.className)).length, 0, 'no flash budget: no flash layers');
  none.controller.cancel();
});
