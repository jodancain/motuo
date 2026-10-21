import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {simulateDemo, root} from './helpers.mjs';
import {CUTIN, cutinLayout, speedReserved} from '../core/director.js';
import {stageLayout, speedFit} from '../core/layout.js';
import {speedText} from '../core/ride-model.js';

const css = readFileSync(new URL('styles.css', root), 'utf8');
const z = sel => Number(new RegExp(`\\${sel}\\{[^}]*z-index:(\\d+)`).exec(css)?.[1]);

test('速度层 z 序高于所有特效层（分镜、翻页、闪光、倒计时、拟声字、暂停箭头、字幕）', () => {
  const speed = z('.speed');
  assert.ok(speed > 0);
  for (const sel of ['.cutin', '.flip', '.flash', '.countdown', '.sfx-layer', '.tbc', '.caption', '.grain', '.bike-hit']) assert.ok(z(sel) < speed, `${sel} ${z(sel)} < ${speed}`);
});

function speedRectFor(W, H, digits = 2) {
  const L = stageLayout(W, H), f = speedFit(L, digits);
  const w = digits * f.fontSize * .794 * f.scaleX;
  return {x: W - L.speed.right - w, y: L.speed.top, w, h: f.boxHeight};
}
test('所有分镜版式在横/竖屏都给速度留整格，其他格不碰速度框', () => {
  for (const [W, H] of [[832, 378], [378, 832], [1180, 820], [820, 1180], [667, 375]]) for (const kind of Object.keys(CUTIN)) for (const d of [1, 2, 3]) {
    const rect = speedRectFor(W, H, d);
    assert.ok(speedReserved(cutinLayout(kind, W, H, rect), rect), `${kind} ${W}x${H} digits ${d}`);
  }
});

test('速度巨字高度 ≥ 屏高 35%（两位数，横屏与竖屏）', () => {
  for (const [W, H] of [[832, 378], [378, 832], [844, 390], [390, 844]]) {
    const f = speedFit(stageLayout(W, H), 2);
    assert.ok(f.boxHeight / H >= .35, `${W}x${H}: ${(f.boxHeight / H).toFixed(3)}`);
    assert.ok(f.scaleX >= .52);
  }
});

test('逐帧模拟：最长不可读（被遮挡）时段 0ms ≤ 150ms；显示值只来自读数', () => {
  const r = simulateDemo();
  const allowed = new Set(r.frames.map(f => String(Math.round(f.speedKmh))).concat('—'));
  let worst = 0, run = 0, last = null;
  const rect = speedRectFor(832, 378);
  for (const s of r.shown) {
    assert.ok(allowed.has(s.text), `显示 ${s.text} 不是任何读数`);
    // 遮挡 = 有分镜且版式未给速度留格。速度层 z 序在上，故分镜期间也计为可读。
    const occluded = s.cutin && !speedReserved(cutinLayout('corner', 832, 378, rect), rect);
    run = occluded && last ? run + (s.wall - last) * 1000 : 0;
    worst = Math.max(worst, run); last = s.wall;
  }
  assert.ok(worst <= 150, `worst ${worst}`);
  assert.equal(worst, 0);
});

test('速度文本：取整、未知为 “—”、惯导标估计、待机为 0，不做插值', () => {
  assert.deepEqual(speedText({phase: 'riding', reading: {speedKmh: 63.6, source: 'gps'}}), {text: '64', known: true, estimated: false});
  assert.equal(speedText({phase: 'riding', reading: {speedKmh: 40.2, source: 'inertial'}}).estimated, true);
  assert.equal(speedText({phase: 'riding', reading: {speedKmh: null, source: 'unavailable'}}).text, '—');
  assert.deepEqual(speedText({phase: 'paused', reading: {speedKmh: 30.4, source: 'gps'}}), {text: '30', known: true, estimated: false, frozen: true});
  assert.equal(speedText({phase: 'paused', reading: null}).text, '—');
  assert.equal(speedText({phase: 'idle'}).text, '0');
  const r = simulateDemo();
  // 显示值只在读数到达的那一帧改变。
  const changes = r.shown.filter((s, i) => i && s.text !== r.shown[i - 1].text && s.phase === 'riding');
  const readingWalls = r.frames.map(f => f.wall);
  for (const c of changes) assert.ok(readingWalls.some(w => Math.abs(w - c.wall) < 1 / 60 + 1e-6) || c.text === '—', `change at ${c.wall}`);
});
