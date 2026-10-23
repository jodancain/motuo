/* 车辆状态 → 座舱画面参数（纯函数 + 小导演），全部由车辆状态估计器的快照驱动。
 * 原则（DESIGN.md · 车辆状态交互）：
 *  - 倾斜 / 震动 / 镜头只作用于场景层（#camera），速度巨字永远在最上层且不被遮挡；拟声字避开速度区。
 *  - 特效强度档：off / low / std / max；减少动态时不倾斜、不震动、不缩放，只用颜色与图标示意。
 *  - 低置信度时效果按置信度弱化；静止不出加速 / 刹车效果；不显示倾角数字、RPM 数字。
 *  - 一切闪光走共用的闪光限流（≤3 次/秒，导演里默认 2 次/秒）。
 * vehicle 快照字段（原生 docs/CONTRACT.md · vehicle；浏览器回放由 core/vehicle-state.js 快照转换）：
 *   {source, engine, engineConf, motion, motionConf, longG, accel, brake, turn, yawDegS, lean, phase, turnConf, mount, mountConf, shiftAgo?, shiftConf?} */

export const FX_LEVELS = Object.freeze({off: 0, low: 0.55, std: 1, max: 1.35});
export const FX_LEVEL_ORDER = Object.freeze(['off', 'low', 'std', 'max']);
// tiltDeg：竖屏上限；横屏（宽高比 > 1.4）画面更宽，倾斜同样角度露边更多，上限 tiltLandscapeDeg，并按角度补缩放（tiltZoomPerDeg）。
export const FX_LIMITS = Object.freeze({tiltDeg: 18, tiltLandscapeDeg: 11, tiltZoomPerDeg: 0.012, bikeRollDeg: 10, shakePx: 9, fovMin: 1.0, fovMax: 1.06, speedSkewDeg: -22, speedStretch: 1.28});
const MOTIONS = new Set(['stopped', 'launching', 'accelerating', 'cruising', 'braking', 'hardBraking', 'coasting']);
const ENGINES = new Set(['unknown', 'off', 'idle', 'running', 'revving']);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

/* 原生快照 / 浏览器估计器快照 → 统一的小对象；非法输入返回 null（座舱回到无车辆状态的旧行为）。 */
export function normalizeVehicle(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.motion && typeof v.motion === 'object') {   // core/vehicle-state.js snapshot()
    return normalizeVehicle({source: v.source, engine: v.engine?.state, engineConf: v.engine?.confidence, motion: v.motion.state, motionConf: v.motion.confidence,
      longG: v.longitudinalG, accel: v.accelIntensity, brake: v.brakeIntensity, turn: v.turn?.state, yawDegS: v.turn?.yawRateDegS, lean: v.turn?.leanEstimateDeg,
      phase: v.turn?.cornerPhase, turnConf: v.turn?.confidence, mount: v.mount?.status, mountConf: v.mount?.confidence,
      shiftAgo: v.shift && Number.isFinite(v.t) ? v.t - v.shift.t : undefined, shiftConf: v.shift?.confidence});
  }
  if (!MOTIONS.has(v.motion)) return null;
  return {
    source: v.source === 'simulated' ? 'simulated' : 'inferred',
    engine: ENGINES.has(v.engine) ? v.engine : 'unknown', engineConf: clamp(v.engineConf),
    motion: v.motion, motionConf: clamp(v.motionConf),
    longG: clamp(v.longG, -1.5, 1.5), accel: clamp(v.accel), brake: clamp(v.brake),
    turn: v.turn === 'left' || v.turn === 'right' ? v.turn : 'none', yawDegS: clamp(v.yawDegS, -120, 120), lean: clamp(v.lean, -60, 60),
    phase: ['entry', 'apex', 'exit'].includes(v.phase) ? v.phase : 'none', turnConf: clamp(v.turnConf),
    mount: ['learning', 'calibrated', 'converged'].includes(v.mount) ? v.mount : 'learning', mountConf: clamp(v.mountConf),
    shiftAgo: Number.isFinite(v.shiftAgo) && v.shiftAgo >= 0 ? v.shiftAgo : null, shiftConf: clamp(v.shiftConf),
  };
}

