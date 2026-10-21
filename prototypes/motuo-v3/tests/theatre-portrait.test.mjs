// 竖屏（以及横屏）突破剧场与车的关系：车全程出画 ≤15% 车长；剧场的所有绘制都在“速度区 + 车身核心区”双空洞裁切里，
// 车身空洞占车身包围盒 ≥80%（道具最多碰到外缘一圈，约定 ≤25%）；竖屏数字道具与文字不出画。
import test from 'node:test';
import assert from 'node:assert/strict';
import {drawPlan, buildEnv, bikeBody, BIKE_HOLE_INSET} from '../render/milestone-player.js';
import {GALLERY_ITEMS, galleryPlan} from '../core/milestone-gallery.js';
import {stageLayout, bikeMapping, bikeOutRatio, clampBikeShift} from '../core/layout.js';
import {BIKE_POINTS} from '../render/bike-vector.js';
import {createRecordingCtx} from './recording-ctx.mjs';
import {createDom} from './fake-dom.mjs';

// 部分剧目会建离屏画布：用假 DOM（只记录、不栅格化）。
globalThis.document ??= createDom().doc;

const VIEWS = [
  {name: '竖屏 390×844（灵动岛安全区）', W: 390, H: 844, safe: {t: 59, r: 0, b: 34, l: 0}},
  {name: '竖屏 375×667（无安全区）', W: 375, H: 667, safe: {t: 0, r: 0, b: 0, l: 0}},
  {name: '横屏 844×390（左右安全区）', W: 844, H: 390, safe: {t: 0, r: 59, b: 21, l: 59}},
];
// 与应用一致：车锚点按上一帧剧目给的位移（夹过）移动，speedRect 取速度巨字盒（layout 给的右上角）。
function run(view, index) {
  const L = stageLayout(view.W, view.H, view.safe), m = bikeMapping(L);
  const speedRect = {x: view.W - L.speed.right - L.speed.maxWidth, y: L.speed.top, w: L.speed.maxWidth, h: L.speed.fontSize * L.speed.lineHeight};
  let shiftPx = 0;
  const point = n => { const q = BIKE_POINTS[n] || BIKE_POINTS.tank; return {x: m.sx(q[2]) + shiftPx, y: m.sy(q[1])}; };
  const plan = galleryPlan(index, {world: ['neon', 'sunset', 'snow', 'cosmic'][index % 4], tier: 2});
  const env = buildEnv(plan, {W: view.W, H: view.H, L, point, speedRect, particles: 1, seed: 7});
  const frames = [];
  for (let P = 0; P <= 1.0001; P += .02) {
    const ctx = createRecordingCtx();
    const cam = drawPlan(ctx, plan, Math.min(P, .999), env);
    shiftPx = clampBikeShift(L, cam.bike.dz * m.ppu + cam.panX * view.W);
    frames.push({P, out: bikeOutRatio(L, shiftPx), cam, ops: ctx.__ops ?? null, ctxRef: ctx, body: bikeBody(env), hole: env.bikeHole});
  }
  return {plan, frames, L, env};
}

