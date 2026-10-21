// 突破剧场视觉返工的契约：车参与、舞台尺寸、一次一个主文字、画廊细条、加载过场。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ACT_IDS, buildPlan} from '../core/milestone-director.js';
import {galleryPlan, GALLERY_ITEMS} from '../core/milestone-gallery.js';
import {stageLayout} from '../core/layout.js';
import {rng} from '../core/geometry.js';
import {createDom} from './fake-dom.mjs';
import {root} from './helpers.mjs';

const setup = async () => {
  const dom = createDom(); globalThis.document = dom.doc;
  const P = await import('../render/milestone-player.js'), S = await import('../render/milestone-acts/stage.js');
  const ctx = new Proxy({}, {get: (t, k) => (k === 'measureText' ? s => ({width: String(s).length * 10}) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; }});
  return {P, S, ctx, done: () => { delete globalThis.document; }};
};
const sizes = [[832, 378, {x: 560, y: 20, w: 250, h: 150}], [378, 832, {x: 20, y: 70, w: 338, h: 300}]];
const envFor = (P, plan, [W, H, speedRect]) => P.buildEnv(plan, {W, H, L: stageLayout(W, H), point: () => ({x: W * .4, y: H * .6}), speedRect, particles: 1, hooks: {flash: () => true}});

test('车要参与：17 种剧目都会让车动（前冲/后退/抬头/压低/甩尾/震动），幅度有界', async () => {
  const {P, done} = await setup();
  for (const id of ACT_IDS) for (const sz of sizes) {
    const act = P.ACT_DRAW[id]; assert.equal(typeof act.bike, 'function', `${id} 没有车动作`);
    const env = envFor(P, buildPlan({threshold: 60, reading: 63, world: 'neon', rand: rng(1), forceAct: id}), sz);
    let moved = 0;
    for (let p = 0; p <= 1; p += .02) {
      const b = act.bike(p, env);
      if (Math.abs(b.dz || 0) > .05 || Math.abs(b.pitch || 0) > .03 || Math.abs((b.squash || 1) - 1) > .02 || Math.abs(b.yaw || 0) > .05 || (b.shake || 0) > .2 || Math.abs(b.dy || 0) > .005) moved++;
      assert.ok(Math.abs(b.dz || 0) <= 1.3 && (b.pitch || 0) >= -.35 && (b.pitch || 0) <= .15 && Math.abs(b.yaw || 0) <= .8, `${id} @${p.toFixed(2)} ${JSON.stringify(b)}`);
    }
    assert.ok(moved >= 5, `${id} 车几乎不动`);
  }
  done();
});

test('舞台：道具高度横屏 ≥ 屏高 50%、竖屏 ≥ 30%；后退距离不超过 1.25 车身单位', async () => {
  const {P, S, done} = await setup();
  for (const [i, sz] of sizes.entries()) {
    const env = envFor(P, buildPlan({threshold: 60, reading: 63, world: 'neon', rand: rng(1), forceAct: 'paper-wall'}), sz);
    const g = S.propGeom(env);
    assert.ok(g.h / sz[1] >= (i === 0 ? .5 : .3), `${sz[0]}x${sz[1]}: ${(g.h / sz[1]).toFixed(2)}`);
    assert.ok(g.backup >= -1.25 && g.backup <= 0);
    // 道具不进入速度保留区（横屏在速度区左侧；竖屏在速度区下方）
    if (i === 0) assert.ok(g.cx + g.w / 2 <= env.hole.x + 1); else assert.ok(g.top >= env.hole.y + env.hole.h - 1);
    assert.ok(env.big >= sz[1] * (i === 0 ? .44 : .3));
  }
  done();
});

test('一次只突出一个主文字：大事件横幅出现时压住剧目主文字，横幅收起后才轮到剧目', async () => {
  const {P, ctx, done} = await setup();
  for (const sz of sizes) {
    const plan = {...galleryPlan(GALLERY_ITEMS.indexOf('grand')), startedAt: 0};
    const env = envFor(P, plan, sz);
    const shown = [];
    for (let t = 0; t < plan.ms; t += 40) { P.drawPlan(ctx, plan, t / plan.ms, env); shown.push([t / plan.ms, env.titleShown]); }
    const banner = shown.filter(([, s]) => s && /大事件/.test(s)), acts = shown.filter(([, s]) => s && !/大事件/.test(s));
    assert.ok(banner.length > 3 && acts.length > 3, JSON.stringify(shown.slice(0, 12)));
    for (const [p] of acts) assert.ok(p > .27 && p < .84, `剧目主文字在横幅期间出现 @${p}`);
    // 每帧最多一条：texts 可以有多个申请，但只画一条
    assert.ok(shown.every(([, s]) => s === null || typeof s === 'string'));
  }
  done();
});

test('画廊控制条默认收起为细条；GLB 未就绪先显示 LOADING 卡片、不先闪矢量回退车', () => {
  const html = readFileSync(new URL('index.html', root), 'utf8'), css = readFileSync(new URL('styles.css', root), 'utf8'), bike = readFileSync(new URL('render/bike.js', root), 'utf8');
  assert.match(html, /id="gallery" class="gallery" data-open="false"/);
  assert.match(html, /class="g-bar"><button id="g-prev"[^]*id="g-name"[^]*id="g-next"[^]*id="g-more"/);
  assert.match(css, /\.g-more-panel\{display:none/);
  assert.match(css, /\.gallery\[data-open=true\] \.g-more-panel\{display:flex\}/);
  assert.match(html, /data-bike="loading"/); assert.match(html, /id="loading"[^>]*><b>LOADING…<\/b>/);
  assert.match(bike, /glCanvas\.hidden = true; vecCanvas\.hidden = true;/);
});
