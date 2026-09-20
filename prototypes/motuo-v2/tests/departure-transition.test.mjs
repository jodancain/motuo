import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Production controller with controllable DOM geometry and Animation promises.
// This checks choreography contracts, not browser compositing or visual quality.
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../departure-transition.js', import.meta.url), 'utf8'), sandbox);
const create = sandbox.window.MotuoDeparture.create;
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(options) {
  const animations = [], created = [], nodes = new Map();
  const makeNode = (name, rect = { left: 0, top: 0, width: 100, height: 50 }) => {
    const classes = new Set();
    const node = {
      name, rect, style: {}, children: [], hidden: false, removed: false,
      classList: {
        contains: value => classes.has(value),
        add: (...values) => values.forEach(value => classes.add(value)),
        remove: (...values) => values.forEach(value => classes.delete(value)),
      },
      getBoundingClientRect: () => ({ ...node.rect }),
      setAttribute(name, value) { this[name] = value; },
      appendChild(child) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(value => value !== child);
        this.children.push(child); child.parentNode = this; child.removed = false;
        return child;
      },
      append(child) { this.appendChild(child); },
      remove() {
        this.removed = true;
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
      },
      animate(frames, options) {
        let resolve, reject;
        const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
        const animation = {
          node, frames, options, finished, cancels: 0,
          finish: () => resolve(),
          cancel() { this.cancels++; reject(new Error('Animation canceled')); },
        };
        animations.push(animation);
        return animation;
      },
    };
    return node;
  };
  for (const name of ['#app', '#cockpit', '#speed-flight', '#speed', '.vehicle-render img',
    '#sound-trend-open', '#accel-meter', '.music', '.page-head', '.bottom', '.vehicle-title',
    '#fx-canvas', '.vehicle-floor', '.vehicle-orbit']) nodes.set(name, makeNode(name));
  const body = makeNode('body');
  const doc = {
    body, querySelector: selector => nodes.get(selector) || null,
    createElement(name) { const node = makeNode(name); created.push(node); return node; },
  };
  nodes.get('#cockpit').classList.add('vehicle-rest');
  Object.assign(nodes.get('.vehicle-render img'), {
    complete: true, naturalWidth: 600, naturalHeight: 300,
    currentSrc: 'assets/panda.png', src: 'assets/old.png',
    rect: { left: 10, top: 20, width: 300, height: 300 },
  });
  return { controller: create(doc, options), nodes, body, animations, created, makeNode };
}

function liveHarness(onSettled = () => {}) {
  let viewer;
  const h = harness({ getVehicle: () => viewer, onSettled });
  const host = h.makeNode('cockpit-host');
  const canvas = h.makeNode('canvas', { left: 140, top: 65, width: 410, height: 230 });
  // Cloning or snapshotting a WebGL canvas loses its live renderer. Fail on either.
  canvas.cloneNode = canvas.toDataURL = () => assert.fail('Departure must transfer the original live canvas');
  host.appendChild(canvas);
  const calls = [];
  viewer = {
    canvas,
    mount(nextHost) { calls.push(['mount', nextHost]); nextHost.appendChild(canvas); },
    setInteractive(value) { calls.push(['interactive', value]); },
    startDeparture(duration) { calls.push(['start', duration]); },
    stopDeparture() { calls.push(['stop']); },
  };
  return Object.assign(h, { host, canvas, calls, viewer });
}

test('capture measures the old layout without starting effects; FLIP begins at those bounds', () => {
  const h = harness(), surface = h.nodes.get('#sound-trend-open');
  surface.rect = { left: 20, top: 40, width: 100, height: 50 };
  h.nodes.get('#speed').rect = { left: 420, top: 40, width: 30, height: 36 };
  const before = h.controller.capture();
  assert.equal(h.animations.length, 0);
  assert.equal(h.created.length, 0);
  surface.rect = { left: 120, top: 90, width: 200, height: 100 };
  h.nodes.get('#speed').rect = { left: 160, top: 100, width: 60, height: 72 };
  h.nodes.get('#speed-flight').rect = { left: 0, top: 0, width: 500, height: 250 };
  h.controller.play(before);
  const animation = h.animations.find(animation => animation.node === surface);
  const numbers = animation.frames[0].transform.match(/translate\(([-.\d]+)px,([-.\d]+)px\) scale\(([-.\d]+),([-.\d]+)\)/);
  assert.ok(numbers, 'FLIP has a translation and scale from the measured layout');
  const [, dx, dy, sx, sy] = numbers.map(Number);
  closeTo(surface.rect.left + dx, 20);
  closeTo(surface.rect.top + dy, 40);
  closeTo(surface.rect.width * sx, 100);
  closeTo(surface.rect.height * sy, 50);
  const speedAnimation = h.animations.find(animation => animation.node === h.nodes.get('#speed-flight'));
  const speedTransform = speedAnimation.frames[0].transform.match(/translate\(([-.\d]+)px,([-.\d]+)px\) scale\(([-.\d]+)\)/);
  assert.ok(speedTransform, 'speed retains a uniform scale');
  const [, speedX, speedY, scale] = speedTransform.map(Number);
  closeTo(190 * scale + speedX, 435);
  closeTo(136 * scale + speedY, 58);
  closeTo(72 * scale, 36);
  h.controller.cancel();
});

