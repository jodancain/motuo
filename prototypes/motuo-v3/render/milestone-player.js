/* 速度突破剧场 · 播放器：把导演给的计划按层画到独立画布上，接入单 rAF、统一闪光限流与镜头。
 * v2（10/21 返工）：
 * - 舞台 = 整屏减去速度巨字保留区（evenodd 挖空），关键道具按屏高 30–50% 取尺寸。
 * - 分区：标签芯片 / 主文字 / 徽章 / 注释各有区域，竖屏互不重叠。
 * - 一次只突出一个主文字：剧目通过 e.say() 申请，播放器每帧只画优先级最高（同级取后开始）的一条。
 * - 车参与：剧目可导出 bike(p, e) 返回姿态增量（dz 前冲/后退、pitch 抬头、squash 压低、yaw 甩尾、shake），
 *   播放器汇总后交给 app 叠加到车的姿态上（车仍按 12fps 步进渲染）。
 * - 冲击帧：e.impact(key) 第一次调用时向统一限流器申请，结果缓存；被拒就不画冲击帧。
 * - 减少动态：只画一张静态卡片，不动画、不闪、不动镜头、不动车。页面隐藏：调用方 cancel()，返回不补播。 */
import {ACTS} from '../core/milestone-director.js';
import {bikeMapping, clampBikeShift, NO_SAFE, CAMERA} from '../core/layout.js';
import {WORLDS} from './worlds.js';
import {BIKE_POINTS} from './bike-vector.js';
import {paperWall, finishBanner, sonicCone, numberRace, compare} from './milestone-acts/stage.js';
import {triplePanel, stamp, achievement, danmaku, fireworks, label, newHigh, grandBanner, comeback} from './milestone-acts/comic.js';
import {dollyZoom, whipPan, bulletTime, numFire, numShatter, numFreeze, numNeon, world} from './milestone-acts/camera-numbers.js';
import {seg, text} from './milestone-acts/common.js';

export const ACT_DRAW = Object.freeze({
  'paper-wall': paperWall, 'finish-banner': finishBanner, 'sonic-cone': sonicCone, 'number-race': numberRace, 'compare': compare,
  'triple-panel': triplePanel, 'stamp': stamp, 'achievement': achievement, 'danmaku': danmaku, 'fireworks': fireworks,
  'dolly-zoom': dollyZoom, 'whip-pan': whipPan, 'bullet-time': bulletTime,
  'num-fire': numFire, 'num-shatter': numShatter, 'num-freeze': numFreeze, 'num-neon': numNeon,
  world, label, 'new-high': newHigh, 'grand-banner': grandBanner, comeback,
});
const TIER_K = [1, 1, 1.06, 1.12, 1.2, 1.25];
const IDLE_BIKE = Object.freeze({dz: 0, dy: 0, pitch: 0, yaw: 0, squash: 1, shake: 0});

