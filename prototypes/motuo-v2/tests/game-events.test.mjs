import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Game layer logic: thresholds, combo, rhythm, flash budget, intensity and rating.
// These are game-score contracts; nothing here is a measurement.
const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../game-events.js', import.meta.url), 'utf8'), context);
const G = context.window.MotuoGame;
const kinds = list => list.map(e => e.kind).join(',');
function drive(game, samples) {
  const out = [];
  for (const s of samples) out.push(...game.update({ active: true, ...s }));
  return out;
}
const ramp = (from, to, step = .1) => { const r = []; for (let t = from; t < to - 1e-9; t += step) r.push(Math.round(t * 1000) / 1000); return r; };

test('LAUNCH fires once when leaving standstill under positive acceleration', () => {
  const game = G.createGame();
  const events = drive(game, ramp(0, 3).map(t => ({ t, speedKmh: t * 3, accel: .83 })));
  assert.equal(events.filter(e => e.kind === 'launch').length, 1);
  assert.equal(events.find(e => e.kind === 'launch').word, 'LAUNCH!');
  const coasting = G.createGame();
  assert.equal(drive(coasting, ramp(0, 3).map(t => ({ t, speedKmh: t * 3, accel: 0 }))).filter(e => e.kind === 'launch').length, 0, 'no acceleration, no launch');
});

test('BOOST needs 1 s of strong acceleration and respects its cooldown; BRAKE mirrors it', () => {
  const game = G.createGame();
  let events = drive(game, ramp(10, 10.8).map(t => ({ t, speedKmh: 30, accel: .9 })));
  assert.equal(events.filter(e => e.kind === 'boost').length, 0, 'short burst is not a boost');
  events = drive(game, ramp(10.8, 20).map(t => ({ t, speedKmh: 35, accel: .9 })));
  assert.equal(events.filter(e => e.kind === 'boost').length, 2, '6 s cooldown: ~one per 6 s of sustained boost');
  const braking = drive(G.createGame(), ramp(0, 3).map(t => ({ t, speedKmh: 30 - t, accel: -.8 })));
  assert.equal(braking.filter(e => e.kind === 'brake').length, 1);
  assert.equal(braking.find(e => e.kind === 'brake').tone, 'red');
});

test('CORNER fires on entering a turn state, with a cooldown', () => {
  const game = G.createGame();
  const motions = ['cruise', 'turn', 'turn', 'cruise', 'turn', 'cruise'];
  const events = drive(game, motions.map((motion, i) => ({ t: 10 + i, speedKmh: 30, accel: 0, motion })));
  assert.equal(events.filter(e => e.kind === 'corner').length, 1);
  const later = drive(game, [{ t: 30, speedKmh: 30, accel: 0, motion: 'turn' }]);
  assert.equal(later.filter(e => e.kind === 'corner').length, 1);
});

test('milestones need a real upward crossing, never fire on estimates or unknown speed, and re-arm 10 km/h below', () => {
  const game = G.createGame();
  let events = drive(game, [{ t: 1, speedKmh: 28, accel: .3 }, { t: 1.1, speedKmh: 31, accel: .3 }]);
  assert.deepEqual(events.filter(e => e.kind === 'milestone').map(e => e.word), ['30 KM/H']);
  events = drive(game, [{ t: 2, speedKmh: 29 }, { t: 2.1, speedKmh: 32 }]);
  assert.equal(events.filter(e => e.kind === 'milestone').length, 0, 'not re-armed until 10 km/h below');
  events = drive(game, [{ t: 3, speedKmh: 19 }, { t: 3.1, speedKmh: 31 }]);
  assert.equal(events.filter(e => e.kind === 'milestone').length, 1);
  const estimated = drive(G.createGame(), [{ t: 1, speedKmh: 28, estimated: true }, { t: 1.1, speedKmh: 45, estimated: true }]);
  assert.equal(estimated.filter(e => e.kind === 'milestone').length, 0, '≈ inertial estimates are not milestones');
  const unknown = drive(G.createGame(), [{ t: 1, speedKmh: null }, { t: 1.1, speedKmh: null }]);
  assert.equal(unknown.length, 0);
  assert.equal(G.createGame().summary().maxSpeed, 0);
});

