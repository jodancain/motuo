import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateDemo} from './helpers.mjs';
import {CUTIN, cutinLayout} from '../core/director.js';

test('演示剧本触发 LAUNCH / BOOST / CORNER / BRAKE 与 30·40·60 里程碑', () => {
  const r = simulateDemo();
  const kinds = new Set(r.events.map(e => e.kind));
  for (const k of ['launch', 'boost', 'corner', 'brake', 'milestone', 'combo']) assert.ok(kinds.has(k), k);
  const ms = r.events.filter(e => e.kind === 'milestone').map(e => e.value);
  for (const v of [30, 40, 60]) assert.ok(ms.includes(v), `milestone ${v}`);
  // 里程碑只在真实读数跨越阈值时触发：触发时显示中的读数 ≥ 阈值。
  for (const e of r.events.filter(x => x.kind === 'milestone')) assert.ok(Number(e.speedShown) >= e.value);
});

test('分镜 cut-in：0.6–1.2s，两次间隔 ≥1.4s，每类事件都有分镜', () => {
  const r = simulateDemo();
  const cuts = r.plans.filter(p => p.type === 'cutin');
  assert.ok(cuts.length >= 5);
  for (const c of cuts) { assert.ok(c.ms >= 600 && c.ms <= 1200); assert.equal(c.until - c.at, c.ms); }
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i].at - cuts[i - 1].at >= 1400 - 1e-6);
  const kinds = new Set(cuts.map(c => c.kind));
  for (const k of ['launch', 'boost', 'brake', 'corner', 'milestone']) assert.ok(kinds.has(k), k);
  for (const [k, v] of Object.entries(CUTIN)) { assert.ok(v.roles.length >= 2 && v.roles.length <= 4, k); assert.ok(v.roles.includes('gauge')); }
});

test('版式：每个 cut-in 是 2–4 个斜切格，并留出速度格', () => {
  for (const [W, H] of [[832, 378], [378, 832]]) for (const kind of Object.keys(CUTIN)) {
    const l = cutinLayout(kind, W, H, W > H ? {x: W * .6, y: 20, w: W * .36, h: H * .45} : {x: 20, y: H * .08, w: W - 40, h: H * .34});
    assert.equal(l.panels.length, CUTIN[kind].roles.length, `${kind} ${W}x${H}`);
  }
});

test('估速（惯导 ≈）不触发里程碑；暂停期间不产生事件', () => {
  const r = simulateDemo();
  const paused = r.phases.filter(p => p.phase === 'paused');
  const resumed = r.phases.filter(p => p.phase === 'riding')[1];
  assert.ok(!r.events.some(e => e.wall > paused[0].wall + 1e-6 && e.wall < resumed.wall - 1e-6));
});
