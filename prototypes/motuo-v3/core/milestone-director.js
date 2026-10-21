/* 速度突破剧场 · 导演（纯逻辑，可在 node 中测试）。
 * - 只用真实读数：DEMO 可以演出但不写历史；惯导估速（≈）、未知读数不触发。
 * - 阶梯：20/30/40/50/60/80/100/120/140/160/180/200；越高越隆重，100 为“大事件”。
 * - 防刷：每个阈值跌回阈值−8 km/h 才重新武装（滞回）；同一阈值 20s 内再次突破不演出（冷却），
 *   20s 后再突破演“回归”简化版；一条读数跨过多个阈值只庆祝最高的；演出进行中最多排队 1 个（取更高者），
 *   当前演出结束后 1.5s 内未开始就丢弃。
 * - 剧目：带种子的随机，连续两次不同；同一次骑行内先用完整个剧目池再重复；世界偏好加权。
 * - 今日新高：每次骑行最多一次，跨过 ≥60 且高于“开骑前的今日最高”时附加专属演出；只有真实 GPS 读数会更新历史。
 */
import {rng} from './geometry.js';
import {overtaken} from '../data/speed-comparisons.js';

export const THRESHOLDS = Object.freeze([20, 30, 40, 50, 60, 80, 100, 120, 140, 160, 180, 200]);
export const REARM_BELOW_KMH = 8;
export const COOLDOWN_MS = 20000;
export const NEW_HIGH_MIN = 60;
export const HISTORY_KEY = 'motuo.v3.milestone-history';
export const HISTORY_VERSION = 1;

export const ACTS = Object.freeze({
  'paper-wall': {name: '破纸墙', worlds: null},
  'finish-banner': {name: '冲线横幅', worlds: null},
  'sonic-cone': {name: '音障锥', worlds: null},
  'number-race': {name: '数字赛跑', worlds: null},
  'triple-panel': {name: '分镜三连', worlds: null},
  'stamp': {name: '编辑盖章', worlds: null},
  'achievement': {name: '成就解锁', worlds: null},
  'danmaku': {name: '趣味弹幕', worlds: null},
  'compare': {name: '速度对比', worlds: null},
  'fireworks': {name: '烟花写字', worlds: ['neon', 'cosmic', 'sunset']},
  'dolly-zoom': {name: '希区柯克变焦', worlds: null, camera: true},
  'whip-pan': {name: '甩镜', worlds: null, camera: true},
  'bullet-time': {name: '子弹时间', worlds: null, camera: true},
  'num-fire': {name: '数字着火', worlds: ['sunset', 'neon']},
  'num-shatter': {name: '碎裂重组', worlds: null},
  'num-freeze': {name: '冻住震碎', worlds: ['snow']},
  'num-neon': {name: '霓虹灯管', worlds: ['neon', 'cosmic']},
});
export const ACT_IDS = Object.freeze(Object.keys(ACTS));
export const CAMERA_ACTS = Object.freeze(ACT_IDS.filter(id => ACTS[id].camera));

// 等级：1 小 · 2 中 · 3 大 · 4 大事件（100）· 5 传说（>100）
export function tierFor(th) { return th >= 120 ? 5 : th >= 100 ? 4 : th >= 60 ? 3 : th >= 40 ? 2 : 1; }
// 四拍（起—冲突—爆点—余韵）需要让观众先看清道具：小 1.3s 起步
export const DURATION_MS = Object.freeze({1: 1300, 2: 1500, 3: 1800, 4: 2200, 5: 2400, comeback: 900});

export const TITLES = Object.freeze({20: '起步新人', 30: '街角小旋风', 40: '风之子', 50: '疾风骑士', 60: '追风者', 70: '闪电学徒', 80: '雷电骑士', 90: '流星使者', 100: '百公里传说', 120: '音速幻影', 140: '光速信徒', 160: '银河车神', 180: '次元骑士', 200: '无限之王'});

export const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function readHistory(storage) {
  try {
    const v = JSON.parse(storage?.getItem(HISTORY_KEY) || 'null');
    if (v && v.version === HISTORY_VERSION && v.days && typeof v.days === 'object') return v;
  } catch { /* 损坏的记录按空记录处理 */ }
  return {version: HISTORY_VERSION, days: {}, best: 0};
}

/* 选剧目：排除上一个、优先本次骑行未用过的；世界偏好 ×3；比较类需要有可比对象。 */
export function pickAct(rand, {world, last = null, used = new Set(), reading = null, exclude = []} = {}) {
  const ok = id => id !== last && !exclude.includes(id) && (id !== 'compare' || !!overtaken(reading));
  let pool = ACT_IDS.filter(id => ok(id) && !used.has(id));
  if (!pool.length) pool = ACT_IDS.filter(ok);
  const weights = pool.map(id => (ACTS[id].worlds?.includes(world) ? 3 : ACTS[id].worlds ? .6 : 1));
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
  return pool[pool.length - 1];
}

