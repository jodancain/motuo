import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Pure motion math and the shared scheduler, run in isolated contexts.
const source = readFileSync(new URL('../motion-kit.js', import.meta.url), 'utf8');
function load(extra = {}) {
  const context = vm.createContext({ window: { ...extra }, performance: { now: () => 0 } });
  vm.runInContext(source, context);
  return context.window.MotuoMotion;
}
const M = load();
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

function integrate(config, seconds) {
  let x = 0, v = config.velocity || 0;
  const dt = 1 / 20000;
  for (let t = 0; t < seconds; t += dt) {
    const a = (-config.stiffness * (x - 1) - config.damping * v) / (config.mass || 1);
    v += a * dt; x += v * dt;
  }
  return x;
}

test('analytic spring matches numerical integration in all three damping regimes', () => {
  const regimes = [
    { stiffness: 100, damping: 10, mass: 1 },                    // underdamped (video default)
    { stiffness: 100, damping: 20, mass: 1 },                    // critical
    { stiffness: 100, damping: 60, mass: 1 },                    // overdamped
    { stiffness: 320, damping: 18, mass: .9, velocity: 4 },      // initial velocity
  ];
  for (const config of regimes) for (const t of [.05, .2, .5, 1.2]) near(M.springValue(t, config), integrate(config, t), 2e-3);
  assert.equal(M.springValue(0, regimes[0]), 0);
  near(M.springValue(10, regimes[0]), 1, 1e-6);
});

test('overshoot clamping caps the spring at its target', () => {
  const config = { ...M.springs.pop, overshootClamping: true };
  for (let t = 0; t < 1; t += .01) assert.ok(M.springValue(t, config) <= 1);
  assert.ok(Math.max(...Array.from({ length: 100 }, (_, i) => M.springValue(i / 100, M.springs.pop))) > 1.05, 'pop keeps a visible overshoot');
});

test('settle time is real: the spring stays within threshold afterwards', () => {
  for (const [name, config] of Object.entries(M.springs)) {
    const settle = M.springSettle(config);
    for (let t = settle; t < settle + 3; t += 1 / 120) assert.ok(Math.abs(M.springValue(t, config) - 1) <= .004 + 1e-9, `${name} at ${t}`);
  }
  assert.ok(M.springSettle(M.springs.roll) < .3, 'digit roller settles before the next 0.3 s reading');
  assert.ok(M.springSettle(M.springs.smooth) < 1, 'smooth is usable in real time');
});

test('interpolate maps piecewise ranges, clamps by default and validates input', () => {
  assert.equal(M.interpolate(5, [0, 10], [0, 100]), 50);
  assert.equal(M.interpolate(-5, [0, 10], [0, 100]), 0);
  assert.equal(M.interpolate(15, [0, 10], [0, 100]), 100);
  assert.equal(M.interpolate(15, [0, 10], [0, 100], { extrapolateRight: 'extend' }), 150);
  assert.equal(M.interpolate(15, [0, 10, 20], [0, 1, 0]), .5);
  near(M.interpolate(5, [0, 10], [0, 1], { easing: x => x * x }), .25);
  near(M.interpolate(15, [0, 10, 20], [0, 1, 3], { easing: [x => x, x => x * x] }), 1.5);
  assert.equal(M.interpolate(NaN, [0, 10], [3, 4]), 3, 'non-finite input falls back to the range start');
  assert.throws(() => M.interpolate(1, [0, 0], [0, 1]), { name: 'RangeError' });
  assert.throws(() => M.interpolate(1, [0, 1, 2], [0, 1]), { name: 'RangeError' });
});

test('bezier easing matches CSS reference points and exposes its css string', () => {
  const ease = M.bezier(.25, .1, .25, 1);
  near(ease(.5), .8024, 2e-3);
  assert.equal(ease(0), 0); assert.equal(ease(1), 1);
  for (let x = 0; x <= 1; x += .05) assert.ok(M.easing.out(x) >= M.easing.linear(x) - 1e-9);
  assert.equal(M.easing.out.css, 'cubic-bezier(0.16,1,0.3,1)');
});

test('stagger keeps cascades under the total budget and supports center order', () => {
  const delays = Array.from({ length: 30 }, (_, i) => M.stagger(i, 30));
  assert.equal(delays[0], 0);
  assert.ok(Math.max(...delays) <= M.staggers.maxTotal);
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => M.stagger(i, 5, { step: 50 })), [0, 50, 100, 150, 200]);
  const center = Array.from({ length: 5 }, (_, i) => M.stagger(i, 5, { step: 50, from: 'center' }));
  assert.deepEqual(center, [100, 50, 0, 50, 100]);
  assert.equal(M.stagger(0, 1), 0);
});

