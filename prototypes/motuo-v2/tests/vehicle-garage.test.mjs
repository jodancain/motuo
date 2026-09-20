import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the production garage controller, replacing only its dynamic WebGL
// module import. These are state/lifecycle contracts, not GPU or model fidelity tests.
const source = readFileSync(new URL('../vehicle-garage.js', import.meta.url), 'utf8');
const imported = "await import('./vehicle-viewer.js')";
assert.equal(source.split(imported).length, 2, 'inject exactly the viewer module boundary');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const copy = value => JSON.parse(JSON.stringify(value));

function harness({ stored = null, storageDenied = false, delayedImport = false } = {}) {
  const nodes = new Map(), elements = [], writes = [], viewers = [], imports = [];
  const node = (id, dataset = {}, tagName = 'BUTTON') => {
    const listeners = new Map();
    const el = {
      id, dataset, tagName, attrs: {}, children: [], style: { setProperty() {} },
      value: '', textContent: '', hidden: false, disabled: false,
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, handler) { listeners.set(name, handler); },
      dispatch(name) { return listeners.get(name)?.({ target: this }); },
      appendChild(child) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(value => value !== child);
        this.children.push(child); child.parentNode = this;
      },
    };
    nodes.set(id, el); elements.push(el); return el;
  };
  for (const id of ['paint-save-state', 'paint-name', 'body-color', 'accent-color', 'vehicle-auto',
    'garage-showroom', 'vehicle-reset', 'garage-vehicle-host', 'cockpit-vehicle-host']) node(id);
  const paint = node('paint-violet', { paint: 'violet', vehicleControl: '' });
  const finish = node('finish-satin', { finish: 'satin', vehicleControl: '' });
  const retry = node('retry', { vehicleRetry: '' });
  node('status', { vehicleStatus: '' }, 'SPAN');
  node('loading', { loading: '' }, 'DIV');
  const doc = {
    hidden: false, documentElement: { dataset: {} },
    getElementById: id => nodes.get(id),
    querySelectorAll(selector) {
      if (selector === '.vehicle-loading') return [nodes.get('loading')];
      const match = selector.match(/^(button)?\[data-([a-z-]+)\]$/);
      assert.ok(match, `unsupported selector ${selector}`);
      const key = match[2].replace(/-([a-z])/g, (_, value) => value.toUpperCase());
      return elements.filter(el => (!match[1] || el.tagName === 'BUTTON') && key in el.dataset);
    },
  };
  const module = { createVehicleViewer({ host, onStatus }) {
    let resolve, reject;
    const canvas = node(`canvas-${viewers.length}`, { finish: 'gloss' }, 'CANVAS');
    const viewer = {
      canvas, calls: [], disposed: false,
      ready: new Promise((yes, no) => { resolve = yes; reject = no; }),
      mount(next) { this.calls.push(['mount', next]); next.appendChild(canvas); },
      setAppearance(value) { this.appearance = copy(value); },
      setAutoRotate(value) { this.autoRotate = value; },
      setInteractive(value) { this.interactive = value; },
      setActive(value) { this.active = value; },
      setView() {}, zoom() {}, resetView() {},
      dispose() { this.disposed = true; },
      report: onStatus,
      succeed() { onStatus({ status: 'ready' }); resolve(); },
      fail() { onStatus({ status: 'error' }); reject(new Error('model failure')); },
    };
    viewer.mount(host); viewers.push(viewer); return viewer;
  } };
  const context = {
    window: { localStorage: {
      getItem() { if (storageDenied) throw new Error('blocked'); return stored; },
      setItem(key, value) { if (storageDenied) throw new Error('blocked'); writes.push({ key, value: JSON.parse(value) }); },
    } },
    loadViewerModule: () => delayedImport ? new Promise(resolve => imports.push(() => resolve(module))) : Promise.resolve(module),
  };
  vm.runInNewContext(source.replace(imported, 'await loadViewerModule()'), context);
  const api = context.window.MotuoGarage;
  return { api, create: () => api.create(doc), doc, nodes, viewers, imports, writes, paint, finish, retry };
}

