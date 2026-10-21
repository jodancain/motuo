// 速度突破剧场：选择、防刷、阶梯、今日新高、历史、对比表、遮挡、闪光、减少动态、漫画、画廊、隐藏、演示剧本。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMilestoneDirector, buildPlan, tierFor, THRESHOLDS, DURATION_MS, ACT_IDS, HISTORY_KEY, COOLDOWN_MS, REARM_BELOW_KMH, dateKey} from '../core/milestone-director.js';
import {COMPARISONS, overtaken, approxLabel, ACCESSED} from '../data/speed-comparisons.js';
import {GALLERY_ITEMS, galleryPlan} from '../core/milestone-gallery.js';
import {buildDemoScript, createDemoPlayer} from '../core/demo-script.js';
import {selectMoments, captionFor} from '../core/comic-layout.js';
import {createRideModel} from '../core/ride-model.js';
import {createFlashLimiter, maxFlashesPerSecond} from '../core/director.js';
import {stageLayout} from '../core/layout.js';
import {rng} from '../core/geometry.js';
import {createDom} from './fake-dom.mjs';
import {loadShared, root} from './helpers.mjs';

const memStorage = () => { const m = new Map(); let writes = 0; return {getItem: k => m.get(k) ?? null, setItem: (k, v) => { writes++; m.set(k, String(v)); }, get writes() { return writes; }, map: m}; };
const gps = (t, v, extra = {}) => ({t, speedKmh: v, source: 'gps', simulated: false, world: 'neon', ...extra});

// 逐秒喂读数（时间 = t 秒），返回全部计划
function feed(dir, speeds, {t0 = 0, simulated = false, source = 'gps', step = 1} = {}) {
  const out = [];
  speeds.forEach((v, i) => { const t = t0 + i * step; const p = dir.reading({t, speedKmh: v, source, simulated, world: 'neon'}, t * 1000); if (p) out.push(p); const q = dir.update(t * 1000 + 500); if (q) out.push(q); for (let k = 1; k <= 4; k++) { const r = dir.update(t * 1000 + 500 + k * 120); if (r) out.push(r); } });
  return out;
}
const ramp = (a, b, s = 3) => { const r = []; for (let v = a; v <= b; v += s) r.push(v); return r; };

test('剧目选择：带种子可复现；连续两次不同；一次骑行内先用完剧目池再重复', () => {
  const plansFor = seed => { const d = createMilestoneDirector({seed}); d.begin(); return feed(d, ramp(0, 205, 2), {step: 2}).filter(p => !p.comeback); };
  const run = seed => plansFor(seed).map(p => p.main);
  const a = run(5), b = run(5), c = run(6);
  assert.deepEqual(a, b, '同一种子同一结果');
  assert.notDeepEqual(a, c);
  for (let i = 1; i < a.length; i++) assert.notEqual(a[i], a[i - 1]);
  // 单次骑行内：只有在此前的演出已用过（几乎）整个剧目池之后，主剧目才会重复
  for (const seed of [5, 6, 7, 8]) {
    const plans = plansFor(seed), seen = new Set();
    plans.forEach((p, i) => {
      if (plans.slice(0, i).some(q => q.main === p.main)) assert.ok(seen.size >= ACT_IDS.length - 2, `seed ${seed}: ${p.main} 在只用过 ${seen.size} 种时重复`);
      for (const x of p.acts) seen.add(x);
    });
  }
  for (let s = 1; s < 40; s++) { const r = run(s); for (let i = 1; i < r.length; i++) assert.notEqual(r[i], r[i - 1]); }
});

test('阶梯：越高越隆重；100 为大事件（三幕串联 + 子弹时间 + 横幅）；>100 为传说级', () => {
  assert.deepEqual(THRESHOLDS.slice(0, 7), [20, 30, 40, 50, 60, 80, 100]);
  const tiers = THRESHOLDS.map(tierFor);
  for (let i = 1; i < tiers.length; i++) assert.ok(tiers[i] >= tiers[i - 1]);
  assert.equal(tierFor(100), 4); assert.equal(tierFor(120), 5);
  assert.ok(DURATION_MS[1] < DURATION_MS[2] && DURATION_MS[2] < DURATION_MS[3] && DURATION_MS[3] < DURATION_MS[4]);
  for (const ms of [1, 2, 3, 4, 5].map(k => DURATION_MS[k])) assert.ok(ms >= 1000 && ms <= 2400);
  const g = buildPlan({threshold: 100, reading: 102, world: 'neon', rand: rng(1)});
  assert.ok(g.acts.length >= 4, g.acts.join(','));
  assert.ok(g.layers.some(l => l.act === 'grand-banner') && g.layers.some(l => l.act === 'bullet-time'));
  const small = buildPlan({threshold: 30, reading: 31, world: 'neon', rand: rng(1)}), big = buildPlan({threshold: 80, reading: 81, world: 'neon', rand: rng(1)});
  assert.ok(big.layers.length > small.layers.length, '大突破叠加镜头花活');
  assert.ok(small.layers.some(l => l.act === 'world') && big.layers.some(l => l.act === 'world'), '每次都有世界反应');
});