/* 剧目环境：画布尺寸、版式、车锚点（当前姿态 / 静止基准）、舞台分区。 */
export function buildEnv(plan, {W, H, L, point: rawPoint, speedRect, particles = 1, seed = 1, hooks = {}, bikeImage = null, cameraSpace = false}) {
  const m = bikeMapping(L), landscape = L.landscape, unit = Math.min(W, H) / 390, sa = L.safe || NO_SAFE;
  // cameraSpace：车画在应用的 camera 层里（本帧平移 env.panPx + 1.06 缩放，原点 40%/70%）；剧场画布在外层，锚点按本帧镜头换到屏幕坐标。
  const ox = W * CAMERA.originX, oy = H * .7;
  const point = !rawPoint ? null : cameraSpace ? n => { const p = rawPoint(n); return {x: ox + (p.x - ox) * CAMERA.scale + (env.panPx || 0), y: oy + (p.y - oy) * CAMERA.scale}; } : rawPoint;
  const sp = speedRect, hole = {x: sp.x - 8, y: sp.y - 8, w: sp.w + 16, h: sp.h + 56};
  const holeBottom = Math.min(H, hole.y + hole.h);
  // 主舞台：横屏为速度区左侧整列（全高）；竖屏为速度区下方整片。另有横屏速度区下方的“副台”。
  const main = landscape ? {x: 0, y: 0, w: Math.max(200, hole.x - 6), h: H} : {x: 0, y: holeBottom, w: W, h: Math.max(160, H - holeBottom)};
  const under = landscape ? {x: hole.x, y: holeBottom, w: W - hole.x, h: Math.max(0, H - holeBottom)} : main;
  const bikeTop = L.bike.ground - m.ppu * 1.16;
  // 文字分区按安全区内缩。竖屏：车占下半屏，主文字放在车下方的路面带，注释在速度与车之间的窄带，都不压车身。
  const ground = L.bike.ground;
  const zones = landscape
    ? {label: {x: 10 + sa.l, y: 34 + sa.t, w: 230, h: 56}, title: {x: main.x + 20 + sa.l, y: 34 + 62 + sa.t, w: main.w - 40 - sa.l, h: Math.max(80, bikeTop - 96 - sa.t)}, badge: {x: under.x + 8, y: under.y + 4, w: under.w - 16 - sa.r, h: Math.min(140, under.h - 50)}, note: {x: under.x + 8, y: under.y + 6, w: under.w - 16 - sa.r, h: Math.min(110, under.h - 56)}}
    : {label: {x: 8 + sa.l, y: main.y + 4, w: W * .56, h: 56}, title: {x: 12 + sa.l, y: ground + 6, w: W - 24 - sa.l - sa.r, h: Math.max(56, H - sa.b - ground - 10)},
      badge: {x: W * .6, y: main.y + 2, w: W * .38 - sa.r, h: Math.max(48, Math.min(110, bikeTop - main.y - 6))}, note: {x: 12 + sa.l, y: main.y + 60, w: W - 24 - sa.l - sa.r, h: Math.max(40, bikeTop - main.y - 64)}};
  const base = name => { const q = BIKE_POINTS[name] || BIKE_POINTS.tank; return {x: m.sx(q[2]), y: m.sy(q[1])}; };
  const big = landscape ? H * .45 : Math.min(H * .34, main.h * .78);
  const impactCache = new Map();
  const env = {
    W, H, L, landscape, world: WORLDS[plan.world] || WORLDS.neon, th: plan.threshold, thText: String(plan.threshold), reading: plan.reading,
    tier: plan.tier, k: unit * TIER_K[plan.tier], unit, particles, seed: (seed + plan.threshold * 131) >>> 0, point, base, m, ppu: m.ppu,
    ground: L.bike.ground, roadTop: L.roadTop, horizon: L.horizon, bikeTop, speed: speedRect, hole, main, under, free: main, zones, big,
    title: plan.title, compare: plan.compare, simulated: plan.simulated, preview: plan.preview, newHigh: plan.newHigh, comeback: plan.comeback, main_: plan.main,
    actName: ACTS[plan.main]?.name || '', layers: plan.acts || [], flash: hooks.flash, shake: hooks.shake, bikeImage,
    // 主文字申请：本帧只画一条
    texts: [], order: 0,
    say(s, x, y, size, o = {}) { env.texts.push({s, x, y, size, o, prio: o.prio ?? 1, order: env.order}); },
    impact(key) { if (!impactCache.has(key)) impactCache.set(key, !!hooks.flash?.(key)); return impactCache.get(key); },
  };
  env.main = env.main_; delete env.main_;
  env.stage = main;
  return env;
}