/* 置信度 → 效果系数：0.2 以下几乎不动，0.7 以上满量。 */
export const confidenceGain = c => 0.25 + 0.75 * clamp((num(c) - 0.2) / 0.5);

/* 连续画面参数（每帧调用；调用方再做平滑）。speedKmh 只用于“静止”判断与离心视觉，不显示。 */
export function vehicleVisuals(raw, {level = 'std', reduced = false, speedKmh = null, theatre = false, aspect = 1} = {}) {
  const v = normalizeVehicle(raw);
  const k = FX_LEVELS[level] ?? 1;
  const tiltCap = aspect > 1.4 ? FX_LIMITS.tiltLandscapeDeg : FX_LIMITS.tiltDeg;
  const out = {
    active: !!v, level, reduced, tiltDeg: 0, bikeRollDeg: 0, bikeYaw: 0, bend: 0, innerSide: null, innerFocus: 0,
    dive: 0, lunge: 0, brakeGlow: 0, brakeTier: 0, reverseLines: 0,
    accel: 0, fov: FX_LIMITS.fovMax, warp: 0, parallax: 1, speedSkewDeg: -8, speedStretch: 1, flameLen: 0, wheelie: 0, edgeLines: 0,
    zoom: FX_LIMITS.fovMax, shakePx: 0, dim: 0, idleJitter: 0, puff: 0, ripple: 0, revFlame: 0, calm: 0, shiftJolt: 0,
    icons: [], tint: null,
  };
  if (!v) return out;
  const moving = v.motion !== 'stopped';
  // ---------- 转弯 ----------
  if (moving && v.turn !== 'none') {
    const g = confidenceGain(v.turnConf), dir = v.turn === 'left' ? -1 : 1;   // 左弯：逆时针（CSS 负角）
    const leanMag = clamp(Math.abs(v.lean) / 28) * g;   // 街道弯（20–40 km/h）视觉倾角也要看得出来
    out.innerSide = v.turn; out.innerFocus = clamp(leanMag * 1.2) * (v.phase === 'apex' ? 1 : 0.7);
    out.bend = dir * leanMag;
    out.icons.push(v.turn === 'left' ? 'turn-left' : 'turn-right');
    if (!reduced) {
      out.tiltDeg = dir * Math.min(tiltCap, leanMag * tiltCap * k);
      out.bikeRollDeg = dir * Math.min(FX_LIMITS.bikeRollDeg, leanMag * FX_LIMITS.bikeRollDeg * k);
      out.bikeYaw = -dir * 0.32 * leanMag * k;
    }
  } else if (moving && !reduced) {
    // 高速缓弯（未达到转弯门限）：随离心视觉量轻微倾斜，直线段基本不动。
    const soft = clamp(Math.abs(v.lean) / 40) * confidenceGain(0.4);
    out.tiltDeg = Math.sign(-v.lean) * Math.min(4, soft * tiltCap * 0.5) * k * (Math.abs(v.lean) > 3 ? 1 : 0);
  }
  // ---------- 刹车 ----------
  if (moving && (v.motion === 'braking' || v.motion === 'hardBraking' || v.brake > 0.05)) {
    const g = confidenceGain(v.motionConf), b = clamp(v.brake) * g;
    out.brakeTier = v.motion === 'hardBraking' ? (b > 0.75 ? 3 : 2) : v.motion === 'braking' ? 1 : 0;
    out.brakeGlow = clamp(0.25 + b) * (out.brakeTier ? 1 : 0.4);
    out.reverseLines = b;
    out.icons.push('brake'); out.tint = out.brakeTier >= 2 ? '#ff2a3d' : '#ff6b5a';
    if (!reduced) { out.dive = b * k; out.lunge = b * k; out.shakePx += (out.brakeTier >= 2 ? 3 : 1) * b * k; }
  }
  // ---------- 加速（持续，强度梯度一眼可见）----------
  if (moving && (v.motion === 'accelerating' || v.motion === 'launching' || v.accel > 0.05)) {
    const g = confidenceGain(v.motionConf), a = clamp(v.accel) * g * (v.motion === 'accelerating' || v.motion === 'launching' ? 1 : 0.5);
    out.accel = a; out.flameLen = a; out.edgeLines = a; out.parallax = 1 + 1.6 * a;
    out.icons.push('accel'); if (!out.tint) out.tint = a > 0.6 ? '#ffe45c' : '#8de8ff';
    if (!reduced) {
      out.fov = FX_LIMITS.fovMax - (FX_LIMITS.fovMax - FX_LIMITS.fovMin) * a * Math.min(1, k);
      out.warp = a * k; out.speedSkewDeg = -8 + (FX_LIMITS.speedSkewDeg + 8) * a * Math.min(1, k); out.speedStretch = 1 + (FX_LIMITS.speedStretch - 1) * a * Math.min(1, k);
      out.wheelie = a > 0.75 && v.turn === 'none' ? (a - 0.75) / 0.25 * k : 0;
      out.shakePx += 1.6 * a * k;
    }
  }
  // 换挡回落：短促顿挫（低置信度弱化）。
  if (moving && v.shiftAgo !== null && v.shiftAgo < 0.35) out.shiftJolt = (1 - v.shiftAgo / 0.35) * confidenceGain(v.shiftConf + 0.2) * (reduced ? 0 : k);
  // ---------- 巡航 / 滑行：平稳、背景节奏放缓 ----------
  if (moving && (v.motion === 'cruising' || v.motion === 'coasting') && v.turn === 'none') { out.calm = v.motion === 'coasting' ? 1 : 0.6; out.parallax *= v.motion === 'coasting' ? 0.82 : 0.92; }
  // ---------- 发动机 ----------
  if (!moving) {
    if (v.engine === 'off') { out.dim = 0.75; out.icons.push('engine-off'); }
    else if (v.engine === 'idle') { out.idleJitter = reduced ? 0 : 0.6 * k; out.puff = 0.5; out.ripple = 0.5; out.icons.push('idle'); }
    else if (v.engine === 'revving') { out.idleJitter = reduced ? 0 : 1 * k; out.puff = 1; out.ripple = 1; out.revFlame = 1; out.icons.push('rev'); }
    else if (v.engine === 'unknown') out.dim = 0.15;
  }
  // 剧场 / 分镜进行中：连续效果减半，不和剧目叠成一团。
  if (theatre) for (const key of ['tiltDeg', 'bikeRollDeg', 'warp', 'edgeLines', 'innerFocus', 'shakePx', 'lunge']) out[key] *= 0.5;
  if (level === 'off') for (const key of ['tiltDeg', 'bikeRollDeg', 'bikeYaw', 'shakePx', 'warp', 'lunge', 'dive', 'wheelie', 'idleJitter', 'shiftJolt']) out[key] = 0;
  out.shakePx = Math.min(FX_LIMITS.shakePx, out.shakePx);
  // 倾斜时补一点缩放，少露边（露出的角是墨色底，像倾斜的漫画格）。
  out.zoom = out.fov + Math.abs(out.tiltDeg) * FX_LIMITS.tiltZoomPerDeg;
  return out;
}

