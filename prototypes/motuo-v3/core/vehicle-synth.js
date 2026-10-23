/* 合成回放生成器：按参数生成与真实回放同格式的传感器数据（gps / motion / acoustic），并给出逐段真值。
 * 完全由下面的剧本与确定性伪随机数产生，不含、也不派生自任何真实骑行数据。
 * 覆盖：怠速、起步、加速与换挡回落、巡航、急刹、右弯 / 左弯 / S 弯、GPS 丢失、滑行、刹停、
 * 原地轰油门、熄火、再点火（结尾回到开头可循环，App 演示骑行循环播放）；全程叠加 1.7 Hz 车把支架摆动、路面与发动机振动噪声。
 * 产物：fixtures/vehicle-state/synthetic-ride.json（tools/vehicle-state/make-synthetic.mjs 写出，Swift 单测与 App 演示骑行读取）。 */
export const SYNTH_VERSION = 1;
const G0 = 9.80665;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const smooth = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/* 剧本：速度关键点（km/h，分段平滑插值）、偏航角速度段（°/s，左正）、发动机、轰油门、换挡、GPS 缺失。 */
export const SCRIPT = Object.freeze({
  duration: 152,
  speed: [[0, 0], [3, 0], [4, 4], [8, 30], [13, 55], [20, 80], [28, 98], [34, 104], [40, 104], [44, 50], [50, 50], [56, 75], [62, 75], [72, 75], [79, 62], [83, 30], [90, 30], [95, 0], [110, 0], [111, 3], [116, 42], [122, 42], [127, 0], [152, 0]],
  // 偏航段：[开始, 结束, 峰值°/s]（两端 0.8 s 平滑上升 / 回落）
  yaw: [[44.5, 50, -14], [56.5, 61.5, 11], [83.5, 86.7, 20], [86.9, 90, -20], [117, 121, 15]],
  engine: [[0, 'idle'], [3.5, 'running'], [95.5, 'idle'], [110.5, 'running'], [127.5, 'idle'], [134, 'off'], [146, 'idle']],
  revs: [[101, 102.3], [104.5, 105.6]],
  shifts: [6.2, 9.8, 15.5, 22.5, 52.5, 113.5],
  gpsLost: [[63, 72]],
  coast: [[72, 79]],
  cranks: [[146, 146.6]],
});

/* 单调三次 Hermite（PCHIP）插值：加速度连续，关键点处不会凭空出现“回落”（回落只来自 shifts）。 */
const pchipCache = new WeakMap();
function pchipSlopes(k) {
  if (pchipCache.has(k)) return pchipCache.get(k);
  const n = k.length, d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((k[i + 1][1] - k[i][1]) / (k[i + 1][0] - k[i][0]));
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    const h0 = k[i][0] - k[i - 1][0], h1 = k[i + 1][0] - k[i][0], w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  pchipCache.set(k, m);
  return m;
}
export function scriptSpeed(t, S = SCRIPT) {
  const k = S.speed, m = pchipSlopes(k);
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (t <= k[i][0]) {
    const [t0, v0] = k[i - 1], [t1, v1] = k[i], h = t1 - t0, x = (t - t0) / h;
    const h00 = 2 * x ** 3 - 3 * x ** 2 + 1, h10 = x ** 3 - 2 * x ** 2 + x, h01 = -2 * x ** 3 + 3 * x ** 2, h11 = x ** 3 - x ** 2;
    return Math.max(0, h00 * v0 + h10 * h * m[i - 1] + h01 * v1 + h11 * h * m[i]);
  }
  return k[k.length - 1][1];
}
export function scriptYaw(t, S = SCRIPT) {
  for (const [a, b, peak] of S.yaw) if (t >= a && t <= b) { const ramp = Math.min(smooth((t - a) / 0.8), smooth((b - t) / 0.8)); return peak * ramp; }
  return 0;
}
function engineAt(t, S) { let e = 'off'; for (const [at, st] of S.engine) if (t >= at) e = st; return e; }
const inAny = (t, list) => list.some(([a, b]) => t >= a && t < b);