function drawTitle(ctx, env) {
  if (!env.texts.length) return null;
  const t = env.texts.reduce((a, b) => (b.prio > a.prio || (b.prio === a.prio && b.order >= a.order) ? b : a));
  let {x, y, size} = t;
  // 竖屏：主文字限定在主文字区，不压标签芯片与徽章
  if (!env.landscape && !t.o.free) { const z = env.zones.title; size = Math.min(size, z.h * .9 + 30, env.W * .22); y = Math.max(z.y + size * .5, Math.min(y, z.y + z.h - size * .2)); }
  text(ctx, t.s, x, y, size, {fill: env.world.y, ghost: [env.world.c, env.world.m], rot: -.08, maxWidth: (env.landscape ? env.stage.w : env.W) * .9, ...t.o});
  return t.s;
}

/* 按总进度 P 画一帧；返回合成的镜头参数（含车姿态增量 bike）。skip 可跳过某些层（漫画定格不画标签）。 */
export function drawPlan(ctx, plan, P, env, {skip = [], camera = true, hole = camera} = {}) {
  const cam = {sceneScale: 1, panX: 0, timeScale: 1, desat: 0, bike: {...IDLE_BIKE}};
  env.texts = [];
  ctx.save();
  const h = env.hole;
  ctx.beginPath(); ctx.rect(0, 0, env.W, env.H); ctx.rect(h.x, h.y, h.w, h.h); ctx.clip('evenodd');
  // 本帧镜头平移先算出来（夹过出画），锚点与空洞都按它对齐，快速甩镜时也不差一帧。
  if (camera) {
    let pan = 0;
    plan.layers.forEach(layer => { const act = ACT_DRAW[layer.act]; if (act?.camera && !skip.includes(layer.act) && P >= layer.from && P <= layer.to) pan += act.camera(seg(P, layer.from, layer.to), env).panX ?? 0; });
    env.panPx = env.L ? clampBikeShift(env.L, pan * env.W, {W: env.W}) : pan * env.W;
  } else env.panPx = 0;
  // 给车让位：车身核心区（随车当前姿态）也挖空，道具与文字只能碰到车身外缘。分两次裁切，两个空洞重叠时也正确。
  const bh = env.bikeHole = bikeHole(env);
  if (bh && hole) { ctx.beginPath(); ctx.rect(0, 0, env.W, env.H); ctx.rect(bh.x, bh.y, bh.w, bh.h); ctx.clip('evenodd'); }
  const grand = plan.tier >= 4;
  plan.layers.forEach((layer, i) => {
    if (skip.includes(layer.act)) return;
    const act = ACT_DRAW[layer.act]; if (!act) return;
    if (P < layer.from || P > layer.to) return;
    const p = seg(P, layer.from, layer.to);
    if (camera && act.camera) { const c = act.camera(p, env); cam.sceneScale *= c.sceneScale ?? 1; cam.panX += c.panX ?? 0; cam.timeScale = Math.min(cam.timeScale, c.timeScale ?? 1); cam.desat = Math.max(cam.desat, c.desat ?? 0); }
    if (camera && act.bike) { const b = act.bike(p, env); const k = grand && layer.act !== plan.main ? .8 : 1; cam.bike.dz += (b.dz || 0) * k; cam.bike.dy += b.dy || 0; cam.bike.pitch += (b.pitch || 0) * k; cam.bike.yaw += b.yaw || 0; cam.bike.squash *= b.squash || 1; cam.bike.shake += b.shake || 0; }
    // 叠加的镜头花活不写主文字（大事件同样），主剧目的字才是主角
    env.quiet = !!(layer.camera && layer.act !== plan.main);
    env.order = layer.from * 10 + i * .01;
    ctx.save(); try { act.draw(ctx, p, env); } finally { ctx.restore(); }
  });
  env.titleShown = drawTitle(ctx, env);
  ctx.restore();
  // 车出画 ≤15% 车长：先限制镜头平移，再限制剧目给的前冲/后退（夹到 12%，留余量）。
  if (env.L) {
    const panPx = clampBikeShift(env.L, cam.panX * env.W, {W: env.W});
    cam.panX = panPx / env.W;
    cam.bike.dz = (clampBikeShift(env.L, cam.bike.dz * env.ppu + panPx, {W: env.W}) - panPx) / env.ppu;
  }
  return cam;
}
/* 车身包围盒（当前姿态）：后轮外缘到前轮外缘、风挡顶到地面；返回内缩后的“空洞”，
 * 左右各内缩 5%、顶部内缩 8%，所以道具最多覆盖车身包围盒的约 17%（外缘一圈，多是车轮上方的空角）。 */
