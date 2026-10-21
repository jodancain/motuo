import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDom, fakeClock } from './fake-dom.mjs';

// HUD motion controllers against a recording DOM double and a manual clock.
// These verify lifecycle and data-semantics contracts, not visual quality.
function setup({ reduced = false } = {}) {
  const dom = createDom(), frames = fakeClock();
  const context = vm.createContext({ window: { devicePixelRatio: 2, getComputedStyle: () => ({ fontFamily: 'mono', fontSize: '80px', color: '#fff' }) }, performance: { now: frames.now }, setTimeout, Promise });
  for (const file of ['../motion-kit.js', '../hud-motion.js']) vm.runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), context);
  const M = context.window.MotuoMotion;
  const clock = M.createClock({ raf: frames.raf, caf: frames.caf, now: frames.now, hidden: frames.hidden });
  const state = { reduced };
  const app = dom.add('#app');
  const cockpit = dom.add('#cockpit', { left: 0, top: 0, width: 800, height: 400 }, app);
  const instrument = dom.add('#instrument', { left: 200, top: 50, width: 400, height: 300 }, cockpit);
  const digits = dom.add('.speed-digits', { left: 300, top: 120, width: 200, height: 100 }, instrument);
  const speed = dom.add('#speed', { left: 320, top: 130, width: 160, height: 92 }, digits);
  speed.textContent = '0';
  for (const s of ['#fx-canvas', '#accel-meter', '#sound-trend-open', '#sound-trend-value', '#rpm-segments', '.pause-shade', '.wordmark', '.page-head', '.music', '#ride-primary']) dom.add(s, undefined, cockpit);
  const hud = context.window.MotuoHudMotion.create(dom.doc, { clock, isReduced: () => state.reduced, win: context.window });
  return { dom, frames, clock, hud, state, app, cockpit, instrument, speed, digits, M };
}
const overlays = h => h.digits.children.filter(n => n.classList.contains('speed-roller'));

test('speed roller only swaps two real integer readings and marks itself as a transition', async () => {
  const h = setup();
  h.hud.speed(h.speed);                 // baseline, no motion
  assert.equal(overlays(h).length, 0);
  h.speed.textContent = '18'; h.hud.speed(h.speed);
  const [overlay] = overlays(h);
  assert.ok(overlay, 'a change between two integers rolls');
  assert.equal(overlay.attributes['aria-hidden'], 'true');
  assert.equal(h.instrument.dataset.transition, 'rolling');
  assert.ok(h.speed.classList.contains('speed-rolling'));
  assert.equal(h.speed.textContent, '18', 'the reading itself is written once and never animated');
  // Every glyph in the overlay is either the old or the new digit at that position: no invented values.
  const columns = overlay.children.map(c => c.children[0].children.map(s => s.textContent).join('|'));
  assert.deepEqual(columns, ['|1', '0|8']);
  await h.dom.finishAll();
  assert.equal(overlays(h).length, 0, 'overlay removed after settling');
  assert.equal(h.speed.classList.contains('speed-rolling'), false);
  assert.equal(h.instrument.dataset.transition, undefined);
  assert.equal(h.hud.debug().layers, 0);
});

test('unknown, estimated or inactive readings never roll; repeats do not stack', async () => {
  const h = setup();
  h.hud.speed(h.speed);
  for (const value of ['—', '12', '—']) { h.speed.textContent = value; h.hud.speed(h.speed); assert.equal(overlays(h).length, 0, value); }
  h.speed.textContent = '13'; h.hud.speed(h.speed, { active: false });
  assert.equal(overlays(h).length, 0, 'paused / departing / map view: instant');
  for (const value of ['14', '15', '16']) { h.speed.textContent = value; h.hud.speed(h.speed); }
  assert.equal(overlays(h).length, 1, 'a newer reading replaces the running roll');
  assert.ok(h.dom.animations.filter(a => a.cancels).length >= 2);
  h.hud.cancelAll();
  assert.equal(overlays(h).length, 0);
  assert.equal(h.speed.classList.contains('speed-rolling'), false);
});

test('reduced motion: speed changes are instant', () => {
  const h = setup({ reduced: true });
  h.hud.speed(h.speed); h.speed.textContent = '25'; h.hud.speed(h.speed);
  assert.equal(overlays(h).length, 0);
  assert.equal(h.dom.animations.length, 0);
});