test('combo grows with smooth, valid acceleration and resets on harsh changes or a reading gap', () => {
  const game = G.createGame();
  drive(game, ramp(0, 6.05).map(t => ({ t, speedKmh: 30, accel: .2 })));
  assert.equal(game.combo, 3);
  drive(game, [{ t: 6.1, speedKmh: 30, accel: 1.4 }]);
  assert.equal(game.combo, 0, 'harsh change resets');
  drive(game, ramp(6.2, 10.4).map(t => ({ t, speedKmh: 30, accel: .1 })));
  assert.ok(game.combo >= 2);
  drive(game, ramp(10.4, 12).map(t => ({ t, speedKmh: null, accel: null })));
  assert.equal(game.combo, 0, 'unknown acceleration for >1 s resets');
  assert.ok(game.summary().maxCombo >= 3);
});

test('paused or inactive: no events and no score', () => {
  const game = G.createGame();
  assert.equal(drive(game, ramp(0, 5).map(t => ({ t, speedKmh: t * 10, accel: 1, paused: true }))).length, 0);
  assert.equal(drive(game, ramp(0, 5).map(t => ({ t, speedKmh: t * 10, accel: 1, active: false }))).length, 0);
  assert.equal(game.score, 0);
});

test('rhythm judgement only for a valid sound source and grades by distance to the 120 BPM grid', () => {
  const game = G.createGame();
  const hit = (t, beatT, valid = true) => {
    game.update({ active: true, t, sound: { valid, energy: .1 }, beatT });
    return game.update({ active: true, t: t + .05, sound: { valid, energy: .8 }, beatT }).filter(e => e.kind === 'rhythm');
  };
  assert.equal(hit(1, 1.02)[0].grade, 'perfect');
  assert.equal(hit(2, 2.1)[0].grade, 'great');
  assert.equal(hit(3, 3.25)[0].grade, 'good');
  assert.equal(hit(4, 4.0, false).length, 0, 'no microphone and no explicit DEMO: no judgement (music never counts)');
  const s = game.summary();
  assert.equal(s.counts.perfect + s.counts.great + s.counts.good, 3);
});

test('flash limiter allows at most 2 flashes in any sliding one-second window (WCAG 2.3.1 limit is 3)', () => {
  const limiter = G.createFlashLimiter();
  const allowed = [];
  for (let t = 0; t <= 5000; t += 50) if (limiter.allow(t)) allowed.push(t);
  for (const t of allowed) assert.ok(allowed.filter(x => x > t - 1000 && x <= t).length <= 2, `window ending ${t}`);
  assert.ok(allowed.length >= 9, 'still flashes regularly');
});

test('heat colour exists only for a real reading; intensity defaults to extreme; ratings are labelled game scores', () => {
  assert.equal(G.heat(null), null);
  assert.equal(G.heat(NaN), null);
  assert.equal(G.heat(0).css, 'rgb(110,230,255)');
  assert.equal(G.heat(200).css, 'rgb(255,72,64)');
  assert.equal(G.normalizeIntensity(null), 'extreme');
  assert.equal(G.normalizeIntensity('bogus'), 'extreme');
  assert.equal(G.normalizeIntensity('restrained'), 'restrained');
  assert.equal(G.INTENSITY.restrained.shake, 0);
  assert.equal(G.INTENSITY.restrained.cinematic, false);
  assert.ok(G.INTENSITY.extreme.shake > G.INTENSITY.standard.shake);
  const s = G.createGame().summary();
  assert.equal(s.rating, 'C');
  assert.match(s.label, /游戏分/);
  assert.match(s.label, /非驾驶评价/);
  for (const copy of Object.values(G.EVENT_COPY)) assert.match(copy.sub, /演示/);
});