export const BIKE_HOLE_INSET = Object.freeze({x: .05, top: .08});
export function bikeBody(env) {
  if (!env.point) return null;
  const q = n => env.point(n), ra = q('rearAxle'), fa = q('frontAxle'), ppu = env.ppu;
  const ys = ['tank', 'seat', 'headlight', 'exhaust'].map(n => q(n).y);
  const x0 = Math.min(ra.x, fa.x) - .335 * ppu, x1 = Math.max(ra.x, fa.x) + .301 * ppu;
  const y0 = Math.min(...ys) - .16 * ppu, y1 = Math.max(q('rearContact').y, q('frontContact').y);
  return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
}
function bikeHole(env) {
  const b = bikeBody(env); if (!b) return null;
  return {x: b.x + b.w * BIKE_HOLE_INSET.x, y: b.y + b.h * BIKE_HOLE_INSET.top, w: b.w * (1 - 2 * BIKE_HOLE_INSET.x), h: b.h * (1 - BIKE_HOLE_INSET.top)};
}

export function createMilestonePlayer({canvas, reduced = () => false, requestFlash = () => false, shake = () => {}}) {
  let plan = null, env = null, dpr = 1, flashed = new Set(), staticUntil = 0;
  const ctx = canvas.getContext('2d');
  const idle = {sceneScale: 1, panX: 0, timeScale: 1, desat: 0, bike: IDLE_BIKE};
  function clear() { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
  let hooks = null;
  function drawStatic() { clear(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); drawPlan(ctx, plan, .66, env, {camera: false, hole: true}); }
  return {
    play(next, envArgs, nowMs) {
      plan = next; flashed = new Set();
      hooks = {
        flash: kind => { if (flashed.has(kind) || flashed.size >= 2 || reduced()) return false; flashed.add(kind); return requestFlash(nowMs, 'milestone-' + kind); },
        shake: v => { if (!reduced()) shake(v); },
      };
      env = buildEnv(next, {...envArgs, hooks});
      dpr = envArgs.dpr || 1; canvas.hidden = false;
      if (reduced()) {
        // 静态卡片：主剧目在爆点之后的定格 + 标签，不动画
        drawStatic();
        staticUntil = nowMs + 1600;
      }
    },
    /* 旋转 / 改尺寸：剧目每帧按进度 P 从环境重画、没有逐帧内部状态，所以换成新尺寸的环境即可按新版式继续；
     * 已用过的冲击帧不会重放（flashed 保留）。 */
    relayout(envArgs) {
      if (!plan) return false;
      env = buildEnv(plan, {...envArgs, hooks});
      dpr = envArgs.dpr || 1;
      if (reduced()) drawStatic();
      return true;
    },
    // 每帧调用；返回镜头参数与车姿态增量。
    frame(nowMs) {
      if (!plan) return idle;
      if (reduced()) { if (nowMs > staticUntil) this.cancel(); return idle; }
      const P = (nowMs - plan.startedAt) / plan.ms;
      if (P >= 1) { this.cancel(); return idle; }
      clear(); if (P < 0) return idle;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return drawPlan(ctx, plan, P, env);
    },
    cancel() { plan = null; env = null; clear(); canvas.hidden = true; },
    get active() { return plan; }, get flashes() { return [...flashed]; }, get title() { return env?.titleShown || null; },
  };
}
