import test from 'node:test';
import assert from 'node:assert/strict';
import {createPerfGovernor, TIER_CONFIG} from '../core/loop.js';

const feed = (g, ms, total) => { for (let t = 0; t < total; t += ms) g.feed(ms); };
test('三档自动降级：持续慢帧逐档降，带滞回升档', () => {
  const g = createPerfGovernor(), changes = [];
  g.onChange((t, why) => changes.push([t, why]));
  feed(g, 16.7, 3000); assert.equal(g.tier, 'high');
  feed(g, 30, 2500); assert.equal(g.tier, 'mid');
  feed(g, 30, 2000); assert.equal(g.tier, 'low');
  feed(g, 16.7, 4000); assert.equal(g.tier, 'low', '4s 快帧不足以升档');
  feed(g, 16.7, 4000); assert.equal(g.tier, 'mid');
  feed(g, 20, 20000); assert.equal(g.tier, 'mid', '临界区不来回跳');
  assert.ok(changes.every(([, why]) => ['slow-frames', 'recovered'].includes(why)));
});
test('手动固定档位不受帧时影响；原生热压力封顶为中档', () => {
  const g = createPerfGovernor();
  g.setMode('low'); feed(g, 10, 20000); assert.equal(g.tier, 'low');
  g.setMode('auto'); g.setCap('mid'); feed(g, 10, 20000); assert.equal(g.tier, 'mid');
  g.setCap(null); feed(g, 10, 7000); assert.equal(g.tier, 'high');
});
test('长间隔（切后台）不计入；低档关闭套印与纸纹、降粒子与分辨率', () => {
  const g = createPerfGovernor(); for (let i = 0; i < 30; i++) g.feed(5000); assert.equal(g.tier, 'high');
  assert.equal(TIER_CONFIG.low.misprint, false); assert.equal(TIER_CONFIG.low.grain, false);
  assert.ok(TIER_CONFIG.low.particles < TIER_CONFIG.mid.particles && TIER_CONFIG.mid.particles < TIER_CONFIG.high.particles);
  assert.ok(TIER_CONFIG.low.dpr < TIER_CONFIG.high.dpr);
});