test('impact feedback follows only the validated reading and bursts once per level', () => {
  const h = setup();
  h.hud.feedback({ valid: false, accel: 1.9, active: true });
  assert.equal(h.hud.debug().particles, 0, 'unknown acceleration produces no effect');
  assert.equal(h.cockpit.dataset.impact, 'none');
  h.hud.feedback({ valid: true, accel: .3, active: true });
  assert.equal(h.hud.debug().particles, 0, 'below the first level: glow only');
  h.hud.feedback({ valid: true, accel: .7, active: true });
  const first = h.hud.debug().particles;
  assert.ok(first > 0);
  h.hud.feedback({ valid: true, accel: .75, active: true });
  assert.equal(h.hud.debug().particles, first, 'holding a level does not re-trigger');
  assert.equal(h.cockpit.dataset.impact, 'push');
  h.frames.run(200);
  assert.ok(h.hud.debug().glow > .2, 'edge glow eases toward |a| / 2');
  h.hud.feedback({ valid: true, accel: -1.3, active: true });
  assert.equal(h.cockpit.dataset.impact, 'brake');
  h.hud.feedback({ valid: false, accel: NaN, active: true });
  h.frames.run(2500);
  const d = h.hud.debug();
  assert.equal(d.particles, 0); assert.equal(d.impactTask, false);
  assert.equal(h.cockpit.style['--impact'], '0');
  assert.equal(h.frames.pending(), 0, 'the shared loop idles once the effect decays');
});

test('pause freezes particles in place and stops the impact task; reduced resets everything', () => {
  const h = setup();
  h.hud.feedback({ valid: true, accel: 1.4, active: true });
  h.frames.step();
  h.hud.feedback({ valid: false, accel: NaN, active: true, paused: true });
  const count = h.hud.debug().particles;
  h.frames.run(1000);
  assert.equal(h.hud.debug().particles, count, 'time frozen: particles hold');
  assert.equal(h.hud.debug().impactTask, false);
  h.state.reduced = true;
  h.hud.feedback({ valid: true, accel: 1.4, active: true });
  assert.equal(h.hud.debug().particles, 0);
  assert.equal(h.cockpit.dataset.impact, 'none');
});

test('sound beat pulses only on a trend change from a live microphone or explicit DEMO', () => {
  const h = setup();
  h.hud.beat({ trend: '平稳', source: 'demo', active: true });
  assert.equal(h.dom.animations.length, 0, 'first observation is a baseline');
  h.hud.beat({ trend: '抬升', source: 'unknown', active: true });
  assert.equal(h.dom.animations.length, 0, 'no valid sound source: no beat (music never drives this)');
  h.hud.beat({ trend: '平稳', source: 'mic', active: true });
  const n = h.dom.animations.length;
  assert.ok(n > 0);
  h.hud.beat({ trend: '平稳', source: 'mic', active: true });
  assert.equal(h.dom.animations.length, n, 'unchanged trend: no pulse');
  h.hud.beat({ trend: '回落', source: 'demo', active: true, paused: true });
  assert.equal(h.dom.animations.length, n, 'paused: no pulse');
});

test('scene wipes never stack, skip during departure, and clean up', async () => {
  const h = setup();
  h.hud.scene('mode', { label: 'SPORT' });
  h.hud.scene('mode', { label: 'DAILY' });
  const wipes = () => h.cockpit.children.filter(n => n.classList.contains('scene-wipe'));
  assert.equal(wipes().length, 0, 'built on the next shared frame, not inside the click handler');
  h.frames.step();

  assert.equal(wipes().length, 1);
  assert.equal(wipes()[0].children[0].attributes['aria-label'], 'DAILY');
  await h.dom.finishAll();
  assert.equal(wipes().length, 0);
  h.hud.scene('scene', { label: '02 / BLUE PULSE' });
  h.frames.step();
  assert.equal(wipes().length, 1);
  h.frames.run(700);
  assert.equal(wipes().length, 0, 'clock wipe removes itself when the sweep completes');
  h.cockpit.classList.add('departing');
  h.hud.scene('mode'); h.frames.step();
  assert.equal(wipes().length, 0, 'departure owns the start moment');
  h.cockpit.classList.remove('departing');
  h.hud.scene('scene'); h.hud.cancelTransient(); h.frames.step();
  assert.equal(wipes().length, 0, 'cancelled before its frame: never built');
  h.hud.scene('scene'); h.frames.step(); h.hud.cancelTransient();
  assert.equal(wipes().length, 0);
  assert.equal(h.frames.pending() <= 1, true);
  h.frames.run(100); assert.equal(h.clock.taskCount, 0);
});

test('pause applies the time-freeze state; temporary flash and sweep are removed', async () => {
  const h = setup();
  h.hud.freeze(true);
  assert.ok(h.app.classList.contains('time-frozen'));
  assert.equal(h.hud.debug().layers, 1);
  h.hud.freeze(true);
  assert.equal(h.hud.debug().layers, 1, 'repeat does not stack flashes');
  await h.dom.finishAll();
  assert.equal(h.hud.debug().layers, 0);
  assert.ok(h.app.classList.contains('time-frozen'), 'frozen look persists for the whole pause');
  h.hud.freeze(false);
  assert.equal(h.app.classList.contains('time-frozen'), false);
  await h.dom.finishAll();
  assert.equal(h.hud.debug().layers, 0);
  const r = setup({ reduced: true });
  r.hud.freeze(true);
  assert.ok(r.app.classList.contains('time-frozen'), 'reduced motion keeps the state change');
  assert.equal(r.dom.animations.length, 0);
});

