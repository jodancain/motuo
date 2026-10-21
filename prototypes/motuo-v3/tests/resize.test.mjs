import test from 'node:test';
import assert from 'node:assert/strict';
import {createResizeController} from '../core/resize.js';
import {createMilestonePlayer} from '../render/milestone-player.js';
import {galleryPlan} from '../core/milestone-gallery.js';
import {stageLayout} from '../core/layout.js';

function rig(start = {W: 390, H: 844, dpr: 3}) {
  let size = {...start}, frames = [], timers = new Map(), id = 0;
  const live = [], settle = [];
  const c = createResizeController({measure: () => ({...size}), live: s => live.push(s), settle: s => settle.push(s),
    schedule: f => frames.push(f), setTimer: (f, ms) => { timers.set(++id, f); return id; }, clearTimer: i => timers.delete(i), settleMs: 160});
  return {c, live, settle, set: s => { size = {...size, ...s}; }, frame: () => { const fs = frames; frames = []; fs.forEach(f => f()); }, flush: () => { const ts = [...timers.values()]; timers.clear(); ts.forEach(f => f()); }, pendingTimers: () => timers.size};
}
test('旋转：同一帧内多次 resize 只做一次廉价版式；稳定后才重建一次缓冲', () => {
  const r = rig(); r.c.now();
  assert.equal(r.settle.length, 1);
  r.set({W: 844, H: 390});
  r.c.request(); r.c.request(); r.c.request();
  r.frame();
  assert.equal(r.live.length, 2, '首次 + 本帧一次'); assert.equal(r.settle.length, 1, '还没稳定，不重建缓冲');
  r.flush();
  assert.equal(r.settle.length, 2); assert.deepEqual(r.settle[1], {W: 844, H: 390, dpr: 3});
});
test('拖拽改尺寸：每帧最多一次 live，结束后只 settle 一次；尺寸没变不重建', () => {
  const r = rig(); r.c.now();
  for (let w = 400; w <= 840; w += 40) { r.set({W: w, H: 844 - (w - 400)}); r.c.request(); r.frame(); }
  const lives = r.live.length - 1;
  assert.equal(lives, 12); assert.equal(r.settle.length, 1); assert.equal(r.pendingTimers(), 1, '防抖计时器只保留一个');
  r.flush(); assert.equal(r.settle.length, 2);
  r.c.request(); r.frame(); r.flush();
  assert.equal(r.settle.length, 2, '尺寸没变：不重建缓冲');
  r.set({dpr: 2}); r.c.request(); r.frame(); r.flush();
  assert.equal(r.settle.length, 3, 'devicePixelRatio 变化也重建');
});
test('转回原尺寸（竖→横→竖在防抖窗口内完成）：最终尺寸与已应用相同，不做多余重建', () => {
  const r = rig(); r.c.now();
  r.set({W: 844, H: 390}); r.c.request(); r.frame();
  r.set({W: 390, H: 844}); r.c.request(); r.frame();
  r.flush();
  assert.equal(r.settle.length, 1);
  assert.deepEqual(r.live.at(-1), {W: 390, H: 844, dpr: 3}, 'live 版式回到原尺寸');
});
test('剧场旋转时按新布局继续：relayout 后仍在播、画布可见；结束或取消后清空隐藏', () => {
  const ctx = new Proxy(function () {}, {get: (t, k) => (k === Symbol.toPrimitive ? () => 1 : ctx), set: () => true, apply: () => ctx});
  const canvas = {width: 780, height: 1688, hidden: true, getContext: () => ctx};
  const p = createMilestonePlayer({canvas});
  assert.equal(p.relayout({}), false, '没有剧目时不做事');
  const env = (W, H) => ({W, H, L: stageLayout(W, H), point: () => ({x: W * .4, y: H * .7}), speedRect: {x: W * .5, y: 20, w: W * .4, h: H * .3}, dpr: 2});
  const plan = galleryPlan(0, {world: 'neon', tier: 2}); plan.startedAt = 0; plan.endsAt = plan.ms;
  p.play(plan, env(390, 844), 0);
  assert.equal(canvas.hidden, false);
  p.frame(plan.ms * .3);
  assert.equal(p.relayout(env(844, 390)), true);
  const cam = p.frame(plan.ms * .5);
  assert.ok(p.active && cam && Number.isFinite(cam.sceneScale)); assert.equal(canvas.hidden, false);
  p.frame(plan.ms * 1.01);
  assert.equal(p.active, null); assert.equal(canvas.hidden, true, '播完不残留');
});