/* 逐段真值（只列有明确答案、已越过滤波稳定期的段；settle 秒内不计分）。 */
export function truthSegments() {
  return [
    {t0: 0, t1: 3, engine: ['idle', 'unknown'], motion: 'stopped', turn: 'none', settle: 0.5},
    {t0: 4.5, t1: 34, motion: ['launching', 'accelerating'], engine: 'running', turn: 'none', settle: 1.5},
    {t0: 35.5, t1: 40, motion: 'cruising', turn: 'none', settle: 1},
    {t0: 40, t1: 44, motion: ['braking', 'hardBraking'], settle: 1.2},
    {t0: 41, t1: 43.5, motion: 'hardBraking', settle: 0.5},
    {t0: 44.5, t1: 50, turn: 'right', corner: 'right', settle: 1.4},
    {t0: 50, t1: 56, motion: 'accelerating', settle: 1.4},
    {t0: 56.5, t1: 61.5, turn: 'left', corner: 'left', settle: 1.4},
    {t0: 62, t1: 72, turn: 'none', motion: 'cruising', engine: 'running', settle: 1.5},
    {t0: 72, t1: 79, motion: ['coasting', 'braking'], settle: 1.5},
    {t0: 79, t1: 83, motion: ['braking', 'hardBraking'], settle: 1.2},
    {t0: 83.5, t1: 86.7, turn: 'left', corner: 'left', settle: 1.2},
    {t0: 86.9, t1: 90, turn: 'right', corner: 'right', settle: 1.2},
    {t0: 90, t1: 95, motion: ['braking', 'hardBraking', 'stopped'], settle: 1.5},
    {t0: 97, t1: 110, motion: 'stopped', engine: ['idle', 'revving'], turn: 'none', settle: 1.5},
    {t0: 101, t1: 102.3, engine: 'revving', settle: 0.4},
    {t0: 111, t1: 116, motion: ['launching', 'accelerating'], settle: 1.5},
    {t0: 117, t1: 121, turn: 'left', corner: 'left', settle: 1.2},
    {t0: 129, t1: 134, motion: 'stopped', engine: 'idle', settle: 1.5},
    {t0: 134, t1: 146, motion: 'stopped', engine: 'off', settle: 3},
    {t0: 146, t1: 152, motion: 'stopped', engine: 'idle', settle: 2.5},
  ];
}

/* 安装方向（手机坐标）：车头朝 forward、车顶朝 up；与任何真实支架无关的固定参数。 */
export const MOUNT = Object.freeze({up: [0.22, 0.74, 0.636], forwardHint: [0.0, 0.65, -0.76]});
function basis() {
  const n = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
  const u = n(MOUNT.up), fh = MOUNT.forwardHint, d = fh[0] * u[0] + fh[1] * u[1] + fh[2] * u[2];
  const f = n([fh[0] - d * u[0], fh[1] - d * u[1], fh[2] - d * u[2]]);
  const r = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]]; // r = f × u
  return {u, f, r};
}