function recapPage(h, values) {
  const page = h.dom.add('#page-recap');
  const metrics = h.dom.add('.recap-metrics', undefined, page);
  const strongs = values.map(v => { const s = h.dom.makeNode('strong'); s.textContent = v; metrics.append(h.dom.makeNode('div')); metrics.children.at(-1).append(s); return s; });
  h.dom.registry.set('.recap-metrics strong', strongs);
  h.dom.registry.set('.recap-metrics>div', metrics.children);
  return { page, metrics, strongs };
}

test('recap tally is labelled, lands on the exact recorded text and can be cut short', async () => {
  const h = setup();
  const { page, metrics, strongs } = recapPage(h, ['1.37', '02:05', '0']);
  h.hud.recap();
  assert.ok(page.classList.contains('tallying'));
  assert.equal(metrics.attributes['aria-busy'], 'true');
  assert.equal(strongs[0].dataset.transition, 'tally');
  assert.equal(strongs[2].dataset.transition, undefined, 'zero is shown as-is, never counted');
  h.frames.run(700);
  assert.match(strongs[0].textContent, /^\d\.\d\d$/, 'interim keeps the final precision');
  h.frames.run(1200);
  assert.deepEqual(strongs.map(s => s.textContent), ['1.37', '02:05', '0']);
  await h.dom.flush();
  assert.equal(page.classList.contains('tallying'), false);
  assert.equal(metrics.attributes['aria-busy'], undefined);
  // Leaving early restores the final values immediately.
  h.hud.recap(); h.frames.run(200);
  assert.notEqual(strongs[1].textContent, '02:05');
  h.hud.cancelAll();
  assert.deepEqual(strongs.map(s => s.textContent), ['1.37', '02:05', '0']);
  assert.equal(strongs[0].dataset.transition, undefined);
  const r = setup({ reduced: true }), rr = recapPage(r, ['4.00']);
  r.hud.recap();
  assert.equal(rr.strongs[0].textContent, '4.00');
  assert.equal(r.dom.animations.length, 0);
});

test('standby intro splits the wordmark accessibly and leaves no layers when cancelled', async () => {
  const h = setup();
  const mark = h.dom.registry.get('.wordmark'); mark.textContent = 'MOTUO';
  h.hud.intro();
  assert.equal(mark.attributes['aria-label'], 'MOTUO');
  assert.equal(mark.textContent, 'MOTUO');
  assert.equal(mark.children.length, 5);
  assert.ok(mark.children.every(c => c.attributes['aria-hidden'] === 'true'));
  for (const control of ['.page-head', '.music', '#ride-primary']) {
    const a = h.dom.animations.find(x => x.node === h.dom.registry.get(control));
    assert.ok(a.frames.every(f => f.opacity === 1), `${control} stays visible and tappable during the intro`);
  }
  const delays = h.dom.animations.map(a => (a.options.delay || 0) + a.options.duration);
  assert.ok(Math.max(...delays) < 1400, 'whole intro under 1.4 s');
  assert.equal(h.hud.debug().layers, 1, 'boot scan');
  h.hud.intro();
  assert.equal(mark.children.length, 5, 'idempotent split');
  assert.equal(h.hud.debug().layers, 1);
  h.hud.cancelIntro();
  assert.equal(h.hud.debug().layers, 0);
  const r = setup({ reduced: true });
  r.hud.intro();
  assert.equal(r.dom.animations.length, 0);
});

test('cancelAll after a busy ride leaves no temporary layer, channel, task or frozen state', async () => {
  const h = setup();
  h.hud.speed(h.speed); h.speed.textContent = '9'; h.hud.speed(h.speed);
  h.hud.feedback({ valid: true, accel: 1.8, active: true });
  h.hud.scene('scene', { label: 'X' }); h.hud.freeze(true); h.hud.intro();
  h.frames.step(); h.frames.step();
  h.hud.cancelAll();
  const d = h.hud.debug();
  assert.equal(d.layers, 0); assert.equal(d.channels.length, 0); assert.equal(d.particles, 0); assert.equal(d.impactTask, false);
  assert.equal(h.app.classList.contains('time-frozen'), false);
  h.frames.run(100);
  assert.equal(h.clock.taskCount, 0);
  assert.equal(h.frames.pending(), 0);
});
