import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../inertial-speed.js', import.meta.url), 'utf8'), sandbox);
const { create } = sandbox.window.MotuoInertialSpeed;
const imu = (accelForwardMps2 = 0) => ({ valid: true, calibrated: true, accelForwardMps2 });
const gps = (speedMps = 10, accuracyMps = 0.5) => ({ valid: true, speedMps, accuracyMps });
const update = (tracker, time, overrides = {}) => tracker.update({ active: true, time, imu: imu(), ...overrides });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} !== ${expected}`);

test('fresh GPS is returned exactly and establishes speed and uncertainty', () => {
  const tracker = create();
  const result = update(tracker, 0, { gps: gps(12.345, 0.7) });
  close(result.speedKmh, 12.345 * 3.6);
  close(result.uncertaintyKmh, 0.7 * 3.6);
  assert.equal(result.source, 'gps');
  assert.equal(result.ageSeconds, 0);
  assert.equal(result.confidence, 'high');
});

test('first GPS-outage interval and uneven subsequent intervals use trapezoidal integration', () => {
  const tracker = create();
  update(tracker, 2, { gps: gps(), imu: imu(1) });
  const first = update(tracker, 2.2, { imu: imu(3) });
  close(first.speedKmh, 10.4 * 3.6);
  assert.equal(first.source, 'inertial');
  close(first.ageSeconds, 0.2);
  close(update(tracker, 2.5, { imu: imu(-1) }).speedKmh, 10.7 * 3.6);
});

test('no GPS anchor means no speed even with valid IMU or a stationary flag', () => {
  const tracker = create();
  for (const stationaryConfirmed of [false, true]) {
    const result = update(tracker, 0.1, { imu: imu(2), stationaryConfirmed });
    assert.equal(result.speedKmh, null);
    assert.equal(result.reason, 'no_gps_anchor');
  }
});

test('zero acceleration preserves motion and does not infer stationary', () => {
  const tracker = create();
  update(tracker, 0, { gps: gps(20) });
  close(update(tracker, 0.2).speedKmh, 72);
  const stopped = update(tracker, 0.4, { stationaryConfirmed: true });
  assert.equal(stopped.speedKmh, 0);
  assert.equal(stopped.source, 'inertial');
  assert.equal(stopped.reason, 'stationary_confirmed');
  assert.equal(stopped.ageSeconds, 0.4);
});

test('braking cannot integrate below zero', () => {
  const tracker = create();
  update(tracker, 0, { gps: gps(0.1), imu: imu(-4) });
  assert.equal(update(tracker, 0.5, { imu: imu(-4) }).speedKmh, 0);
});

test('GPS recovery replaces the estimate immediately, including the same timestamp', () => {
  const tracker = create();
  update(tracker, 0, { gps: gps() });
  update(tracker, 0.2, { imu: imu(2) });
  const restored = update(tracker, 0.2, { gps: gps(5, 0.2), stationaryConfirmed: true });
  close(restored.speedKmh, 18);
  close(restored.uncertaintyKmh, 0.72);
  assert.equal(restored.source, 'gps');
  assert.equal(restored.ageSeconds, 0);
  close(update(tracker, 0.3).speedKmh, 18);
});

test('duplicate IMU timestamps do not integrate twice or replace the previous acceleration', () => {
  const tracker = create();
  update(tracker, 0, { gps: gps(), imu: imu(2) });
  const first = update(tracker, 0.2, { imu: imu(2) });
  assert.deepEqual(update(tracker, 0.2, { imu: imu(20) }), first);
  close(update(tracker, 0.4, { imu: imu(2) }).speedKmh, 10.8 * 3.6);
});

test('uncertainty grows with elapsed time and integration, confidence degrades', () => {
  const tracker = create();
  let result = update(tracker, 0, { gps: gps() });
  for (let time = 0.5; time <= 15; time += 0.5) {
    const next = update(tracker, time);
    assert.equal(next.source, 'inertial');
    assert.ok(next.uncertaintyKmh > result.uncertaintyKmh);
    result = next;
  }
  assert.equal(result.confidence, 'low');
  assert.equal(result.ageSeconds, 15);
  assert.equal(update(tracker, 15.001).reason, 'estimate_expired');
  assert.equal(update(tracker, 15.1).speedKmh, null);
});

test('uncertainty ceiling stops the estimate and remains stopped until a new GPS sample', () => {
  const tracker = create({ maxUncertaintyKmh: 2 });
  update(tracker, 0, { gps: gps() });
  update(tracker, 0.5);
  const exceeded = update(tracker, 1);
  assert.equal(exceeded.reason, 'uncertainty_exceeded');
  assert.equal(exceeded.speedKmh, null);
  assert.equal(update(tracker, 1.1, { stationaryConfirmed: true }).reason, 'uncertainty_exceeded');
  assert.equal(update(tracker, 1.2, { gps: gps() }).source, 'gps');
});

test('IMU sampling gap boundary is inclusive and a missed interval permanently invalidates that anchor', () => {
  const tracker = create();
  update(tracker, 0, { gps: gps() });
  assert.equal(update(tracker, 0.5).source, 'inertial');
  const gap = update(tracker, 1.001);
  assert.equal(gap.reason, 'imu_gap');
  assert.equal(gap.speedKmh, null);
  assert.equal(update(tracker, 1.1).reason, 'imu_gap');
  assert.equal(update(tracker, 1.2, { gps: gps() }).source, 'gps');
});

test('missing, uncalibrated and invalid IMU cannot silently coast through a gap', () => {
  for (const invalid of [null, { ...imu(), calibrated: false }, { ...imu(), valid: false }, imu(NaN), imu(Infinity), imu(31)]) {
    const tracker = create();
    update(tracker, 0, { gps: gps() });
    const bad = update(tracker, 0.1, { imu: invalid });
    assert.equal(bad.source, 'unavailable');
    assert.equal(bad.speedKmh, null);
    assert.equal(update(tracker, 0.2).reason, bad.reason);
  }
  const missingBaseline = create();
  update(missingBaseline, 0, { gps: gps(), imu: null });
  assert.equal(update(missingBaseline, 0.1).reason, 'imu_baseline_missing');
});

test('invalid GPS never becomes an anchor', () => {
  for (const invalid of [gps(NaN), gps(Infinity), gps(-1), gps(101), gps(10, -1), gps(10, NaN), { ...gps(), valid: false }]) {
    const tracker = create();
    assert.equal(update(tracker, 0, { gps: invalid }).reason, 'no_gps_anchor');
    assert.equal(update(tracker, 0.1).speedKmh, null);
  }
});

test('invalid time, clock rollback, pause and reset clear the old anchor', () => {
  for (const interruption of ['reset', 'pause', NaN, Infinity, -1, 0.5]) {
    const tracker = create();
    update(tracker, 1, { gps: gps() });
    if (interruption === 'reset') tracker.reset();
    else if (interruption === 'pause') assert.equal(update(tracker, 1.1, { active: false }).reason, 'inactive');
    else {
      const bad = update(tracker, interruption, { gps: gps() });
      assert.equal(bad.speedKmh, null);
      assert.equal(bad.reason, interruption === 0.5 ? 'time_discontinuity' : 'invalid_time');
    }
    assert.equal(update(tracker, 2).speedKmh, null);
    assert.equal(update(tracker, 3, { gps: gps() }).source, 'gps');
  }
});

test('caller mutations of a returned result do not poison internal speed', () => {
  const tracker = create();
  const result = update(tracker, 0, { gps: gps() });
  result.speedKmh = 999;
  assert.equal(update(tracker, 0).speedKmh, 36);
  assert.equal(update(tracker, 0.1).speedKmh, 36);
});

test('invalid configuration is rejected and configured bounds are respected', () => {
  for (const value of [0, -1, NaN, Infinity, '15']) {
    assert.throws(() => create({ maxEstimateSeconds: value }), /finite positive/);
  }
  const tracker = create({ maxEstimateSeconds: 0.2, maxImuGapSeconds: 0.1 });
  update(tracker, 0, { gps: gps() });
  assert.equal(update(tracker, 0.1).source, 'inertial');
  assert.equal(update(tracker, 0.2).source, 'inertial');
  assert.equal(update(tracker, 0.201).reason, 'estimate_expired');
});

test('estimated speed beyond the configured envelope is invalid, not clipped into a plausible measurement', () => {
  const tracker = create({ maxSpeedMps: 11 });
  update(tracker, 0, { gps: gps(), imu: imu(10) });
  const result = update(tracker, 0.2, { imu: imu(10) });
  assert.equal(result.speedKmh, null);
  assert.equal(result.reason, 'speed_out_of_range');
});