export function generateSynthetic({seed = 20261023, motionHz = 50, acousticHz = 20, script = SCRIPT} = {}) {
  const r = rng(seed), {u, f, r: R} = basis();
  const S = script, T = S.duration;
  const accelAt = t => ((scriptSpeed(t + 0.05, S) - scriptSpeed(t - 0.05, S)) / 3.6) / 0.1;
  const shiftDip = t => { for (const s of S.shifts) if (t >= s && t < s + 0.4) return true; return false; };
  const rev = t => inAny(t, S.revs);
  const m = {hz: motionHz, t: [], user_acc_x: [], user_acc_y: [], user_acc_z: [], gravity_x: [], gravity_y: [], gravity_z: [], rot_x: [], rot_y: [], rot_z: []};
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  let lean = 0, prevLean = 0, wobPhase = 0, pitchPhase = 0;
  const dt = 1 / motionHz;
  for (let i = 0; i * dt <= T; i++) {
    const t = i * dt, kmh = scriptSpeed(t, S), v = kmh / 3.6, eng = engineAt(t, S);
    const yaw = (scriptYaw(t, S) * Math.PI) / 180;
    let aLong = accelAt(t);
    if (shiftDip(t)) aLong = -0.02 * G0;
    if (inAny(t, S.coast)) aLong = Math.min(aLong, -0.045 * G0) + 0;
    const aLat = v * yaw;
    const leanT = Math.atan(aLat / G0);
    lean += (leanT - lean) * (1 - Math.exp(-dt / 0.15));
    const leanRate = (lean - prevLean) / dt; prevLean = lean;
    const c = Math.cos(lean), s = Math.sin(lean);
    const upW = [u[0] * c + R[0] * s, u[1] * c + R[1] * s, u[2] * c + R[2] * s];
    const leftW = [-R[0] * c + u[0] * s, -R[1] * c + u[1] * s, -R[2] * c + u[2] * s];
    const on = eng !== 'off';
    const moving = v > 0.5;
    // 振动：发动机（怠速 0.025 g、轰油门 ×1.8）、路面随速度增加；支架摆动 1.7 Hz（转向）与 2.3 Hz（俯仰），行驶时更大。
    const vibG = (on ? (rev(t) ? 0.045 : 0.025) : 0.0015) + (moving ? 0.1 + 0.0028 * kmh : 0);
    const wobAmp = moving ? 0.22 + 0.002 * kmh : on ? 0.02 : 0.0008;
    wobPhase += 2 * Math.PI * 1.7 * dt; pitchPhase += 2 * Math.PI * 2.3 * dt;
    const wob = wobAmp * Math.sin(wobPhase), pit = wobAmp * 1.2 * Math.sin(pitchPhase + 0.7);
    const ua = [0, 1, 2].map(k => (aLong * f[k] + aLat * leftW[k]) / G0 + vibG * gauss(r) + 0.03 * (moving ? 1 : 0) * Math.sin(wobPhase * 1.3) * R[k]);
    const rot = [0, 1, 2].map(k => yaw * upW[k] - leanRate * f[k] + wob * upW[k] + pit * R[k] + (on ? 0.02 : 0.001) * gauss(r) + (moving ? 0.12 * gauss(r) : 0));
    const grav = upW.map(x => -x + 0.002 * gauss(r));
    m.t.push(round(t + 0.013, 3));
    for (const [k, key] of ['x', 'y', 'z'].entries()) {
      m['user_acc_' + key].push(round(ua[k], 4)); m['gravity_' + key].push(round(grav[k], 4)); m['rot_' + key].push(round(rot[k], 4));
    }
  }
  const gps = {t: [], speed_mps: [], speed_acc_mps: [], h_acc_m: []};
  for (let t = 0.48; t <= T; t += 1) {
    if (inAny(t, S.gpsLost)) continue;
    const v = Math.max(0, scriptSpeed(t, S) / 3.6 + (scriptSpeed(t, S) > 1 ? 0.12 * gauss(r) : 0.03 * Math.abs(gauss(r))));
    gps.t.push(round(t, 3)); gps.speed_mps.push(round(v, 2)); gps.speed_acc_mps.push(round(0.35 + 0.15 * r(), 2)); gps.h_acc_m.push(round(4 + 2 * r(), 1));
  }
  const edges = Array.from({length: 17}, (_, k) => round(31.5 * Math.pow(2, (k * Math.log2(24000 / 31.5)) / 16), 1));
  const ac = {t: [], rms_dbfs: [], bandEdgesHz: edges, bands: Array.from({length: 16}, () => [])};
  for (let t = 0.02; t <= T; t += 1 / acousticHz) {
    const kmh = scriptSpeed(t, S), eng = engineAt(t, S);
    let rms, tilt;
    if (eng === 'off') { rms = -52 + 1.5 * gauss(r); tilt = 4; }
    else if (kmh < 2) { rms = -19 + 0.8 * gauss(r); tilt = 18; if (inAny(t, S.cranks || [])) rms = -12; }
    else { rms = -17 + 0.075 * kmh + 1.2 * gauss(r); tilt = 9 - 0.04 * kmh; }
    if (rev(t)) { rms += 7; tilt -= 4; }
    if (S.shifts.some(s => t >= s && t < s + 0.4)) rms -= 4;
    ac.t.push(round(t, 3)); ac.rms_dbfs.push(round(rms, 1));
    for (let b = 0; b < 16; b++) ac.bands[b].push(round(rms - 4 - (tilt * Math.min(b, 10)) / 6 - b * 0.9 + 0.8 * gauss(r), 1));
  }
  return {
    about: 'Motuo 合成回放（参数生成，非真实骑行；core/vehicle-synth.js）。覆盖怠速/起步/加速换挡/巡航/急刹/左右弯/S 弯/GPS 丢失/滑行/刹停/轰油门/熄火/再点火，叠加 1.7 Hz 支架摆动。',
    synthetic: true, version: SYNTH_VERSION, seed, durationS: T,
    gps, motion: m, acoustic: ac, truth: truthSegments(),
    script: {shifts: S.shifts, revs: S.revs, gpsLost: S.gpsLost, yaw: S.yaw, engine: S.engine, coast: S.coast},
  };
}
