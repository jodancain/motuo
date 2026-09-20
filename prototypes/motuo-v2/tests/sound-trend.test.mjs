import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../sound-trend.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const sound = sandbox.window.MotuoSoundTrend;
const sample = (tracker, values = {}) => tracker.sample({ time: 0, valid: true, energy: .3, spectrum: Array(24).fill(.3), paused: false, ...values });
const levelSample = (tracker, time, energy, values = {}) => sample(tracker, { time, energy, spectrum: Array(24).fill(energy), ...values });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);

test('unavailable, paused and invalid signals clear both level and directional history', () => {
  for (const invalid of [{ valid: false }, { valid: 'true' }, { paused: true }, { time: NaN }, { time: -1 }, { energy: NaN }]) {
    const tracker = sound.create();
    levelSample(tracker, 0, .2);
    levelSample(tracker, .1, .8);
    levelSample(tracker, .3, .8);
    const reading = sample(tracker, { time: .4, ...invalid });
    assert.equal(reading.level, 0);
    assert.equal(reading.trend, 'waiting');
    assert.equal(reading.sourceQuality, 'unavailable');
    assert.equal(levelSample(tracker, .5, .2).trend, 'steady');
  }
});

test('valid quiet input stays zero and does not imply validated engine detection', () => {
  const tracker = sound.create();
  for (let time = 0; time < 1; time += .1) {
    const reading = levelSample(tracker, time, .02);
    assert.equal(reading.level, 0);
    assert.equal(reading.trend, 'quiet');
    assert.equal(reading.sourceQuality, 'unvalidated');
  }
});

test('real-time EMA is consistent across different sampling rates', () => {
  const sparse = sound.create();
  const dense = sound.create();
  levelSample(sparse, 0, .2);
  levelSample(dense, 0, .2);
  const once = levelSample(sparse, .4, .8);
  let many;
  for (let index = 1; index <= 4; index += 1) many = levelSample(dense, index * .1, .8);
  closeTo(once.level, .2 + .6 * (1 - Math.exp(-1)));
  closeTo(once.level, many.level);
});

test('sustained rising, falling and stable sound have distinct trends after confirmation', () => {
  const tracker = sound.create();
  levelSample(tracker, 0, .2);
  assert.equal(levelSample(tracker, .1, .8).trend, 'steady');
  assert.equal(levelSample(tracker, .3, .8).trend, 'rising');
  assert.equal(levelSample(tracker, .4, .1).trend, 'rising');
  assert.equal(levelSample(tracker, .6, .1).trend, 'falling');
  let settled;
  for (let index = 7; index < 40; index += 1) settled = levelSample(tracker, index / 10, .1);
  assert.equal(settled.trend, 'steady');
});

test('one noisy frame and alternating tiny fluctuations do not announce a new rise', () => {
  const tracker = sound.create();
  levelSample(tracker, 0, .3);
  assert.equal(levelSample(tracker, .1, 1).trend, 'steady');
  levelSample(tracker, .2, .3);
  const stable = sound.create();
  levelSample(stable, 0, .3);
  for (let index = 1; index < 50; index += 1) {
    assert.equal(levelSample(stable, index / 60, .3 + (index % 2 ? .005 : -.005)).trend, 'steady');
  }
});

test('duplicate timestamps are idempotent and rollback or long gaps rebuild the baseline', () => {
  const tracker = sound.create();
  levelSample(tracker, 0, .2);
  const original = levelSample(tracker, .1, .8);
  const repeated = levelSample(tracker, .1, .1);
  assert.equal(original.level, repeated.level);
  assert.equal(original.trend, repeated.trend);
  for (const time of [.05, 20]) {
    const rebuilt = levelSample(tracker, time, .4);
    assert.equal(rebuilt.level, .4);
    assert.equal(rebuilt.trend, 'steady');
  }
});

test('silence after an audible signal decays to quiet and explicit reset clears the meter', () => {
  const tracker = sound.create();
  levelSample(tracker, 0, .8);
  let reading;
  for (let index = 1; index <= 30; index += 1) reading = levelSample(tracker, index / 10, 0);
  assert.equal(reading.level, 0);
  assert.equal(reading.trend, 'quiet');
  tracker.reset();
  assert.equal(levelSample(tracker, 3.1, .4).trend, 'steady');
});

test('spectrum affects relative strength without emitting speed or engine classification', () => {
  const low = sound.create();
  const high = sound.create();
  const left = sample(low, { spectrum: Array(24).fill(.1) });
  const right = sample(high, { spectrum: Array(24).fill(.9) });
  assert.ok(right.level > left.level);
  assert.deepEqual(Object.keys(right).sort(), ['level', 'sourceQuality', 'trend']);
});

test('out-of-range and malformed bins cannot create non-finite levels', () => {
  for (const spectrum of [undefined, null, [], [NaN, Infinity, -1, 3], new Float32Array([.2, .4])]) {
    for (const energy of [-20, .4, 30]) {
      const tracker = sound.create();
      const reading = sample(tracker, { energy, spectrum });
      assert.ok(Number.isFinite(reading.level) && reading.level >= 0 && reading.level <= 1);
    }
  }
});

test('vehicle speed, acceleration and scenario do not change audio-driven outputs', () => {
  const left = sound.create();
  const right = sound.create();
  for (let index = 0; index < 100; index += 1) {
    const energy = .4 + .3 * Math.sin(index / 10);
    const a = levelSample(left, index / 10, energy, { speedKmh: 0, accelMs2: 0, scenario: 'stop' });
    const b = levelSample(right, index / 10, energy, { speedKmh: 140, accelMs2: 8, scenario: 'launch' });
    assert.equal(a.level, b.level);
    assert.equal(a.trend, b.trend);
  }
});