/* 一次性效果导演：比较前后快照 + 估计器事件，产出拟声字 / 冲击帧 / 小分镜请求，带冷却与剧场让位。
 * now：毫秒（performance.now）。返回 [{type:'word'|'impact'|'cutin'|'puff'|'flame'|'smoke'|'sparks'|'ring'|'jolt', ...}]。 */
export const VEHICLE_WORDS = Object.freeze({
  cornerIn: ['嗖——', 'SWOOSH'], cornerOut: ['呼——'], chain: ['嗖！', '再来！'],
  brake: ['吱——'], hard: ['BRAKE!!', '吱————！'], extreme: ['急刹!!!'],
  launch: ['VROOM!', '冲！'], boost: ['轰——！', 'BOOST!'], shift: ['嘎！'],
  ignite: ['轰隆…'], rev: ['轰！', 'VRRR!'], off: ['…熄火'],
});
export function createVehicleDirector({requestFlash = () => true, cooldownMs = 900} = {}) {
  let prev = null, lastWord = -Infinity, lastCornerEnd = -Infinity, chain = 0, lastAt = {};
  const log = [];
  const ready = (key, now, gap) => { if (now - (lastAt[key] ?? -Infinity) < gap) return false; lastAt[key] = now; return true; };
  function word(out, now, list, opts) {
    if (now - lastWord < cooldownMs && !opts.force) return;
    lastWord = now; out.push({type: 'word', text: list[log.length % list.length], ...opts});
  }
  return {
    get log() { return log; },
    reset() { prev = null; chain = 0; lastAt = {}; },
    step(raw, now, {reduced = false, theatre = false, level = 'std'} = {}) {
      const v = normalizeVehicle(raw), out = [];
      if (!v) { prev = null; return out; }
      const p = prev; prev = v;
      if (!p || level === 'off') return out;
      const quiet = theatre;  // 剧场期间：只留急刹（安全相关的强反馈），其余不出字
      // 转弯：入弯 / 出弯 / 连续弯节奏
      if (p.turn === 'none' && v.turn !== 'none') {
        chain = now - lastCornerEnd < 2500 ? chain + 1 : 1;
        if (!quiet) word(out, now, chain >= 2 ? VEHICLE_WORDS.chain : VEHICLE_WORDS.cornerIn, {side: v.turn, size: chain >= 2 ? 0.9 : 1, kind: 'cornerIn', chain});
        if (!quiet && !reduced && chain === 1 && v.turnConf >= 0.5 && ready('cutin', now, 6000)) out.push({type: 'cutin', kind: 'corner', side: v.turn});
      } else if (p.turn !== 'none' && v.turn === 'none') {
        lastCornerEnd = now;
        if (!quiet) word(out, now, VEHICLE_WORDS.cornerOut, {side: p.turn, size: 0.7, kind: 'cornerOut'});
      } else if (p.turn !== 'none' && v.turn !== 'none' && p.turn !== v.turn) {
        chain++; lastCornerEnd = now;
        if (!quiet) word(out, now, VEHICLE_WORDS.chain, {side: v.turn, size: 0.9, kind: 'cornerIn', chain, force: true});
      }
      // 刹车：分级
      const brakeRank = m => (m === 'hardBraking' ? 2 : m === 'braking' ? 1 : 0);
      if (brakeRank(v.motion) > brakeRank(p.motion)) {
        const hard = v.motion === 'hardBraking', extreme = hard && v.brake > 0.75;
        if (hard) {
          word(out, now, extreme ? VEHICLE_WORDS.extreme : VEHICLE_WORDS.hard, {side: 'front', size: extreme ? 1.35 : 1.15, kind: 'hard', force: true});
          if (!reduced && requestFlash(now, 'brake-impact')) out.push({type: 'impact', kind: 'brake'});
          out.push({type: 'sparks'}, {type: 'smoke', count: extreme ? 6 : 4});
          if (!reduced && !quiet && ready('cutin', now, 5000)) out.push({type: 'cutin', kind: 'brake'});
        } else if (!quiet) { word(out, now, VEHICLE_WORDS.brake, {side: 'front', size: 0.8, kind: 'brake'}); out.push({type: 'smoke', count: 2}); }
      }
      // 起步 / 强加速
      if (p.motion === 'stopped' && (v.motion === 'launching' || v.motion === 'accelerating')) {
        if (!quiet) word(out, now, VEHICLE_WORDS.launch, {side: 'rear', size: 1.1, kind: 'launch'});
        out.push({type: 'flame', len: 1}, {type: 'smoke', count: 4});
      } else if (v.accel >= 0.6 && p.accel < 0.6 && ready('boost', now, 4000)) {
        if (!quiet) word(out, now, VEHICLE_WORDS.boost, {side: 'rear', size: 1.05, kind: 'boost'});
        out.push({type: 'flame', len: 1});
      }
      // 换挡回落（低置信度：只给顿挫，不出字）
      if (v.shiftAgo !== null && v.shiftAgo < 0.25 && (p.shiftAgo === null || p.shiftAgo > v.shiftAgo + 0.05 || p.shiftAgo >= 0.25)) {
        out.push({type: 'jolt', strength: confidenceGain(v.shiftConf + 0.2) * (reduced ? 0 : 1)});
        if (!quiet && v.shiftConf >= 0.4) word(out, now, VEHICLE_WORDS.shift, {side: 'rear', size: 0.6, kind: 'shift'});
      }
      // 发动机
      if (v.motion === 'stopped') {
        if ((p.engine === 'off' || p.engine === 'unknown') && v.engine === 'idle') { if (!quiet) word(out, now, VEHICLE_WORDS.ignite, {side: 'rear', size: 0.8, kind: 'ignite'}); out.push({type: 'smoke', count: 3}); }
        if (p.engine !== 'revving' && v.engine === 'revving') { if (!quiet) word(out, now, VEHICLE_WORDS.rev, {side: 'rear', size: 1, kind: 'rev'}); out.push({type: 'flame', len: 0.8}, {type: 'ring'}); }
        if (p.engine !== 'off' && v.engine === 'off' && p.engine !== 'unknown') { if (!quiet) word(out, now, VEHICLE_WORDS.off, {side: 'rear', size: 0.6, kind: 'off'}); }
      }
      for (const o of out) log.push({...o, at: now});
      if (log.length > 300) log.splice(0, log.length - 300);
      return out;
    },
  };
}