test('an image with no decoded intrinsic size does not produce a distorted placeholder ghost', () => {
  for (const imageState of [{ complete: false }, { naturalWidth: 0 }, { naturalHeight: 0 }]) {
    const h = harness();
    Object.assign(h.nodes.get('.vehicle-render img'), imageState);
    const snapshot = h.controller.capture();
    assert.equal(snapshot.bike, null);
    h.controller.play(snapshot);
    assert.equal(h.body.children.length, 0);
    assert.ok(h.animations.some(animation => animation.node === h.nodes.get('#speed-flight')));
    h.controller.cancel();
  }
});

test('the ghost uses the contained image bounds and preserves aspect ratio through departure', () => {
  const h = harness(), snapshot = h.controller.capture();
  // A 2:1 photo in a square element has vertical letterboxing, not a square bike.
  closeTo(snapshot.bike.left, 10); closeTo(snapshot.bike.top, 95);
  closeTo(snapshot.bike.width, 300); closeTo(snapshot.bike.height, 150);
  h.nodes.get('.vehicle-render img').rect = { left: 100, top: 0, width: 200, height: 500 };
  h.controller.play(snapshot);
  const ghost = h.body.children[0];
  closeTo(parseFloat(ghost.style.left), 10); closeTo(parseFloat(ghost.style.top), 95);
  closeTo(parseFloat(ghost.style.width) / parseFloat(ghost.style.height), 2);
  assert.equal(ghost.children[0].src, 'assets/panda.png');
  const animation = h.animations.find(animation => animation.node === ghost);
  for (const frame of animation.frames) {
    assert.match(frame.transform, /scale\([\d.]+\)/, 'vehicle scaling remains uniform');
    assert.doesNotMatch(frame.transform, /scale\([^)]*,/);
  }
  h.controller.cancel();
});

test('cancel releases every animation and ghost and is safe to repeat', async () => {
  const h = harness();
  h.controller.play(h.controller.capture());
  const ghost = h.body.children[0], animations = [...h.animations];
  assert.equal(h.nodes.get('#cockpit').classList.contains('departing'), true);
  h.controller.cancel(); h.controller.cancel();
  await flush();
  assert.equal(ghost.removed, true);
  assert.equal(h.body.children.length, 0);
  assert.equal(h.nodes.get('#cockpit').classList.contains('departing'), false);
  assert.ok(animations.every(animation => animation.cancels === 1));
});

test('late completion of an old run cannot clean up a newer departure', async () => {
  const h = harness(), snapshot = h.controller.capture();
  h.controller.play(snapshot);
  const oldGhost = h.body.children[0], oldAnimations = [...h.animations];
  h.controller.play(snapshot);
  const newGhost = h.body.children[0], newAnimations = h.animations.slice(oldAnimations.length);
  oldAnimations.forEach(animation => animation.finish());
  await flush();
  assert.equal(oldGhost.removed, true);
  assert.equal(newGhost.removed, false);
  assert.equal(h.body.children[0], newGhost);
  assert.equal(h.nodes.get('#cockpit').classList.contains('departing'), true);
  assert.ok(newAnimations.every(animation => animation.cancels === 0));
  newAnimations.forEach(animation => animation.finish());
  await flush();
  assert.equal(newGhost.removed, true);
  assert.equal(h.body.children.length, 0);
  assert.equal(h.nodes.get('#cockpit').classList.contains('departing'), false);
});

test('reduced motion or an unavailable stage skips the choreography and clears prior work', async () => {
  const h = harness(), snapshot = h.controller.capture();
  h.controller.play(snapshot);
  const count = h.animations.length;
  h.controller.play(snapshot, { reduced: true });
  await flush();
  assert.equal(h.animations.length, count);
  assert.equal(h.body.children.length, 0);
  assert.equal(h.nodes.get('#cockpit').classList.contains('departing'), false);
  h.nodes.get('#app').classList.add('reduced-effects');
  assert.equal(h.controller.capture(), null);
  h.nodes.get('#app').classList.remove('reduced-effects');
  h.nodes.get('#cockpit').hidden = true;
  assert.equal(h.controller.capture(), null);
});