test('防刷：滞回（跌回阈值−8 才重新武装）、20s 冷却、冷却后为“回归”简化版；一条读数跨多个阈值只庆祝最高', () => {
  const d = createMilestoneDirector({seed: 1}); d.begin();
  assert.equal(d.reading(gps(0, 28), 0), null);
  const p1 = d.reading(gps(1, 31), 1000); assert.equal(p1.threshold, 30);
  d.update(9000);
  assert.equal(d.reading(gps(2, 25), 2000), null);     // 25 > 30−8：未武装
  assert.equal(d.reading(gps(3, 33), 3000), null);     // 不重复
  assert.equal(d.reading(gps(4, 30 - REARM_BELOW_KMH - 1), 4000), null); // 21 → 重新武装
  assert.equal(d.reading(gps(5, 31), 5000), null, '冷却内再次突破：不演出');
  assert.equal(d.counters.suppressed, 1);
  d.reading(gps(6, 20), 6000);
  const back = d.reading(gps(7, 32), 1000 + COOLDOWN_MS + 10);
  assert.ok(back?.comeback, '冷却后：回归演出'); assert.equal(back.main, 'comeback'); assert.ok(back.ms < DURATION_MS[1]);
  const d2 = createMilestoneDirector({seed: 2}); d2.begin(); d2.reading(gps(0, 15), 0);
  const jump = d2.reading(gps(1, 63), 1000);
  assert.equal(jump.threshold, 60, '15→63 只庆祝 60');
  // 演出中再突破：排队 1 个（取更高），超时丢弃
  d2.reading(gps(2, 81), 1200); assert.equal(d2.pending.threshold, 80);
  assert.equal(d2.update(1500), null); assert.equal(d2.update(1000 + jump.ms + 1)?.threshold, 80);
  // 当前演出结束后 1.5s 仍未开始的排队项被丢弃
  const d3 = createMilestoneDirector({seed: 2}); d3.begin(); d3.reading(gps(0, 15), 0); const j3 = d3.reading(gps(1, 63), 1000); d3.reading(gps(2, 81), 1200);
  assert.equal(d3.update(1000 + j3.ms + 1600), null);
});

test('只基于真实读数：惯导估速 ≈ 与未知读数不触发，也不作为下一条的起点', () => {
  const d = createMilestoneDirector({seed: 3}); d.begin();
  d.reading(gps(0, 18), 0);
  assert.equal(d.reading({t: 1, speedKmh: 25, source: 'inertial', simulated: false}, 1000), null);
  assert.equal(d.reading(gps(2, 26), 2000), null, '估速之后的第一条真实读数只作起点');
  assert.equal(d.reading({t: 3, speedKmh: null, source: 'unavailable'}, 3000), null);
  assert.ok(d.reading(gps(4, 12), 4000) === null && d.reading(gps(5, 22), 5000)?.threshold === 20);
});

test('今日新高：每次骑行最多一次、≥60 且高于开骑前今日最高；只有真实 GPS 写历史（带版本）', () => {
  const store = memStorage(), day = new Date(2026, 9, 21);
  const d = createMilestoneDirector({seed: 4, storage: store, date: () => day}); d.begin();
  const plans = feed(d, ramp(0, 92, 3));
  const nh = plans.filter(p => p.newHigh);
  assert.equal(nh.length, 1); assert.equal(nh[0].threshold, 60);
  const h = JSON.parse(store.getItem(HISTORY_KEY));
  assert.equal(h.version, 1); assert.equal(h.days[dateKey(day)].best, 80);
  // 第二次骑行：今日最高 80 → 60/80 不再是新高，100 才是
  d.begin(); assert.equal(d.todayBestAtStart, 80);
  const p2 = feed(d, ramp(0, 104, 3));
  assert.deepEqual(p2.filter(p => p.newHigh).map(p => p.threshold), [100]);
});