/* 由一次突破构造演出计划（画廊也用它，但画廊不经过导演、不写历史）。 */
export function buildPlan({threshold, reading, world, rand, last = null, used = new Set(), comeback = false, newHigh = false, simulated = false, preview = false, forceAct = null}) {
  const tier = tierFor(threshold);
  const base = {threshold, reading, world, tier, comeback, newHigh, simulated, preview, title: TITLES[threshold] || '速度骑士', compare: overtaken(reading)};
  if (comeback) return {...base, ms: DURATION_MS.comeback, main: 'comeback', layers: [{act: 'comeback', from: 0, to: 1}, {act: 'label', from: 0, to: 1}]};
  const layers = [];
  let main;
  if (tier >= 4 && !forceAct) {
    // 大事件：三幕串联 + 子弹时间 + 专属横幅
    const a = pickAct(rand, {world, last, used, reading, exclude: CAMERA_ACTS});
    const b = pickAct(rand, {world, last: a, used: new Set([...used, a]), reading, exclude: CAMERA_ACTS});
    const c = pickAct(rand, {world, last: b, used: new Set([...used, a, b]), reading, exclude: CAMERA_ACTS});
    main = a;
    layers.push({act: 'bullet-time', from: 0, to: .42, camera: true}, {act: a, from: 0, to: .42}, {act: b, from: .36, to: .72}, {act: c, from: .66, to: 1}, {act: 'grand-banner', from: .05, to: .95});
  } else {
    main = forceAct || pickAct(rand, {world, last, used, reading});
    layers.push({act: main, from: 0, to: 1, camera: !!ACTS[main]?.camera});
    // 大突破叠加镜头花活
    if (tier >= 3 && !ACTS[main]?.camera) layers.push({act: CAMERA_ACTS[Math.floor(rand() * CAMERA_ACTS.length)], from: 0, to: .7, camera: true});
  }
  layers.unshift({act: 'world', from: 0, to: 1});
  if (newHigh) layers.push({act: 'new-high', from: .15, to: 1});
  layers.push({act: 'label', from: 0, to: 1});
  return {...base, ms: forceAct ? DURATION_MS[Math.min(tier, 3)] : DURATION_MS[tier], main, layers, acts: layers.map(l => l.act).filter(id => ACTS[id])};
}

export function createMilestoneDirector({seed = 20261021, storage = null, now = () => Date.now(), date = () => new Date()} = {}) {
  let rand, prev, armed, lastFired, used, lastAct, active, pending, todayBestAtStart, newHighDone, plans, rideSimulated, counters;
  function begin({simulated = false} = {}) {
    rand = rng(seed); prev = null; armed = new Set(THRESHOLDS); lastFired = new Map(); used = new Set(); lastAct = null;
    active = null; pending = null; newHighDone = false; plans = []; rideSimulated = simulated;
    counters = {crossings: 0, suppressed: 0, comebacks: 0, merged: 0};
    todayBestAtStart = readHistory(storage).days[dateKey(date())]?.best || 0;
  }
  begin();
  function saveReal(th, speed) {
    if (!storage) return;
    const h = readHistory(storage), k = dateKey(date()), day = h.days[k] || {best: 0, speed: 0};
    if (th > day.best) { day.best = th; day.speed = Math.max(day.speed, speed); }
    h.days[k] = day; h.best = Math.max(h.best || 0, th);
    // 只保留最近 30 天
    const keys = Object.keys(h.days).sort(); while (keys.length > 30) delete h.days[keys.shift()];
    try { storage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /* 预览不保存 */ }
  }
  /* 每条读数调用一次。frame: {t, speedKmh, source, simulated}；返回本次应开始的计划（或 null）。 */
  function reading(frame, nowMs = now()) {
    const real = frame && Number.isFinite(frame.speedKmh) && frame.source === 'gps';
    if (!real) { prev = null; return null; } // 估速、未知：不算、也不作为下一条的起点
    const v = frame.speedKmh;
    let crossed = null;
    for (const th of THRESHOLDS) {
      if (!armed.has(th) && v < th - REARM_BELOW_KMH) armed.add(th);
      if (armed.has(th) && v >= th && prev !== null && prev < th) { armed.delete(th); crossed = th; }
    }
    prev = v;
    if (crossed === null) return null;
    counters.crossings++;
    const simulated = !!frame.simulated;
    if (!simulated) saveReal(crossed, v);
    const fired = lastFired.get(crossed);
    let comeback = false;
    if (fired !== undefined) {
      if (nowMs - fired < COOLDOWN_MS) { counters.suppressed++; return null; }
      comeback = true; counters.comebacks++;
    }
    lastFired.set(crossed, nowMs);
    const newHigh = !comeback && !newHighDone && crossed >= NEW_HIGH_MIN && crossed > todayBestAtStart;
    if (newHigh) newHighDone = true;
    const plan = buildPlan({threshold: crossed, reading: v, world: frame.world || 'neon', rand, last: lastAct, used, comeback, newHigh, simulated});
    plan.t = frame.t; plan.shown = String(Math.round(v)); plan.source = frame.source;
    if (!comeback) { for (const a of plan.acts) used.add(a); lastAct = plan.main; }
    if (active && nowMs < active.endsAt) {
      if (!pending || pending.threshold < plan.threshold) { if (pending) counters.merged++; pending = {...plan, queuedAt: nowMs, readyAt: active.endsAt}; }
      return null;
    }
    return start(plan, nowMs);
  }
  function start(plan, nowMs) { active = {...plan, startedAt: nowMs, endsAt: nowMs + plan.ms}; plans.push(active); return active; }
  // 每帧：结束过期演出、启动排队项（排队超过 1.5s 丢弃）。
  function update(nowMs = now()) {
    if (active && nowMs >= active.endsAt) active = null;
    if (!active && pending) {
      const p = pending; pending = null;
      // 排队等待从当前演出结束时算起，超过 1.5s 丢弃
      if (nowMs - Math.max(p.queuedAt, p.readyAt || 0) <= 1500) return start(p, nowMs + 250);
    }
    return null;
  }
  return {
    begin, reading, update,
    cancel() { active = null; pending = null; },
    get active() { return active; }, get pending() { return pending; }, get plans() { return plans; },
    get counters() { return counters; }, get todayBestAtStart() { return todayBestAtStart; }, get simulated() { return rideSimulated; },
  };
}
