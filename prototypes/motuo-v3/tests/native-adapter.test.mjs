import test from 'node:test';
import assert from 'node:assert/strict';
import {mapSnapshot, NATIVE_STALE_MS, installNativeAdapter} from '../native-adapter.js';

const snap = (o = {}) => ({phase: 'riding', seconds: 12, distanceM: 140, speedKmh: 42.4, sampleTime: 101.5, speedSource: 'gps', motion: 'cruise', simulated: false, ...o});
test('快照映射为读数帧：保留 sampleTime 与来源，不改写数值', () => {
  const m = mapSnapshot(snap(), {receivedAt: 0, now: 100});
  assert.deepEqual(m.frame, {t: 101.5, speedKmh: 42.4, source: 'gps', simulated: false, motion: 'cruise', uncertaintyKmh: null});
  assert.equal(m.distanceM, 140); assert.equal(m.elapsedS, 12);
});
test('惯导 → inertial；无效、过期、非骑行 → 不给速度', () => {
  assert.equal(mapSnapshot(snap({speedSource: 'inertial', uncertaintyKmh: 3}), {}).frame.source, 'inertial');
  assert.equal(mapSnapshot(snap({speedSource: 'unavailable'}), {}).frame.speedKmh, null);
  assert.equal(mapSnapshot(snap(), {receivedAt: 0, now: NATIVE_STALE_MS + 1}).frame.speedKmh, null);
  assert.equal(mapSnapshot(snap({phase: 'paused'}), {}).frame, null);
  assert.equal(mapSnapshot({phase: 'weird'}), null);
  assert.equal(mapSnapshot(snap({motion: 'warp'}), {}).frame.motion, 'ready');
});
test('声浪只在 live 且非暂停时有效；32 段频谱折成 16 段', () => {
  const m = mapSnapshot(snap({sound: {live: true, level: .5, spectrum: Array(32).fill(.4)}}), {});
  assert.equal(m.sound.valid, true); assert.equal(m.sound.bands.length, 16); assert.ok(Math.abs(m.sound.bands[3] - .4) < 1e-9);
  assert.equal(mapSnapshot(snap({phase: 'paused', sound: {live: true}}), {}).sound.valid, false);
});
test('MotuoNativeReceive：同一 sampleTime 只计一次；finishedRide 只处理一次并回传 wrappedShown', () => {
  const sent = [], calls = [];
  const win = {webkit: {messageHandlers: {motuo: {postMessage: m => sent.push(m.action)}}}, setInterval() {}};
  globalThis.performance ??= {now: () => 0};
  const app = {nativePhase: (p, o) => calls.push(['phase', p, o]), nativeFlags() {}, nativeReading: f => calls.push(['reading', f.t]), nativeFinished: f => calls.push(['finished', f.id]), nativeStale() {}};
  const a = installNativeAdapter(app, win);
  assert.equal(a.native, true);
  win.MotuoNativeReceive(snap()); win.MotuoNativeReceive(snap()); win.MotuoNativeReceive(snap({sampleTime: 102.5}));
  const fr = {id: 'r1', distanceM: 1, durationS: 2, maxSpeedKmh: 3};
  win.MotuoNativeReceive(snap({phase: 'idle', finishedRide: fr})); win.MotuoNativeReceive(snap({phase: 'idle', finishedRide: fr}));
  assert.deepEqual(calls.filter(c => c[0] === 'reading').map(c => c[1]), [101.5, 102.5]);
  assert.equal(calls.filter(c => c[0] === 'finished').length, 1);
  assert.deepEqual(sent, ['ready', 'wrappedShown']);
});
