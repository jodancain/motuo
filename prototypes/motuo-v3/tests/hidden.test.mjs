import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoop} from '../core/loop.js';
import {createSfx} from '../audio/sfx.js';
import {simulateDemo} from './helpers.mjs';
import {fakeClock} from './fake-dom.mjs';

test('页面隐藏：单 rAF 停止、任务不再执行；恢复后继续', () => {
  const c = fakeClock(); let hidden = false, calls = 0;
  const loop = createLoop({raf: c.raf, caf: c.caf, now: c.now, hidden: () => hidden});
  loop.add(() => { calls++; }); loop.add(() => {}, {fps: 12});
  c.run(500); const before = calls; assert.ok(before > 20);
  hidden = true; loop.visibilityChanged(); c.run(500);
  assert.equal(calls, before); assert.equal(loop.running, false); assert.equal(c.pending(), 0);
  hidden = false; loop.visibilityChanged(); c.run(200);
  assert.ok(calls > before); assert.ok(c.pending() <= 1, '始终只有一个 rAF 在排队');
});

test('一拍二：fps 任务按 12fps 步进，背景每帧', () => {
  const c = fakeClock(); let a = 0, b = 0;
  const loop = createLoop({raf: c.raf, caf: c.caf, now: c.now});
  loop.add(() => { a++; }); loop.add(() => { b++; }, {fps: 12});
  c.run(1000);
  assert.ok(a >= 58 && a <= 61, `bg ${a}`); assert.ok(b >= 11 && b <= 13, `bike ${b}`);
});

test('隐藏期间演示时间冻结（总墙钟顺延隐藏时长）', () => {
  const normal = simulateDemo(), hidden = simulateDemo({hiddenBetween: [10, 15]});
  assert.ok(Math.abs((hidden.wall - normal.wall) - 5) < .1, `${hidden.wall} vs ${normal.wall}`);
  assert.deepEqual(hidden.frames.map(f => f.speedKmh), normal.frames.map(f => f.speedKmh));
});

test('UI 音效：隐藏挂起、显示恢复，可关闭', () => {
  const calls = [];
  globalThis.document = {hidden: false};
  class AC { constructor() { this.state = 'running'; this.sampleRate = 8000; this.currentTime = 0; this.destination = {}; }
    createGain() { return {gain: {value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}}, connect: x => x}; }
    createBuffer(c, n) { return {getChannelData: () => new Float32Array(n)}; }
    createOscillator() { return {frequency: {setValueAtTime() {}, exponentialRampToValueAtTime() {}}, connect: x => x, start() {}, stop() {}}; }
    suspend() { calls.push('suspend'); this.state = 'suspended'; return Promise.resolve(); }
    resume() { calls.push('resume'); this.state = 'running'; return Promise.resolve(); } }
  globalThis.AudioContext = AC;
  const s = createSfx({enabled: true});
  s.play('beep'); assert.equal(s.state, 'running');
  s.visibility(true); assert.equal(s.state, 'suspended');
  s.visibility(false); assert.equal(s.state, 'running');
  s.setEnabled(false); assert.equal(s.enabled, false); assert.deepEqual(calls, ['suspend', 'resume', 'suspend']);
  delete globalThis.AudioContext; delete globalThis.document;
});
