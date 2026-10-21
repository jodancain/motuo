import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDom, fakeClock } from './fake-dom.mjs';

// Exaggerated layer against a recording DOM double: safety rails (flash budget,
// speed text untouched, reduced motion, cleanup) rather than visual quality.
function setup({ reduced = false, level = 'extreme' } = {}) {
  const dom = createDom(), frames = fakeClock();
  const win = { performance: { now: frames.now }, devicePixelRatio: 2, console };
  const context = vm.createContext({ window: win, setTimeout, clearTimeout, Promise });
  for (const f of ['motion-kit', 'game-events', 'game-world', 'game-fx']) vm.runInContext(readFileSync(new URL(`../${f}.js`, import.meta.url), 'utf8'), context);
  const clock = win.MotuoMotion.createClock({ raf: frames.raf, caf: frames.caf, now: frames.now, hidden: () => false });
  const opts = { reduced, level };
  const app = dom.add('#app'), cockpit = dom.add('#cockpit', { left: 0, top: 0, width: 800, height: 400 }, app);
  const content = dom.add('.speed-content', { left: 300, top: 110, width: 200, height: 140 }, cockpit);
  const digits = dom.add('.speed-digits', { left: 300, top: 120, width: 200, height: 100 }, content);
  const speed = dom.add('#speed', { left: 320, top: 130, width: 160, height: 92 }, digits);
  speed.textContent = '12';
  for (const s of ['#game-flash', '#game-callout', '#game-overlay', '#game-world', '#game-paused', '#game-transition', '#game-judge', '#game-score', '#chase-host', '#sound-trend-open', '#fx-canvas']) dom.add(s, { left: 0, top: 0, width: 800, height: 400 }, cockpit);
  const wrapped = dom.add('#wrapped');
  const stage = dom.add('[data-wrapped-stage]', undefined, wrapped);
  wrapped.hidden = true;
  const fx = win.MotuoGameFX.create(dom.doc, { clock, isReduced: () => opts.reduced, intensity: () => win.MotuoGame.INTENSITY[opts.level], win });
  const input = { page: 'cockpit', view: 'hud', mode: 'sport', scene: 'gravity', speedKmh: 40, accel: .8, energy: .4, soundValid: true, turning: false, active: true };
  const run = (ms, extra = {}) => { const end = frames.now() + ms; while (frames.now() < end) { frames.step(); fx.frame(frames.now(), 1 / 60, { ...input, ...extra }); } };
  return { dom, frames, clock, fx, win, opts, app, cockpit, speed, digits, wrapped, stage, run, G: win.MotuoGame, W: win.MotuoWorld };
}
const flashAnims = h => h.dom.animations.filter(a => a.node === h.dom.registry.get('#game-flash'));

test('world params never invent motion from unknown readings; reduced motion stops travel', () => {
  const { W } = setup();
  const unknown = W.worldParams({ mode: 'sport', speedKmh: null, accel: null, active: true });
  assert.equal(unknown.speed, 0); assert.equal(unknown.accel, 0);
  assert.equal(W.worldParams({ mode: 'sport', speedKmh: 80, active: false }).speed, 0, 'not riding: calm world');
  assert.equal(W.worldParams({ energy: .9, soundValid: false }).energy, 0, 'sound marks need a valid mic or explicit DEMO');
  const reduced = W.worldParams({ mode: 'sport', speedKmh: 80, accel: 1, active: true, reduced: true });
  assert.equal(reduced.rate, 0); assert.equal(reduced.ca, 0);
  assert.equal(W.worldParams({ mode: 'daily', scene: 'aurora' }).theme, 0);
  assert.deepEqual(['gravity', 'neon', 'spectrum', 'aurora'].map(scene => W.worldParams({ mode: 'sport', scene }).theme).join(), '1,2,3,4');
  const fast = W.worldParams({ mode: 'sport', speedKmh: 100, active: true }), slow = W.worldParams({ mode: 'sport', speedKmh: 30, active: true });
  assert.ok(fast.rate > slow.rate * 3, 'super-linear "warp" travel');
  const failing = W.create({ getContext: () => null, getBoundingClientRect: () => ({ width: 10, height: 10 }) });
  assert.equal(failing.ok, false, 'no WebGL: graceful fallback, no throw');
  assert.equal(failing.frame(.016, fast), false);
});