test('onSettled runs once after resources are cleared, for cancel and natural completion', async () => {
  let settled = 0, h;
  h = harness({ onSettled() {
    settled++;
    assert.equal(h.body.children.length, 0);
    assert.equal(h.nodes.get('#cockpit').classList.contains('departing'), false);
  } });
  const snapshot = h.controller.capture();
  assert.equal(settled, 0);
  h.controller.play(snapshot);
  h.controller.cancel(); h.controller.cancel();
  await flush();
  assert.equal(settled, 1);
  const firstRunCount = h.animations.length;
  h.controller.play(snapshot);
  h.animations.slice(firstRunCount).forEach(animation => animation.finish());
  await flush();
  assert.equal(settled, 2);
  h.controller.capture(); h.controller.cancel();
  assert.equal(settled, 2);
});

test('live departure reparents the original canvas and restores it before completion reconciliation', async () => {
  let h, settled = 0;
  h = liveHarness(() => {
    settled++;
    assert.equal(h.canvas.parentNode, h.host, 'restoration precedes onSettled');
    assert.equal(h.body.children.length, 0);
    assert.equal(h.nodes.get('#cockpit').classList.contains('departing'), false);
  });
  const snapshot = h.controller.capture();
  assert.equal(snapshot.live.viewer, h.viewer);
  assert.equal(snapshot.live.host, h.host);
  assert.equal(h.canvas.parentNode, h.host, 'capture only measures');
  h.controller.play(snapshot);
  const ghost = h.body.children[0];
  assert.deepEqual(ghost.children, [h.canvas]);
  assert.equal(h.host.children.length, 0);
  assert.equal(h.created.some(node => node.name === 'img' || node.name === 'canvas'), false);
  assert.equal(ghost.style.width, '410px');
  assert.equal(ghost.style.height, '230px');
  assert.deepEqual(h.calls.map(call => call[0]), ['mount', 'interactive', 'start']);
  assert.equal(h.calls[2][1], 1150);
  h.animations.forEach(animation => animation.finish());
  await flush();
  assert.deepEqual(h.host.children, [h.canvas]);
  assert.equal(settled, 1);
  assert.deepEqual(h.calls.slice(-2).map(call => call[0]), ['stop', 'mount']);
});

test('cancel and switching to reduced motion restore the live canvas exactly once', async () => {
  for (const action of ['cancel', 'reduced']) {
    const h = liveHarness(), snapshot = h.controller.capture();
    h.controller.play(snapshot);
    if (action === 'cancel') h.controller.cancel();
    else h.controller.play(snapshot, { reduced: true });
    h.controller.cancel();
    await flush();
    assert.deepEqual(h.host.children, [h.canvas], action);
    assert.equal(h.canvas.parentNode, h.host);
    assert.equal(h.body.children.length, 0);
    assert.equal(h.calls.filter(call => call[0] === 'stop').length, 1);
    assert.equal(h.calls.filter(call => call[0] === 'start').length, 1);
  }
});

test('restart keeps one live canvas and stale completion cannot remount it out of the active departure', async () => {
  let h;
  const reconciled = [];
  h = liveHarness(() => queueMicrotask(() => {
    // The page uses this same deferred reconciliation so a restarted departure
    // can establish ownership before garage state is synchronized.
    reconciled.push({ departing: h.nodes.get('#cockpit').classList.contains('departing'), parent: h.canvas.parentNode });
  }));
  const snapshot = h.controller.capture();
  h.controller.play(snapshot);
  const old = [...h.animations], firstGhost = h.body.children[0];
  h.controller.play(snapshot);
  const secondGhost = h.body.children[0], current = h.animations.slice(old.length);
  old.forEach(animation => animation.finish());
  await flush();
  assert.equal(firstGhost.removed, true);
  assert.equal(h.canvas.parentNode, secondGhost);
  assert.equal(h.host.children.length, 0);
  assert.deepEqual(secondGhost.children, [h.canvas]);
  assert.equal(h.calls.filter(call => call[0] === 'stop').length, 1);
  assert.deepEqual(reconciled, [{ departing: true, parent: secondGhost }]);
  current.forEach(animation => animation.finish());
  await flush();
  assert.equal(h.canvas.parentNode, h.host);
  assert.equal(h.calls.filter(call => call[0] === 'stop').length, 2);
  assert.deepEqual(reconciled[1], { departing: false, parent: h.host });
});
