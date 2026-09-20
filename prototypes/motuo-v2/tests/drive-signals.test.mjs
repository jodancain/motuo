import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../drive-signals.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const signals = sandbox.window.MotuoDriveSignals;
const base = { seconds: 0, speedKmh: 0, phase: 'riding', scenario: 'normal', scenarioStarted: 0, motion: 'launch' };
const sample = (tracker, values = {}) => tracker.sample({ ...base, ...values });
const closeTo = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);

test('acceleration uses actual elapsed seconds and converts km/h into m/s² and g', () => {
  const tracker = signals.create();
  const first = sample(tracker);
  assert.equal(first.status, 'warming');
  assert.equal(first.accelMs2, null);
  const positive = sample(tracker, { seconds: .5, speedKmh: 3.6 });
  closeTo(positive.accelMs2, 2);
  closeTo(positive.accelG, 2 / 9.80665);
  assert.equal(positive.status, 'valid');
  const negative = sample(tracker, { seconds: 1.5, speedKmh: 0 });
  closeTo(negative.accelMs2, -1);
  closeTo(negative.accelG, -1 / 9.80665);
});

test('stationary and constant-speed samples have zero acceleration', () => {
  for (const speedKmh of [0, 40]) {
    const tracker = signals.create();
    sample(tracker, { speedKmh });
    const value = sample(tracker, { speedKmh, seconds: 1 });
    assert.equal(value.accelMs2, 0);
    assert.equal(value.accelG, 0);
  }
});

test('re-reading one timestamp retains acceleration and its original speed baseline', () => {
  const tracker = signals.create();
  sample(tracker);
  sample(tracker, { seconds: 1, speedKmh: 3.6 });
  for (let count = 0; count < 4; count += 1) {
    const repeated = sample(tracker, { seconds: 1, speedKmh: 90 });
    closeTo(repeated.accelMs2, 1);
    assert.equal(repeated.status, 'valid');
  }
  closeTo(sample(tracker, { seconds: 2, speedKmh: 7.2 }).accelMs2, 1);
});

test('pause, idle and explicit reset require a fresh baseline before resuming', () => {
  for (const interruption of ['paused', 'idle', 'reset']) {
    const tracker = signals.create();
    sample(tracker);
    sample(tracker, { seconds: 1, speedKmh: 3.6 });
    if (interruption === 'reset') tracker.reset();
    else {
      const stopped = sample(tracker, { seconds: 1, phase: interruption, speedKmh: 80 });
      assert.equal(stopped.status, interruption);
      assert.equal(stopped.accelMs2, null);
    }
    const resumed = sample(tracker, { seconds: 1.1, speedKmh: 40 });
    assert.equal(resumed.status, 'warming');
    assert.equal(resumed.accelMs2, null);
    closeTo(sample(tracker, { seconds: 2.1, speedKmh: 43.6 }).accelMs2, 1);
  }
});

test('GPS gaps reject stale speed and warm up on the first valid sample', () => {
  for (const loss of [{ scenario: 'gps' }, { motion: 'gps' }]) {
    const tracker = signals.create();
    sample(tracker);
    sample(tracker, { seconds: 1, speedKmh: 10 });
    const gap = sample(tracker, { seconds: 1.5, speedKmh: 90, ...loss });
    assert.equal(gap.status, 'gap');
    assert.equal(gap.accelMs2, null);
    const restored = sample(tracker, { seconds: 2, speedKmh: 30 });
    assert.equal(restored.status, 'warming');
    assert.equal(restored.accelMs2, null);
    closeTo(sample(tracker, { seconds: 3, speedKmh: 30 }).accelMs2, 0);
  }
});

test('scenario changes and restarting the same scenario never produce switch spikes', () => {
  for (const change of [{ scenario: 'cruise' }, { scenarioStarted: 1 }]) {
    const tracker = signals.create();
    sample(tracker);
    sample(tracker, { seconds: 1, speedKmh: 3.6 });
    const switched = sample(tracker, { seconds: 1, speedKmh: 80, ...change });
    assert.equal(switched.status, 'warming');
    assert.equal(switched.accelMs2, null);
    closeTo(sample(tracker, { seconds: 2, speedKmh: 80, ...change }).accelMs2, 0);
  }
});

test('clock rollback and long gaps emit no acceleration spike', () => {
  for (const seconds of [.5, 8]) {
    const tracker = signals.create();
    sample(tracker);
    sample(tracker, { seconds: 1, speedKmh: 3.6 });
    const gap = sample(tracker, { seconds, speedKmh: 90 });
    assert.equal(gap.status, 'gap');
    assert.equal(gap.accelMs2, null);
    assert.equal(sample(tracker, { seconds, speedKmh: 90 }).status, 'gap');
    closeTo(sample(tracker, { seconds: seconds + 1, speedKmh: 90 }).accelMs2, 0);
  }
});

test('invalid numeric samples are gaps and do not poison the next baseline', () => {
  for (const invalid of [{ seconds: NaN }, { seconds: Infinity }, { seconds: -1 }, { speedKmh: NaN }, { speedKmh: -1 }, { scenarioStarted: NaN }]) {
    const tracker = signals.create();
    sample(tracker);
    const gap = sample(tracker, { seconds: 1, speedKmh: 3.6, ...invalid });
    assert.equal(gap.status, 'gap');
    assert.equal(gap.accelMs2, null);
    assert.equal(sample(tracker, { seconds: 2, speedKmh: 40 }).status, 'warming');
  }
});

test('inertial speed remains usable during a GPS gap when explicitly identified', () => {
  const tracker = signals.create();
  const input = { scenario: 'gps', motion: 'gps', source: 'inertial' };
  assert.equal(sample(tracker, input).status, 'warming');
  const reading = sample(tracker, { ...input, seconds: 1, speedKmh: 3.6 });
  assert.equal(reading.status, 'valid');
  closeTo(reading.accelMs2, 1);
  assert.equal(sample(tracker, { ...input, seconds: 1.5, speedKmh: null }).status, 'gap');
  assert.equal(sample(tracker, { ...input, seconds: 2, speedKmh: 10 }).status, 'warming');
});

test('source switches never turn correction jumps into acceleration', () => {
  for (const [before, after] of [['gps', 'inertial'], ['inertial', 'gps'], [undefined, 'inertial'], ['inertial', undefined]]) {
    const tracker = signals.create();
    sample(tracker, { source: before, speedKmh: 40 });
    sample(tracker, { source: before, seconds: 1, speedKmh: 40 });
    const switched = sample(tracker, { source: after, seconds: 1, speedKmh: 70 });
    assert.equal(switched.status, 'warming');
    assert.equal(switched.accelMs2, null);
    closeTo(sample(tracker, { source: after, seconds: 2, speedKmh: 70 }).accelMs2, 0);
  }
});

test('only supported signal sources can provide acceleration', () => {
  for (const inputSource of [null, 'sound', 'unknown', true]) {
    const tracker = signals.create();
    const reading = sample(tracker, { source: inputSource });
    assert.equal(reading.status, 'gap');
    assert.equal(reading.accelMs2, null);
  }
});

test('omitted and explicit GPS source are equivalent and output contains no engine metrics', () => {
  const tracker = signals.create();
  sample(tracker);
  const reading = sample(tracker, { source: 'gps', seconds: 1, speedKmh: 3.6 });
  closeTo(reading.accelMs2, 1);
  assert.deepEqual(Object.keys(reading).sort(), ['accelG', 'accelMs2', 'status']);
});