test('a storm of events never flashes more than twice in any second', () => {
  const h = setup();
  for (let i = 0; i < 12; i++) { h.fx.event({ kind: 'boost', word: 'BOOST', sub: '强加速 · 演示', tone: 'magenta', bonus: 150 }); h.frames.step(80); }
  assert.ok(flashAnims(h).length <= 2, `${flashAnims(h).length} flashes in ~1 s`);
  assert.ok(h.fx.debug().flashesInLastSecond <= 2);
  for (const a of flashAnims(h)) assert.ok(Math.max(...a.frames.map(f => f.opacity)) <= .5, 'flash peak stays translucent over the speed');
});

test('callouts are labelled game score / demo and the speed text is never written', () => {
  const h = setup();
  h.fx.event({ kind: 'milestone', word: '40 KM/H', sub: '速度里程碑 · 演示', tone: 'amber', bonus: 300 });
  const callout = h.dom.registry.get('#game-callout');
  assert.equal(callout.hidden, false);
  assert.match(callout.textContent, /40 KM\/H/);
  assert.match(callout.textContent, /游戏分/);
  assert.match(callout.textContent, /演示/);
  assert.ok(h.fx.debug().particles > 0);
  h.run(300);
  assert.notEqual(h.cockpit.style.translate || '', '', 'camera shake applied');
  assert.equal(h.speed.textContent, '12');
});

test('speed changes: new reading shown at once; old one trails behind and is removed', async () => {
  const h = setup();
  h.fx.speedReading('12', { active: true });
  h.speed.textContent = '13'; h.fx.speedReading('13', { active: true });
  const ghosts = () => h.digits.children.filter(n => n.classList.contains('speed-ghost'));
  assert.equal(ghosts().length, 1);
  assert.equal(ghosts()[0].textContent, '12');
  assert.equal(ghosts()[0].attributes['aria-hidden'], 'true');
  assert.equal(h.speed.textContent, '13', 'the real value is the only value in the readout');
  assert.ok(h.app.style['--heat-color'].startsWith('rgb('));
  await h.dom.finishAll();
  assert.equal(ghosts().length, 0);
  h.fx.speedReading('—', { active: true });
  assert.equal(ghosts().length, 0, 'unknown readings do not trail');
  assert.equal(h.app.style['--heat'], '0', 'no heat without a reading');
});

test('reduced motion keeps the label but drops particles, flashes and shake', () => {
  const h = setup({ reduced: true });
  h.fx.event({ kind: 'boost', word: 'BOOST', sub: '强加速 · 演示', tone: 'magenta', bonus: 150 });
  assert.match(h.dom.registry.get('#game-callout').textContent, /BOOST/);
  assert.equal(h.fx.debug().particles, 0);
  assert.equal(flashAnims(h).length, 0);
  h.run(200);
  assert.equal(h.cockpit.style.translate || '', '');
  assert.equal(h.fx.transition(), null, 'no full-screen transition');
  assert.equal(h.fx.allowFlash(), false);
});

test('restrained intensity: no shake, no flash', () => {
  const h = setup({ level: 'restrained' });
  h.fx.event({ kind: 'milestone', word: '30 KM/H', sub: '速度里程碑 · 演示', tone: 'amber', bonus: 300 });
  h.run(200);
  assert.equal(h.cockpit.style.translate || '', '');
  assert.equal(flashAnims(h).length, 0);
});

test('scene transitions rotate through four kinds, never stack, and clean up', () => {
  const h = setup();
  const kinds = [h.fx.transition(), h.fx.transition(), h.fx.transition(), h.fx.transition(), h.fx.transition()];
  assert.deepEqual(kinds.join(), 'shatter,glitch,iris,warp,shatter');
  h.fx.transition('glitch');
  assert.ok(h.app.classList.contains('glitching'));
  h.fx.cancelAll();
  const d = h.fx.debug();
  assert.equal(d.shards, 0); assert.equal(d.bars, 0); assert.equal(d.channels.length, 0);
  assert.equal(h.app.classList.contains('glitching'), false);
});

test('bullet time slows to a freeze; resume rewinds briefly, then returns to real time', () => {
  const h = setup();
  h.fx.pause(true);
  h.run(1500, { active: false });
  assert.equal(h.fx.debug().timeScale, 0);
  assert.ok(h.fx.debug().shards > 0, 'shards hover while frozen');
  assert.ok(h.app.classList.contains('bullet-time'));
  assert.equal(h.dom.registry.get('#game-paused').hidden, false);
  h.fx.pause(false);
  h.run(100);
  assert.ok(h.fx.debug().timeScale < 0, 'rewind');
  h.run(1500);
  assert.ok(Math.abs(h.fx.debug().timeScale - 1) < .05);
  assert.equal(h.fx.debug().shards, 0);
  assert.equal(h.dom.registry.get('#game-paused').hidden, true);
  const r = setup({ reduced: true });
  r.fx.pause(true); assert.equal(r.fx.debug().timeScale, 0);
  r.fx.pause(false); assert.equal(r.fx.debug().timeScale, 1);
});