test('spring timing emits linear() where supported and a cubic fallback elsewhere', () => {
  const fallback = M.springTiming('snappy');
  assert.match(fallback.easing, /^cubic-bezier\(/);
  const supported = load({ CSS: { supports: (p, v) => p === 'animation-timing-function' && v.startsWith('linear(') } });
  const timing = supported.springTiming('pop', { maxMs: 400 });
  assert.match(timing.easing, /^linear\(0 0%, /);
  assert.match(timing.easing, /, 1 100%\)$/);
  assert.equal(timing.duration, 400, 'maxMs stretches/compresses the curve, as for fixed-length transitions');
  assert.ok(supported.springTiming('roll').duration < 300);
});

test('reduced-motion preference is read safely', () => {
  assert.equal(M.prefersReduced(() => ({ matches: true })), true);
  assert.equal(M.prefersReduced(() => { throw new Error('no media'); }), false);
  assert.equal(M.prefersReduced(undefined), false);
});

// Deterministic rAF: tests advance frames manually.
function fakeFrames() {
  let time = 0, next = 1, hidden = false;
  const queue = new Map();
  return {
    raf: fn => { const id = next++; queue.set(id, fn); return id; },
    caf: id => queue.delete(id),
    now: () => time,
    hidden: () => hidden,
    setHidden(value) { hidden = value; },
    pending: () => queue.size,
    step(ms = 1000 / 60) { time += ms; const due = [...queue.values()]; queue.clear(); due.forEach(fn => fn(time)); },
  };
}

test('one rAF serves every task, and the loop stops when idle or hidden', () => {
  const f = fakeFrames(), clock = M.createClock(f);
  const calls = { a: 0, b: 0 };
  const removeA = clock.add(() => { calls.a++; });
  clock.add(() => { calls.b++; return calls.b < 3; });
  clock.add(() => {});
  assert.equal(f.pending(), 1, 'three tasks share one outstanding frame request');
  for (let i = 0; i < 5; i++) { f.step(); assert.ok(f.pending() <= 1); }
  assert.equal(calls.b, 3, 'returning false retires a task');
  removeA();
  f.setHidden(true); f.step();
  assert.equal(clock.running, false);
  assert.equal(f.pending(), 0, 'hidden page: no further frames requested');
  const before = calls.a; f.step(); assert.equal(calls.a, before);
  f.setHidden(false); clock.visibilityChanged();
  assert.equal(f.pending(), 1, 'visible again: the loop resumes');
});

test('requestFrame is a one-shot rAF replacement on the same loop', () => {
  const f = fakeFrames(), clock = M.createClock(f), seen = [];
  const id = clock.requestFrame(t => seen.push(t));
  clock.requestFrame(t => seen.push(-t));
  clock.cancelFrame(id);
  f.step(); f.step();
  assert.equal(seen.length, 1);
  assert.ok(seen[0] < 0);
  assert.equal(f.pending(), 0, 'no tasks left: the loop stops');
});

test('eco tier throttles marked tasks to 30fps; manual mode and hints override auto', () => {
  const f = fakeFrames(), tiers = [], clock = M.createClock({ ...f, onTier: tier => tiers.push(tier) });
  let throttled = 0, full = 0;
  clock.add(() => { throttled++; }, { throttle: true });
  clock.add(() => { full++; });
  clock.setMode('eco');
  for (let i = 0; i < 60; i++) f.step();
  assert.equal(clock.tier, 'eco');
  assert.ok(full >= 59 && throttled <= 31 && throttled >= 28, `${full} / ${throttled}`);
  clock.setMode('normal'); assert.equal(clock.tier, 'normal');
  clock.setMode('auto'); clock.setHint(true); assert.equal(clock.tier, 'eco');
  clock.setHint(false); assert.equal(clock.tier, 'normal');
  assert.deepEqual(tiers, ['eco', 'normal', 'eco', 'normal']);
});

test('auto tier drops after sustained slow frames and recovers only after a longer fast period', () => {
  const f = fakeFrames(), clock = M.createClock(f);
  clock.add(() => {});
  for (let i = 0; i < 30; i++) f.step(16.7);
  assert.equal(clock.tier, 'normal');
  f.step(400); // a single stall (tab switch) is ignored
  assert.equal(clock.tier, 'normal');
  for (let i = 0; i < 120; i++) f.step(40);
  assert.equal(clock.tier, 'eco');
  for (let i = 0; i < 120; i++) f.step(16.7);
  assert.equal(clock.tier, 'eco', 'hysteresis: two seconds of good frames is not enough');
  for (let i = 0; i < 600; i++) f.step(16.7);
  assert.equal(clock.tier, 'normal');
});

test('timeline runs tracks in order, cancels only started tracks, and honours reduced motion', async () => {
  const f = fakeFrames(), clock = M.createClock(f), log = [];
  const tl = M.createTimeline(clock)
    .add({ at: 0, duration: 100, start: () => log.push('a:start'), update: p => log.push('a:' + p.toFixed(1)), end: () => log.push('a:end'), cancel: () => log.push('a:cancel') })
    .add({ at: 500, duration: 100, start: () => log.push('b:start'), cancel: () => log.push('b:cancel') });
  assert.equal(tl.duration, 600);
  tl.play();
  f.step(10); f.step(60); f.step(60);
  assert.deepEqual(log.slice(0, 2), ['a:start', 'a:0.0']);
  assert.ok(log.includes('a:end'));
  tl.cancel();
  assert.equal(await tl.finished, 'cancelled');
  assert.ok(log.includes('a:cancel') && !log.includes('b:cancel') && !log.includes('b:start'));
  f.step(); assert.equal(f.pending(), 0, 'cancelled timeline leaves no task');

  const reducedLog = [];
  const reduced = M.createTimeline(clock, { reduced: true }).add({ at: 300, duration: 900, update: p => reducedLog.push(p), end: () => reducedLog.push('end') }).play();
  assert.deepEqual(reducedLog, [1, 'end'], 'reduced motion jumps straight to the final state');
  assert.equal(await reduced.finished, 'finished');
});