/* 拟声字落点：按方向放在场景的对应侧，永远避开速度区（矩形外扩 pad）。返回 {x, y, rot} 或 null（放不下就不放）。 */
export function placeWord({W, H, speed, side = 'rear', size = 60, bike = null, pad = 12}) {
  const avoid = speed ? {x: speed.x - pad, y: speed.y - pad, w: speed.w + pad * 2, h: speed.h + pad * 2} : null;
  const bx = bike?.x ?? W * 0.4, by = bike?.y ?? H * 0.62;
  // 车向右行驶：左弯的内侧在画面上方，右弯在下方。
  const candidates = {
    left: [[bx, by - H * 0.36], [W * 0.22, H * 0.22], [W * 0.5, H * 0.2]],
    right: [[bx + W * 0.12, by + H * 0.16], [W * 0.62, H * 0.8], [W * 0.3, H * 0.84]],
    front: [[bx + W * 0.16, by - H * 0.18], [W * 0.55, H * 0.55], [W * 0.4, H * 0.3]],
    rear: [[bx - W * 0.18, by - H * 0.2], [W * 0.18, H * 0.5], [W * 0.3, H * 0.3]],
  }[side] || [[W * 0.35, H * 0.4]];
  const w = size * 2.6, h = size * 1.1;
  for (const [cx, cy] of candidates) {
    const x = clamp(cx, w / 2 + 4, W - w / 2 - 4), y = clamp(cy, h / 2 + 4, H - h / 2 - 4);
    const box = {x: x - w / 2, y: y - h / 2, w, h};
    if (!avoid || !(box.x < avoid.x + avoid.w && box.x + box.w > avoid.x && box.y < avoid.y + avoid.h && box.y + box.h > avoid.y)) {
      return {x, y, rot: side === 'left' ? 8 : side === 'right' ? -8 : -10, box};
    }
  }
  return null;
}

/* 减少动态时的示意：图标 + 颜色（不倾斜画面）。 */
// 只用打包字体覆盖的字形（tests/fonts.test.mjs 会检查）。
export const ICON_TEXT = Object.freeze({'turn-left': '← 左弯', 'turn-right': '右弯 →', brake: '刹车', accel: '加速', idle: '怠速', rev: '轰油门', 'engine-off': '熄火'});
export function reducedHint(vis) { return vis.icons.map(i => ICON_TEXT[i]).filter(Boolean).join(' · '); }