test('wrapped recap: one number per screen, labelled data, skippable, closes cleanly', () => {
  const h = setup();
  const ride = { distance: 1370, seconds: 125, maxSpeed: 40 };
  let closed = 0;
  h.fx.wrappedRecap(ride, h.G.createGame().summary(), { onClose: () => closed++ });
  assert.equal(h.wrapped.hidden, false);
  assert.equal(h.wrapped.dataset.step, '1');
  assert.match(h.stage.textContent, /模拟里程/);
  h.fx.nextWrapped(); h.fx.nextWrapped();
  assert.equal(h.wrapped.dataset.step, '3');
  assert.match(h.stage.textContent, /非实测/);
  h.fx.skipWrapped();
  assert.equal(h.wrapped.dataset.step, 'card');
  assert.match(h.stage.textContent, /游戏分/);
  assert.match(h.stage.textContent, /非驾驶评价/);
  assert.match(h.stage.textContent, /1\.37 km/);
  h.fx.closeWrapped();
  assert.equal(h.wrapped.hidden, true); assert.equal(closed, 1);
  assert.equal(h.fx.debug().wrapped, false);
  const r = setup({ reduced: true });
  r.fx.wrappedRecap(ride, r.G.createGame().summary());
  assert.equal(r.wrapped.dataset.step, 'card', 'reduced motion: straight to the static card');
  assert.equal(r.dom.animations.length, 0);
  r.fx.closeWrapped();
});

test('cancelAll (hidden page, resize, reduced) leaves no temporary layer or motion state', () => {
  const h = setup();
  h.fx.speedReading('12', { active: true }); h.speed.textContent = '14'; h.fx.speedReading('14', { active: true });
  h.fx.event({ kind: 'launch', word: 'LAUNCH!', sub: '起步 · 演示', tone: 'cyan', bonus: 100 });
  h.fx.transition('shatter');
  h.run(100);
  h.fx.cancelAll();
  const d = h.fx.debug();
  assert.equal(d.temp, 0); assert.equal(d.particles, 0); assert.equal(d.rings, 0); assert.equal(d.trauma, 0);
  assert.equal(h.cockpit.style.translate, '');
  assert.equal(h.dom.registry.get('#game-callout').hidden, true);
});

test('while a dialog is open, events, flashes and shake are held; they resume after it closes', () => {
  const h = setup();
  h.fx.setModal(true);
  h.fx.event({ kind: 'corner', word: 'CORNER', sub: '过弯 · 演示', tone: 'violet', bonus: 200 });
  assert.equal(h.dom.registry.get('#game-callout').hidden, true, 'no giant word behind the dialog');
  assert.equal(h.fx.debug().particles, 0);
  assert.equal(h.fx.flash('white'), false);
  assert.equal(h.fx.allowFlash(), false);
  h.fx.shake(1); h.run(100);
  assert.equal(h.cockpit.style.translate || '', '');
  h.fx.setModal(false);
  h.fx.event({ kind: 'corner', word: 'CORNER', sub: '过弯 · 演示', tone: 'violet', bonus: 200 });
  assert.equal(h.dom.registry.get('#game-callout').hidden, false);
  assert.ok(h.fx.debug().particles > 0);
});

test('native recap: labels follow a measured source, and the detail button reports its reason', () => {
  const h = setup();
  const reasons = [];
  h.fx.wrappedRecap({ distance: 2400, seconds: 300, maxSpeed: 52, source: 'measured' }, h.G.createGame().summary(), { native: true, onClose: r => reasons.push(r) });
  assert.equal(h.wrapped.dataset.native, 'true');
  assert.match(h.stage.textContent, /GPS 实测里程/);
  assert.doesNotMatch(h.stage.textContent, /模拟/);
  h.fx.skipWrapped();
  assert.match(h.stage.textContent, /本机实测记录/);
  assert.match(h.stage.textContent, /游戏分/);
  h.fx.closeWrapped('detail');
  assert.deepEqual(reasons, ['detail']);
});