test('DEMO 不计入、也不更新历史；损坏或旧版本历史按空处理', () => {
  const store = memStorage();
  store.setItem(HISTORY_KEY, JSON.stringify({version: 0, days: {x: 1}}));
  const w0 = store.writes;
  const d = createMilestoneDirector({seed: 5, storage: store}); d.begin({simulated: true});
  const plans = feed(d, ramp(0, 105, 3), {simulated: true});
  assert.ok(plans.length >= 7, '演示仍然演出');
  assert.equal(store.writes, w0, 'DEMO 不写历史');
  assert.equal(d.todayBestAtStart, 0);
  assert.ok(plans.find(p => p.newHigh)?.simulated, '演示里的今日新高带 simulated 标记（画面标“演示 · 不计入纪录”）');
});

test('对比表：每项有 https 来源、口径与“约”；只有读数大于区间上限才算“已超过”', () => {
  assert.equal(ACCESSED, '2026-10-21');
  assert.ok(COMPARISONS.length >= 8);
  for (const c of COMPARISONS) {
    assert.ok(c.sources.length >= 1 && c.sources.every(u => /^https:\/\/(en\.wikipedia\.org|www\.guinnessworldrecords\.com|worldathletics\.org)\//.test(u)), c.id);
    assert.ok(c.basis && c.name && Number.isFinite(c.kmh) && c.kmhMax >= c.kmh);
    assert.match(approxLabel(c), /^约 /);
  }
  assert.equal(overtaken(44.7)?.id, 'elephant');
  assert.equal(overtaken(45)?.id, 'bolt');
  assert.equal(overtaken(103)?.id, 'pronghorn', '猎豹按上限 104 比较');
  assert.equal(overtaken(105)?.id, 'cheetah');
  assert.equal(overtaken(20), null);
  const src = readFileSync(new URL('render/milestone-acts/stage.js', root), 'utf8');
  assert.match(src, /趣味对比 · 约值/);
  assert.match(readFileSync(new URL('render/milestone-acts/comic.js', root), 'utf8'), /趣味弹幕 · 非真实用户/);
  assert.match(readFileSync(new URL('render/milestone-acts/comic.js', root), 'utf8'), /成就解锁 · 游戏/);
});

/* 用假 DOM 跑播放器：所有剧目都能在任意进度绘制且不抛错。 */
function fakePlayer({reduced = false} = {}) {
  const dom = createDom(); globalThis.document = dom.doc;
  const clips = [], flashes = [];
  const canvas = dom.doc.createElement('canvas');
  const ctx = new Proxy({}, {get: (t, k) => (k === 'clip' ? (...a) => clips.push(a) : k === 'measureText' ? s => ({width: String(s).length * 10}) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; }});
  canvas.getContext = () => ctx;
  return {canvas, clips, flashes, dom};
}
const L = stageLayout(832, 378), speedRect = {x: 560, y: 20, w: 250, h: 150};
const envArgs = {W: 832, H: 378, L, point: () => ({x: 400, y: 200}), speedRect, particles: 1, dpr: 1};

test('播放：每种剧目 × 每个世界 × 各进度都能绘制；速度矩形始终被裁掉（evenodd）；速度层 z 序更高', async () => {
  const f = fakePlayer();
  const {createMilestonePlayer} = await import('../render/milestone-player.js');
  const player = createMilestonePlayer({canvas: f.canvas, requestFlash: () => true});
  for (const item of GALLERY_ITEMS) for (const world of ['neon', 'sunset', 'snow', 'cosmic']) {
    const plan = {...galleryPlan(GALLERY_ITEMS.indexOf(item), {world, tier: 3}), startedAt: 0};
    player.play(plan, envArgs, 0);
    for (let t = 0; t <= plan.ms; t += 50) player.frame(t);
  }
  assert.ok(f.clips.length > 100 && f.clips.every(a => a[0] === 'evenodd' || a.length === 0 || a[0] === undefined || typeof a[0] !== 'string'));
  assert.ok(f.clips.some(a => a[0] === 'evenodd'));
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  const z = sel => Number(new RegExp(`\\${sel}\\{[^}]*z-index:(\\d+)`).exec(css)?.[1]);
  assert.ok(z('.milestone') < z('.speed'), `${z('.milestone')} < ${z('.speed')}`);
  delete globalThis.document;
});

test('闪光：每次演出每种闪光最多一次、合计 ≤2，并经统一限流器；整段演示每秒 ≤2 次', async () => {
  const f = fakePlayer();
  const {createMilestonePlayer} = await import('../render/milestone-player.js');
  const limiter = createFlashLimiter({maxPerSecond: 2});
  const asked = [];
  const player = createMilestonePlayer({canvas: f.canvas, requestFlash: (t, kind) => { asked.push(kind); return limiter.allow(t, kind); }});
  let clock = 0;
  for (const item of ['sonic-cone', 'paper-wall', 'grand', 'num-freeze', 'fireworks', 'bullet-time']) {
    const before = asked.length;
    const plan = {...galleryPlan(GALLERY_ITEMS.indexOf(item), {tier: 3}), startedAt: clock};
    player.play(plan, envArgs, clock);
    for (let t = clock; t <= clock + plan.ms; t += 16) { player.play !== null; player.frame(t); }
    assert.ok(asked.length - before <= 2, `${item}: ${asked.slice(before)}`);
    assert.equal(new Set(asked.slice(before)).size, asked.length - before);
    clock += plan.ms + 300;
  }
  assert.ok(maxFlashesPerSecond(limiter.log.map(x => x.t)) <= 2);
  delete globalThis.document;
});

test('减少动态：只画一张静态卡片，不动画、不闪、不动镜头', async () => {
  const f = fakePlayer();
  const {createMilestonePlayer} = await import('../render/milestone-player.js');
  let flashes = 0;
  const player = createMilestonePlayer({canvas: f.canvas, reduced: () => true, requestFlash: () => { flashes++; return true; }});
  const plan = {...galleryPlan(GALLERY_ITEMS.indexOf('grand')), startedAt: 0};
  player.play(plan, envArgs, 0);
  const clipsAfterPlay = f.clips.length;
  for (let t = 0; t < 1500; t += 16) { const cam = player.frame(t); assert.deepEqual(cam, {sceneScale: 1, panX: 0, timeScale: 1, desat: 0, bike: {dz: 0, dy: 0, pitch: 0, yaw: 0, squash: 1, shake: 0}}); }
  assert.equal(f.clips.length, clipsAfterPlay, '播放期间不再重绘');
  assert.equal(flashes, 0);
  player.frame(1700); assert.equal(player.active, null, '1.6s 后撤下');
  delete globalThis.document;
});

test('页面隐藏：取消当前演出与排队项，返回后不补播', () => {
  const d = createMilestoneDirector({seed: 9}); d.begin();
  d.reading(gps(0, 15), 0); d.reading(gps(1, 63), 1000); d.reading(gps(2, 82), 1200);
  assert.ok(d.active && d.pending);
  d.cancel();
  assert.equal(d.active, null); assert.equal(d.pending, null);
  assert.equal(d.update(5000), null);
});

test('画廊：每项都是“预览”计划，不写任何历史', () => {
  const store = memStorage(); globalThis.localStorage = store;
  for (let i = 0; i < GALLERY_ITEMS.length * 4; i++) {
    const p = galleryPlan(i, {world: ['neon', 'sunset', 'snow', 'cosmic'][i % 4], tier: i % 3 + 1});
    assert.equal(p.preview, true);
    assert.ok(p.ms >= 800 && p.ms <= 2400);
  }
  assert.equal(store.writes, 0);
  assert.ok(GALLERY_ITEMS.length >= 12 + 3 && ACT_IDS.length >= 12);
  assert.equal(galleryPlan(GALLERY_ITEMS.indexOf('grand')).tier, 4);
  delete globalThis.localStorage;
});

/* 演示剧本 + 突破导演（与 app 相同的接线方式），墙钟 60fps。 */
function demoWithMilestones() {
  const {Signals, Game} = loadShared();
  const script = buildDemoScript(), ride = createRideModel({signals: Signals, game: Game});
  const store = memStorage(), mdir = createMilestoneDirector({seed: 20261021, storage: store});
  let wall = 0, record = null, phase = 'idle';
  const started = [];
  const startPlan = p => { started.push(p); ride.record.milestones.push({...p}); };
  const player = createDemoPlayer(script, {
    go: () => { ride.begin({t: 0, source: 'demo'}); mdir.begin({simulated: true}); phase = 'riding'; },
    reading: f => { ride.ingest(f); if (phase === 'riding') { const p = mdir.reading({...f, world: 'neon'}, wall * 1000); if (p) startPlan(p); } },
    pause: () => { ride.pause(ride.rideT); phase = 'paused'; mdir.cancel(); }, resume: () => { ride.resume(ride.rideT); phase = 'riding'; },
    finish: () => { record = ride.finish(ride.rideT); phase = 'done'; },
  });
  player.start();
  for (let i = 0; i < 80 * 60 && phase !== 'done'; i++) { wall += 1 / 60; player.advance(1 / 60); if (ride.phase === 'riding') ride.tick(player.rideSeconds); const q = mdir.update(wall * 1000); if (q) startPlan(q); }
  return {script, started, record, store, wall};
}

test('演示驾驶：至少 6 种不同突破（含 100 大事件与回归），离散读数，不写历史；剧情仍约 60s', () => {
  const r = demoWithMilestones();
  const mains = r.started.filter(p => !p.comeback).map(p => p.main);
  assert.ok(new Set(mains).size >= 6, mains.join(','));
  assert.deepEqual(r.started.filter(p => !p.comeback).map(p => p.threshold), [20, 30, 40, 50, 60, 80, 100]);
  assert.ok(r.started.some(p => p.tier === 4), '100 大事件');
  assert.ok(r.started.filter(p => p.comeback).length >= 1, '回归演出');
  assert.ok(r.started.some(p => p.newHigh), '今日新高（演示）');
  for (const p of r.started) assert.ok(r.script.frames.some(f => f.t === p.t && f.speedKmh === p.reading), '计划里的读数就是剧本里的离散读数');
  assert.equal(r.store.writes, 0);
  assert.ok(r.wall > 58 && r.wall < 63);
});

test('骑行漫画：最精彩的一次突破（今日新高优先）占一格，数值取自记录，注释无凭空数字', () => {
  const r = demoWithMilestones();
  const m = selectMoments(r.record);
  assert.ok(m.length >= 4 && m.length <= 6);
  const ms = m.find(x => x.kind === 'milestone');
  assert.ok(ms, m.map(x => x.kind).join(','));
  const best = [...r.record.milestones].filter(x => !x.comeback).sort((a, b) => (b.newHigh - a.newHigh) || (b.tier - a.tier))[0];
  assert.equal(ms.threshold, best.threshold);
  const rd = r.record.readings.find(x => x.t === ms.t);
  assert.equal(ms.speedKmh, rd.speedKmh);
  const c = captionFor(ms);
  let text = [c.title, c.time, ...c.lines].join(' ');
  for (const v of [...c.values].sort((a, b) => b.length - a.length)) text = text.split(v).join('');
  assert.doesNotMatch(text, /\d/, text);
  assert.ok(m[m.length - 1].kind === 'finish' && m[0].kind === 'launch');
});

test('字库：剧场里所有中文都在打包的 MotuoHan 子集内', async () => {
  const {brotliDecompressSync} = await import('node:zlib');
  // 复用 fonts.test 的解析：直接检查 cmap 是否包含剧场文件中的汉字
  const b = readFileSync(new URL('assets/fonts/motuo-han.woff2', root));
  const numTables = b.readUInt16BE(12), compressed = b.readUInt32BE(20); let p = 48;
  const b128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const c = b[p++]; v = v * 128 + (c & 127); if (!(c & 128)) return v; } };
  const tables = []; for (let i = 0; i < numTables; i++) { const fl = b[p++], tg = fl & 63, ver = fl >> 6; if (tg === 63) p += 4; const o = b128(); const tr = (tg === 10 || tg === 11) ? ver === 0 : ver !== 0; tables.push({tg, len: tr ? b128() : o}); }
  const data = brotliDecompressSync(b.subarray(p, p + compressed)); let off = 0, cmap; for (const t of tables) { if (t.tg === 0) cmap = data.subarray(off, off + t.len); off += t.len; }
  const cps = new Set(); const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) { const so = cmap.readUInt32BE(8 + i * 8), fmt = cmap.readUInt16BE(so); if (fmt === 12) { const g = cmap.readUInt32BE(so + 12); for (let k = 0; k < g; k++) { const s = cmap.readUInt32BE(so + 16 + k * 12), e = cmap.readUInt32BE(so + 20 + k * 12); for (let c = s; c <= e; c++) cps.add(c); } } if (fmt === 4) { const sg = cmap.readUInt16BE(so + 6) / 2; for (let k = 0; k < sg; k++) { const e = cmap.readUInt16BE(so + 14 + k * 2), s = cmap.readUInt16BE(so + 16 + sg * 2 + k * 2); for (let c = s; c <= e && c !== 0xffff; c++) cps.add(c); } } }
  const files = ['render/milestone-acts/common.js', 'render/milestone-acts/stage.js', 'render/milestone-acts/comic.js', 'render/milestone-acts/camera-numbers.js', 'render/milestone-player.js', 'core/milestone-director.js', 'core/milestone-gallery.js', 'data/speed-comparisons.js', 'app.js', 'index.html'];
  let txt = ''; for (const f of files) { let s = readFileSync(new URL(f, root), 'utf8'); s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(,])\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, ''); txt += s; }
  const missing = [...new Set(txt.match(/[\u3400-\u9ffe]/g))].filter(c => !cps.has(c.codePointAt(0)));
  assert.deepEqual(missing, []);
});
