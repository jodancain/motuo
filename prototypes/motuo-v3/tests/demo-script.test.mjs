import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDemoScript, createDemoPlayer, DEMO_COUNTDOWN_S, DEMO_PAUSE_HOLD_S} from '../core/demo-script.js';
import {simulateDemo} from './helpers.mjs';

test('演示剧本：约 60 秒，1Hz 离散整数读数，全部标 DEMO', () => {
  const s = buildDemoScript();
  assert.equal(s.rateHz, 1);
  assert.ok(s.frames.every(f => f.simulated === true && f.source === 'gps' && Number.isInteger(f.t) && Number.isInteger(f.speedKmh) && f.speedKmh >= 0));
  s.frames.forEach((f, i) => { if (i) assert.equal(f.t - s.frames[i - 1].t, 1); });
  const finish = s.cues.find(c => c.type === 'finish'), pause = s.cues.find(c => c.type === 'pause');
  const total = DEMO_COUNTDOWN_S + finish.t + DEMO_PAUSE_HOLD_S;
  assert.ok(total >= 55 && total <= 65, `total ${total}s`);
  assert.ok(pause.t < finish.t);
  assert.ok(Math.max(...s.frames.map(f => f.speedKmh)) >= 60, '加速到 60+ km/h');
  for (const m of ['launch', 'turn', 'brake', 'stop']) assert.ok(s.frames.some(f => f.motion === m), m);
});

test('剧情顺序：倒计时 → 骑行 → 暂停 → 继续 → 结束，墙钟约 60s', () => {
  const r = simulateDemo();
  assert.deepEqual(r.phases.map(p => p.phase), ['countdown', 'riding', 'paused', 'riding', 'done']);
  assert.ok(Math.abs(r.phases[1].wall - DEMO_COUNTDOWN_S) < .05);
  const pauseLen = r.phases[3].wall - r.phases[2].wall;
  assert.ok(Math.abs(pauseLen - DEMO_PAUSE_HOLD_S) < .05, `pause ${pauseLen}`);
  assert.ok(r.wall > 58 && r.wall < 62, `wall ${r.wall}`);
  assert.ok(r.record?.summary, '生成骑行记录');
});

test('播放器整帧发出读数（不插值），跳过倒计时立即出发', () => {
  const s = buildDemoScript(), got = [];
  const p = createDemoPlayer(s, {reading: f => got.push(f)});
  p.start(); p.skipCountdown();
  assert.equal(p.phase, 'riding'); assert.equal(got.length, 1);
  for (let i = 0; i < 37; i++) p.advance(1 / 30);
  assert.deepEqual(got.map(f => f.t), [0, 1]);
  assert.ok(got.every(f => s.frames.includes(f)));
});

test('手动暂停需要手动继续', () => {
  const p = createDemoPlayer(buildDemoScript(), {});
  p.start(); p.skipCountdown(); p.advance(.1); p.hold();
  for (let i = 0; i < 300; i++) p.advance(.1);
  assert.equal(p.phase, 'paused'); p.release(); assert.equal(p.phase, 'riding');
});