for (const view of VIEWS) {
  test(`${view.name}：全部 ${GALLERY_ITEMS.length} 个剧目全程车出画 ≤15% 车长`, () => {
    for (let i = 0; i < GALLERY_ITEMS.length; i++) {
      const {frames} = run(view, i);
      const worst = Math.max(...frames.map(f => f.out));
      assert.ok(worst <= .15, `${GALLERY_ITEMS[i]} 出画 ${(worst * 100).toFixed(1)}%`);
    }
  });
  test(`${view.name}：剧场绘制全部落在给车让位的裁切里，车身空洞 ≥80% 包围盒`, () => {
    const holeShare = (1 - 2 * BIKE_HOLE_INSET.x) * (1 - BIKE_HOLE_INSET.top);
    assert.ok(holeShare >= .8, `空洞占比 ${holeShare}`);
    for (let i = 0; i < GALLERY_ITEMS.length; i++) {
      const plan = galleryPlan(i, {world: 'neon', tier: 2});
      const L = stageLayout(view.W, view.H, view.safe), m = bikeMapping(L);
      const point = n => { const q = BIKE_POINTS[n] || BIKE_POINTS.tank; return {x: m.sx(q[2]), y: m.sy(q[1])}; };
      const env = buildEnv(plan, {W: view.W, H: view.H, L, point, speedRect: {x: view.W * .5, y: 20, w: view.W * .4, h: 100}, particles: 1, seed: 7});
      const body = bikeBody(env);
      for (const P of [.1, .3, .5, .7, .9]) {
        const ops = [];
        const ctx = createRecordingCtx();
        const draw = new Proxy(ctx, {get: (t, k) => (['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText'].includes(k) ? (...a) => { ops.push({k, clips: t.__clips?.() }); return t[k](...a); } : t[k]), set: (t, k, v) => { t[k] = v; return true; }});
        drawPlan(draw, plan, P, env);
        const hole = env.bikeHole;
        // 空洞在车身包围盒里且占 ≥80%
        assert.ok(hole.x >= body.x - .5 && hole.x + hole.w <= body.x + body.w + .5 && hole.y >= body.y - .5, GALLERY_ITEMS[i]);
        assert.ok(hole.w * hole.h >= .8 * body.w * body.h - 1, `${GALLERY_ITEMS[i]} 空洞 ${(hole.w * hole.h / body.w / body.h).toFixed(2)}`);
      }
    }
  });
}
test('竖屏：每个绘制操作发生时都在双空洞裁切下（速度区 + 车身区），文字不出画、不落进车身空洞', () => {
  const view = VIEWS[0];
  for (let i = 0; i < GALLERY_ITEMS.length; i++) {
    const plan = galleryPlan(i, {world: ['neon', 'sunset', 'snow', 'cosmic'][i % 4], tier: 2});
    const L = stageLayout(view.W, view.H, view.safe), m = bikeMapping(L);
    const point = n => { const q = BIKE_POINTS[n] || BIKE_POINTS.tank; return {x: m.sx(q[2]), y: m.sy(q[1])}; };
    const env = buildEnv(plan, {W: view.W, H: view.H, L, point, speedRect: {x: 35, y: L.speed.top, w: 335, h: 265}, particles: 1, seed: 7});
    for (let P = .02; P < 1; P += .04) {
      const ctx = createRecordingCtx();
      drawPlan(ctx, plan, P, env);
      const hole = env.bikeHole;
      for (const op of ctx.ops()) {
        const holes = op.clips.filter(c => c.rule === 'evenodd').flatMap(c => c.rects.slice(1));
        assert.ok(holes.some(r => Math.abs(r.x - hole.x) < 1 && Math.abs(r.w - hole.w) < 1), `${GALLERY_ITEMS[i]} P=${P.toFixed(2)} ${op.kind} 不在车身空洞裁切下`);
        // 本帧的主文字（一次只有一条）：不出画，也不落在车身中心（否则会被空洞裁掉）。
        if (op.kind === 'text' && env.titleShown && op.s === env.titleShown) {
          assert.ok(op.y > -20 && op.y < view.H - view.safe.b + 20, `${GALLERY_ITEMS[i]} “${op.s}” y=${op.y.toFixed(0)} 出画`);
          const inCore = op.x > hole.x + hole.w * .2 && op.x < hole.x + hole.w * .8 && op.y > hole.y + hole.h * .25 && op.y < hole.y + hole.h * .9;
          assert.ok(!inCore, `${GALLERY_ITEMS[i]} “${op.s}” 落在车身中心（会被裁掉）`);
        }
      }
    }
  }
});
test('竖屏主文字区在车下方的路面带、注释带在速度与车之间，都在安全区内', () => {
  const view = VIEWS[0], L = stageLayout(view.W, view.H, view.safe), m = bikeMapping(L);
  const env = buildEnv(galleryPlan(0), {W: view.W, H: view.H, L, point: n => { const q = BIKE_POINTS[n]; return {x: m.sx(q[2]), y: m.sy(q[1])}; }, speedRect: {x: 35, y: L.speed.top, w: 335, h: 265}});
  const z = env.zones, body = bikeBody(env);
  assert.ok(z.title.y >= body.y + body.h - 1 && z.title.y + z.title.h <= view.H - view.safe.b + 1, JSON.stringify(z.title));
  assert.ok(z.note.y < body.y && z.note.y >= L.speed.top, JSON.stringify({note: z.note, bodyTop: body.y}));
  assert.ok(z.label.y >= view.safe.t);
});
test('车位移夹取：任意后退 / 前冲 / 镜头平移后出画都 ≤15%，静止时 0', () => {
  for (const view of VIEWS) {
    const L = stageLayout(view.W, view.H, view.safe);
    assert.equal(bikeOutRatio(L, 0), 0);
    for (const s of [-400, -200, -80, 0, 80, 200, 400]) assert.ok(bikeOutRatio(L, clampBikeShift(L, s)) <= .15 + 1e-9, `${view.name} ${s}`);
  }
});