test('appearance persistence accepts only versioned colors and supported finish; drops unrelated data', () => {
  const { api } = harness();
  const defaults = copy(api.normalizeAppearance(null));
  assert.deepEqual(copy(api.normalizeAppearance({ version: 2, bodyColor: '#111111' })), defaults);
  assert.deepEqual(copy(api.normalizeAppearance({ version: 1, bodyColor: '#ABCDEF', accentColor: 'url(secret)',
    finish: 'satin', autoRotate: false, gear: 6, token: 'discard' })), {
    ...defaults, bodyColor: '#abcdef', finish: 'satin', autoRotate: false,
  });
});

test('saved appearance loads, paint changes persist, and diagnostic canvas attributes never become controls', async () => {
  const h = harness({ stored: JSON.stringify({ version: 1, bodyColor: '#123456', autoRotate: false }) });
  const garage = h.create(); await flush();
  const viewer = h.viewers[0]; viewer.succeed(); await flush();
  assert.equal(garage.getViewer(), viewer);
  assert.equal(viewer.appearance.bodyColor, '#123456');
  assert.equal(viewer.autoRotate, false);
  h.paint.dispatch('click'); h.finish.dispatch('click');
  assert.equal(viewer.appearance.bodyColor, '#7854ba');
  assert.equal(viewer.appearance.finish, 'satin');
  assert.equal(h.writes.at(-1).key, 'motuo.vehicle-appearance.v1');
  assert.equal('name' in h.writes.at(-1).value, false);
  assert.equal('aria-pressed' in viewer.canvas.attrs, false, 'canvas data-finish is readback, not a paint button');
  viewer.canvas.dispatch('pointerdown');
  assert.equal(h.writes.at(-1).value.autoRotate, false);
  garage.dispose();
});

test('blocked storage preserves usable local controls and does not break model initialization', async () => {
  const h = harness({ storageDenied: true }), garage = h.create(); await flush();
  const viewer = h.viewers[0]; viewer.succeed(); await flush();
  h.paint.dispatch('click');
  assert.equal(viewer.appearance.bodyColor, '#7854ba');
  assert.match(h.nodes.get('paint-save-state').textContent, /未允许保存/);
  assert.equal(garage.getViewer(), viewer);
  garage.dispose();
});

test('one viewer follows page/activity state, yields ownership during departure, and respects reduced motion', async () => {
  const h = harness(), garage = h.create(); await flush();
  const viewer = h.viewers[0]; viewer.succeed(); await flush();
  const cockpit = h.nodes.get('cockpit-vehicle-host'), showroom = h.nodes.get('garage-vehicle-host');
  assert.equal(viewer.canvas.parentNode, cockpit);
  assert.equal(viewer.active, true);
  garage.update({ page: 'garage', parked: false, reduced: true });
  assert.equal(viewer.canvas.parentNode, showroom);
  assert.equal(viewer.interactive, true);
  assert.equal(viewer.autoRotate, false);
  assert.equal(h.nodes.get('vehicle-auto').attrs['aria-pressed'], 'true', 'reduced motion retains user preference');
  const calls = viewer.calls.length;
  garage.update({ departing: true, page: 'cockpit', active: false });
  assert.equal(viewer.calls.length, calls, 'garage cannot steal a canvas owned by departure');
  garage.update({ departing: false });
  assert.equal(viewer.canvas.parentNode, cockpit);
  assert.equal(viewer.active, false);
  assert.equal(viewer.interactive, false);
  garage.update({ page: 'garage', active: true, reduced: false });
  assert.equal(viewer.active, true);
  assert.equal(viewer.autoRotate, true);
  assert.equal(h.viewers.length, 1);
  garage.dispose();
});

test('retry retires an old viewer; stale failure cannot erase a newer ready viewer', async () => {
  const h = harness(), garage = h.create(); await flush();
  const old = h.viewers[0];
  h.retry.dispatch('click'); await flush();
  const current = h.viewers[1];
  assert.equal(old.disposed, true);
  current.succeed(); await flush(); old.fail(); await flush();
  assert.equal(h.doc.documentElement.dataset.vehicleState, 'ready');
  assert.equal(garage.getViewer(), current);
  assert.equal(h.retry.hidden, true);
  garage.dispose(); assert.equal(current.disposed, true);
});

test('disposal while the viewer module is loading prevents late renderer creation', async () => {
  const h = harness({ delayedImport: true }), garage = h.create();
  garage.dispose(); h.imports[0](); await flush();
  assert.equal(h.viewers.length, 0);
  assert.equal(garage.getViewer(), null);
});
