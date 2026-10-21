import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlashLimiter, maxFlashesPerSecond, createDirector} from '../core/director.js';
import {simulateDemo} from './helpers.mjs';

test('统一闪光限流：任意 1 秒 ≤ 2 次（WCAG 2.3.1 上限 3）', () => {
  const l = createFlashLimiter({maxPerSecond: 2});
  const ok = []; for (let t = 0; t < 3000; t += 50) if (l.allow(t)) ok.push(t);
  assert.ok(maxFlashesPerSecond(ok) <= 2);
  assert.equal(maxFlashesPerSecond([0, 100, 200, 1300]), 3);
  assert.equal(maxFlashesPerSecond([0, 1000, 2000]), 1);
});

test('整段演示：冲击帧 + GO 闪光每秒最多 2 次', () => {
  const r = simulateDemo();
  const times = r.limiter.log.map(x => x.t);
  assert.ok(times.length >= 3);
  assert.ok(maxFlashesPerSecond(times) <= 2);
  const cut = r.plans.filter(p => p.type === 'cutin');
  assert.ok(cut.some(p => p.impact), '至少一次冲击帧');
});

test('预算用尽时 cut-in 仍出现但不闪（impact=false）', () => {
  const l = createFlashLimiter({maxPerSecond: 2});
  l.allow(0, 'x'); l.allow(10, 'y');
  const d = createDirector({limiter: l, minGapMs: 0});
  const p = d.event({kind: 'boost'}, 20);
  assert.equal(p.type, 'cutin'); assert.equal(p.impact, false);
});
