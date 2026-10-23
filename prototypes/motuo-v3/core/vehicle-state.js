/* 车辆状态估计器（JS 版）。权威实现是 ios/Motuo/Services/VehicleStateEstimator.swift；本文件与之逐条对应，
 * 供浏览器回放驱动 v3 座舱和 node 交叉一致性测试使用（同一份合成回放，关键状态序列必须一致）。
 *
 * 输入（单调秒 t，任意顺序到达但同一来源单调）：
 *   motion(t, userAcc[g], gravity[g], rot[rad/s]) —— CoreMotion deviceMotion，手机坐标系，25–100 Hz；
 *   gps(t, speedMps|null, speedAccMps, hAccM)     —— 约 1 Hz；
 *   imuSpeed(t, mps|null, uncertainty)             —— InertialVelocityBridge 短时估速（GPS 缺失时兜底）；
 *   acoustic(t, rmsDbfs, bands|null)               —— 麦克风声学特征（可缺）。
 * 输出：snapshot()（10 Hz 更新一次），以及 onEvent 回调的状态切换 / 过弯 / 疑似换挡事件。
 *
 * 原则（docs/CONTRACT.md · 车辆状态）：
 *  - 一切输出都是推断（inferred）或模拟（simulated），不是测量；倾角只用于驱动画面，不显示数字。
 *  - 转弯 = 绕“真实竖直轴”（CoreMotion gravity 反方向）的偏航角速度，二级低通（≈0.45 Hz），不被 1.7 Hz 支架摆动触发。
 *  - 纵向加速度 = GPS 速度斜率（2.5 s 线性回归）为主 + 安装轴收敛后 IMU 前进分量做高频补充（互补滤波）；从不用加速度模长。
 *  - 发动机：静止时以 IMU 高频振动为主（熄火 ≈0.003 g、怠速 ≥0.02 g），麦克风只在手被扰动时兜底并负责“轰油门”。
 *  - 滞回 + 最短持续时间；静止不报加速 / 刹车 / 转弯；GPS 缺失时只用 IMU，置信度下降。
 */

export const G0 = 9.80665;
export const VS = Object.freeze({
  tickS: 0.1,
  yawTauS: 0.35,            // 偏航二级低通，每级时间常数
  upSlowTauS: 8,            // 安装竖直轴（慢）
  gpsMaxAgeS: 2.5, gpsMaxSpeedAcc: 2.5, gpsSlopeSpanS: 2.6,
  aGpsTauS: 0.5, aImuTauS: 0.25, aImuSlowTauS: 1.4, aImuNoGpsTauS: 5,
  vibTauS: 0.4, vibSampleS: 0.035,   // 振动 / 角速度均方低通；差分取样间隔
  handlingRotRad: 0.25,     // 静止时角速度均方根超过它 = 手在动手机/车（IMU 证据不可用）
  vibOnG: 0.016, vibOffG: 0.009, engineOnHoldS: 1.5, engineOffHoldS: 2.5,
  micOnAboveFloorDb: 6, revRiseDb: 4, revFallDb: 1.5, revMaxS: 4, revSettleS: 4, revOnsetDb: 3,
  stopEnterMps: 0.8, stopExitMps: 1.6,
  launchMaxMps: 6, launchMaxS: 5,
  accelOnG: 0.055, accelOffG: 0.03, brakeOnG: -0.065, brakeOffG: -0.035, hardOnG: -0.25, hardOffG: -0.17,
  coastOnG: -0.025, imuComplementMaxG: 0.12,
  // 候选状态需持续这么久才切换（滞回之外的最短持续时间，防抖）。
  holdS: Object.freeze({hardBraking: 0.25, braking: 0.35, accelerating: 0.4, launching: 0, coasting: 1.0, cruising: 0.6, stopped: 0.6}),
  handlingSettleS: 2, movingNoGpsVibG: 0.15, movingNoGpsHoldS: 5, leaveMaxS: 1.2, aStateTauS: 0.3, imuOnlyThresholdScale: 1.5,
  turnMinMps: 2.5, turnOnDegS: 8, turnOffDegS: 4.5, turnOnHoldS: 0.3, turnOffHoldS: 0.4,
  cornerMinDeg: 20, cornerMinS: 0.8,
  leanMaxDeg: 45, remountCos: Math.cos((25 * Math.PI) / 180),
  mountForget: 160, mountMinInformative: 10, mountMinR: 0.45, mountStraightDegS: 6, mountMinMps: 3,
  shiftCooldownS: 2.5, shiftMinAccelS: 0.4, shiftCandFrac: 0.6, shiftDeepFrac: 0.45, shiftSoundDipDb: 2,
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const alpha = (dt, tau) => (dt <= 0 ? 0 : 1 - Math.exp(-dt / tau));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = a => { const n = norm(a); return n > 1e-9 ? scale(a, 1 / n) : null; };
const deg = r => (r * 180) / Math.PI;

/* 3×3 对称线性方程 (S + εI) w = b（克拉默法则）。 */
function solve3(S, b, eps) {
  const a = [[S[0] + eps, S[1], S[2]], [S[1], S[3] + eps, S[4]], [S[2], S[4], S[5] + eps]];
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(a);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-12) return null;
  const col = (k) => a.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/* 自动安装估计：用直线段 GPS 纵向加速度对水平用户加速度做指数遗忘最小二乘，得到手机坐标里的前进轴。 */
export function createMountEstimator() {
  let S, b, saa, spp, spa, n, informative, up = null, forward = null, gain = 0, r = 0, status = 'learning', seeded = false;
  function reset(why = 'learning') { S = [0, 0, 0, 0, 0, 0]; b = [0, 0, 0]; saa = 0; spp = 0; spa = 0; n = 0; informative = 0; forward = null; gain = 0; r = 0; status = why; seeded = false; }
  reset();
  return {
    reset,
    /* 已有人工安装校准（SensorCalibrationService）时作为初值：置信度中等，自动估计收敛后被替换。 */
    seed(fwd) { const f = unit(fwd); if (f) { forward = f; status = 'calibrated'; seeded = true; gain = 1; } },
    setUp(u) { up = u; },
    /* h：该 GPS 区间内水平用户加速度均值（m/s²，手机坐标）；a：同区间 GPS 速度斜率（m/s²）。 */
    sample(h, a) {
      const lam = Math.exp(-1 / VS.mountForget);
      for (let i = 0; i < 6; i++) S[i] *= lam;
      for (let i = 0; i < 3; i++) b[i] *= lam;
      saa *= lam; spp *= lam; spa *= lam; n = n * lam + 1;
      S[0] += h[0] * h[0]; S[1] += h[0] * h[1]; S[2] += h[0] * h[2]; S[3] += h[1] * h[1]; S[4] += h[1] * h[2]; S[5] += h[2] * h[2];
      b[0] += h[0] * a; b[1] += h[1] * a; b[2] += h[2] * a;
      if (Math.abs(a) >= 0.45) informative = informative * lam + 1; else informative *= lam;
      const w = solve3(S, b, 0.05 * (n || 1) * 0.01 + 1e-3);
      if (!w || !up) return;
      const wh = sub(w, scale(up, dot(w, up)));
      const g = norm(wh);
      const p = dot(w, h);
      saa += a * a; spp += p * p; spa += p * a;
      r = saa > 0 && spp > 0 ? spa / Math.sqrt(saa * spp) : 0;
      if (g < 1e-6) return;
      const ok = informative >= VS.mountMinInformative && r >= VS.mountMinR && g >= 0.4 && g <= 2.5;
      if (ok) { forward = scale(wh, 1 / g); gain = g; status = 'converged'; seeded = false; }
      else if (status === 'converged' && r < VS.mountMinR * 0.7) status = 'learning';
    },
    get forward() { return forward; },
    get gain() { return gain > 0 ? gain : 1; },
    get confidence() { return status === 'converged' ? clamp(0.4 + 0.6 * (r - VS.mountMinR) / (1 - VS.mountMinR), 0.4, 1) * clamp(informative / (VS.mountMinInformative * 2), 0.5, 1) : seeded ? 0.5 : 0; },
    get status() { return status; },
    get state() { return {status, confidence: this.confidence, forward, up, r, gain, informative: Math.round(informative * 10) / 10, samples: Math.round(n)}; },
  };
}

export function createVehicleStateEstimator({simulated = false, onEvent = null, calibrationForward = null} = {}) {
  const source = simulated ? 'simulated' : 'inferred';
  const mount = createMountEstimator();
  const emit = e => { events.push(e); if (events.length > 400) events.shift(); onEvent?.(e); };
  let events = [];
  // 运动原始状态
  let lastMotionT = null, upFast = null, upSlow = null, upRef = null, yaw1 = 0, yaw2 = 0, prevAcc = null, vibMs = 0, rotMs = 0;
  let aImuLp = 0, aImuSlow = 0, aImuVerySlow = 0, hAccSum = [0, 0, 0], hAccN = 0, yawAbsSum = 0;
  // GPS
  let fixes = [], lastFix = null, aGps = null, aGpsLp = 0, gpsWindows = [];
  let imu = null;
  // 声学
  let acT = null, level = null, levelFast = null, levelSlow = null, floor = null, lowTilt = null;
  // 输出状态
  let nextTick = null, lastTickT = null;
  const st = {
    engine: 'unknown', engineConf: 0, engineSince: 0, onEvidenceSince: null, offEvidenceSince: null,
    motion: 'stopped', motionConf: 0.3, motionSince: 0, pending: null, launchAt: null, handlingUntil: null, noGpsMoveSince: null,
    longG: 0, aState: 0, longSource: 'none', speed: null, speedSource: 'none',
    turn: 'none', turnSince: 0, rise: null, lastCornerEnd: -Infinity, micOnSince: null, lfHist: [], turnCandSince: null, turnCandSign: 0, turnOffSince: null,
    corner: null, phase: 'none', lean: 0, yawDegS: 0,
    shiftDeepFrac: VS.shiftDeepFrac, micStart: 0, revSince: null, revBase: 0, shift: null, shiftCand: null, accelPeak: 0, lastShiftT: -Infinity, accelSince: null,
  };
  if (calibrationForward) mount.seed(calibrationForward);

  function setMotion(t, next, conf) {
    if (next === st.motion) { st.motionConf = conf; return; }
    emit({t, type: 'state', field: 'motion', from: st.motion, to: next, confidence: conf, source});
    st.motion = next; st.motionSince = t; st.motionConf = conf;
  }
  function setEngine(t, next, conf) {
    if (next === st.engine) { st.engineConf = conf; return; }
    emit({t, type: 'state', field: 'engine', from: st.engine, to: next, confidence: conf, source});
    st.engine = next; st.engineSince = t; st.engineConf = conf;
  }
  function setTurn(t, next) {
    if (next === st.turn) return;
    emit({t, type: 'state', field: 'turn', from: st.turn, to: next, confidence: turnConfidence(), source});
    st.turn = next; st.turnSince = t;
  }

  function motion(t, ua, grav, rot) {
    if (![t, ...ua, ...grav, ...rot].every(Number.isFinite)) return;
    const dt = lastMotionT === null ? 0 : t - lastMotionT;
    if (lastMotionT !== null && (dt <= 0 || dt > 0.5)) { lastMotionT = t; prevAcc = null; if (dt <= 0) return; }
    lastMotionT = t;
    const u = unit(scale(grav, -1));
    if (!u) return;
    upFast = u;
    if (!upSlow) upSlow = u; else {
      const k = alpha(dt, VS.upSlowTauS), next = unit([upSlow[0] + (u[0] - upSlow[0]) * k, upSlow[1] + (u[1] - upSlow[1]) * k, upSlow[2] + (u[2] - upSlow[2]) * k]);
      upSlow = next || upSlow;
    }
    // 手机在支架里被转动（慢竖直轴相对学习时变化 > 25°）：安装估计重来。
    if (!upRef) upRef = upSlow;
    else if (dot(upSlow, upRef) < VS.remountCos) { mount.reset('learning'); upRef = upSlow; emit({t, type: 'mountReset', reason: 'orientationChanged', source}); }
    mount.setUp(upSlow);
    // 偏航：绕真实竖直轴；二级低通，压掉 1.7 Hz 支架摆动。
    const yaw = dot(rot, u);
    const ky = alpha(dt, VS.yawTauS);
    yaw1 += (yaw - yaw1) * ky; yaw2 += (yaw1 - yaw2) * ky;
    // 振动：用户加速度一阶差分（高频）均方，单位 g；角速度均方用于识别“手在动”。
    // 振动按 ≈25 Hz 取样差分（与输入采样率无关）。
    if (!prevAcc || t - prevAcc.t >= VS.vibSampleS) {
      if (prevAcc) { const d = sub(ua, prevAcc.v); const kv = alpha(t - prevAcc.t, VS.vibTauS); vibMs += (dot(d, d) / 2 - vibMs) * kv; rotMs += (dot(rot, rot) - rotMs) * kv; }
      prevAcc = {t, v: ua};
    }
    // 水平用户加速度（m/s²），累计给安装估计；IMU 前进分量。
    const am = scale(ua, G0), h = sub(am, scale(upSlow, dot(am, upSlow)));
    hAccSum = [hAccSum[0] + h[0], hAccSum[1] + h[1], hAccSum[2] + h[2]]; hAccN++; yawAbsSum += Math.abs(deg(yaw2));
    const f = mount.forward;
    const af = f ? dot(h, f) : 0;
    aImuLp += (af - aImuLp) * alpha(dt, VS.aImuTauS);
    aImuSlow += (aImuLp - aImuSlow) * alpha(dt, VS.aImuSlowTauS);
    aImuVerySlow += (aImuLp - aImuVerySlow) * alpha(dt, VS.aImuNoGpsTauS);
    advance(t);
  }

  function gps(t, speed, acc = 0.5, hAcc = 5) {
    if (!Number.isFinite(t)) return;
    const ok = Number.isFinite(speed) && speed >= 0 && speed < 90 && Number.isFinite(acc) && acc >= 0 && acc <= VS.gpsMaxSpeedAcc && (!Number.isFinite(hAcc) || hAcc <= 65);
    if (!ok) { advance(t); return; }
    const fix = {t, v: speed, acc};
    // 安装估计样本：与上一条 GPS 的区间（0.5–1.6 s），直线、速度够。
    if (lastFix && t - lastFix.t >= 0.5 && t - lastFix.t <= 1.6 && hAccN > 0) {
      gpsWindows.push({t0: lastFix.t, t1: t, v0: lastFix.v, v1: speed, h: scale(hAccSum, 1 / hAccN), yaw: yawAbsSum / hAccN, acc: Math.max(acc, lastFix.acc)});
      if (gpsWindows.length > 3) gpsWindows.shift();
      // 两个相邻区间合并成 ≈2 s 窗口（斜率噪声减半）。
      if (gpsWindows.length >= 2) {
        const [a, c] = gpsWindows.slice(-2);
        if (Math.abs(a.t1 - c.t0) < 1e-6) {
          const span = c.t1 - a.t0, slope = (c.v1 - a.v0) / span;
          const hm = scale([a.h[0] + c.h[0], a.h[1] + c.h[1], a.h[2] + c.h[2]], 0.5);
          if (Math.min(a.v0, c.v1) >= VS.mountMinMps && (a.yaw + c.yaw) / 2 < VS.mountStraightDegS && Math.max(a.acc, c.acc) <= 1.2 && Math.abs(slope) < 6) mount.sample(hm, slope);
        }
      }
    } else gpsWindows = [];
    hAccSum = [0, 0, 0]; hAccN = 0; yawAbsSum = 0;
    fixes.push(fix); lastFix = fix;
    while (fixes.length && t - fixes[0].t > VS.gpsSlopeSpanS) fixes.shift();
    if (fixes.length >= 2 && fixes[fixes.length - 1].t - fixes[0].t >= 1.4) {
      const n = fixes.length, mt = fixes.reduce((s, x) => s + x.t, 0) / n, mv = fixes.reduce((s, x) => s + x.v, 0) / n;
      let num = 0, den = 0; for (const x of fixes) { num += (x.t - mt) * (x.v - mv); den += (x.t - mt) ** 2; }
      aGps = den > 0 ? clamp(num / den, -9, 7) : null;
    } else if (fixes.length < 2) aGps = null;
    advance(t);
  }
  function imuSpeed(t, mps, unc = 1) { imu = Number.isFinite(mps) && mps >= 0 ? {t, v: mps, unc} : null; advance(t); }

  function acoustic(t, rms, bands = null) {
    if (!Number.isFinite(t) || !Number.isFinite(rms)) return;
    const dt = acT === null ? 0 : clamp(t - acT, 0, 1); acT = t;
    if (level === null) { st.micStart = t; level = rms; levelFast = rms; levelSlow = rms; floor = rms; }
    level += (rms - level) * alpha(dt, 0.5);
    levelFast += (rms - levelFast) * alpha(dt, 0.12);
    levelSlow += (rms - levelSlow) * alpha(dt, 3);
    floor = Math.min(level, floor + 0.05 * dt);
    if (Array.isArray(bands)) {
      const lo = [bands[0], bands[2], bands[3]].filter(Number.isFinite), hi = [bands[8], bands[9], bands[10]].filter(Number.isFinite);
      if (lo.length && hi.length) { const tilt = Math.max(...lo) - Math.max(...hi); lowTilt = lowTilt === null ? tilt : lowTilt + (tilt - lowTilt) * alpha(dt, 1); }
    }
    advance(t);
  }

  function advance(t) {
    if (nextTick === null) nextTick = t;
    while (t >= nextTick) { tick(nextTick); nextTick += VS.tickS; }
  }

  function currentSpeed(t) {
    if (lastFix && t - lastFix.t <= VS.gpsMaxAgeS) return {v: Math.max(0, lastFix.v + clamp(st.longG * G0, -9, 7) * clamp(t - lastFix.t, 0, 1.2) * 0.5), src: 'gps'};
    if (imu && t - imu.t <= 1) return {v: imu.v, src: 'imu'};
    return null;
  }

  function turnConfidence() {
    const s = st.speed ?? 0;
    return clamp(0.35 + (Math.abs(st.yawDegS) - VS.turnOffDegS) / 30 + (st.speedSource === 'gps' ? 0.2 : 0) + (s > 5 ? 0.1 : 0), 0.2, 0.9);
  }

  function tick(t) {
    const dt = lastTickT === null ? VS.tickS : clamp(t - lastTickT, 0, 1); lastTickT = t;
    const motionFresh = lastMotionT !== null && t - lastMotionT <= 0.5;
    const sp = currentSpeed(t);
    st.speed = sp?.v ?? null; st.speedSource = sp?.src ?? 'none';
    const vib = Math.sqrt(Math.max(0, vibMs)), rotRms = Math.sqrt(Math.max(0, rotMs));
    // ---------- 纵向加速度（互补）----------
    const gpsFresh = lastFix && t - lastFix.t <= VS.gpsMaxAgeS && aGps !== null;
    const mc = mount.confidence;
    if (gpsFresh) {
      aGpsLp += (aGps - aGpsLp) * alpha(dt, VS.aGpsTauS);
      const comp = mc > 0 ? clamp(0.85 * Math.min(1, mc + 0.2) * mount.gain * (aImuLp - aImuSlow), -VS.imuComplementMaxG * G0, VS.imuComplementMaxG * G0) : 0;
      st.longG = (aGpsLp + comp) / G0;
      st.longSource = mc > 0 ? 'gps+imu' : 'gps';
    } else if (mc >= 0.4 && motionFresh) {
      aGpsLp *= Math.exp(-dt / 2);
      st.longG = (mount.gain * (aImuLp - aImuVerySlow)) / G0;
      st.longSource = 'imu';
    } else { st.longG *= Math.exp(-dt / 0.5); st.longSource = 'none'; aGpsLp *= Math.exp(-dt / 2); }
    // ---------- 运动 ----------
    const handling = rotRms > VS.handlingRotRad;
    if (handling) st.handlingUntil = t + VS.handlingSettleS;
    const imuSettled = !handling && t >= (st.handlingUntil ?? -Infinity);
    let stoppedNow;
    if (st.speed !== null) stoppedNow = st.motion === 'stopped' ? st.speed < VS.stopExitMps : st.speed < VS.stopEnterMps;
    else if (st.motion === 'stopped') {
      // 无速度：从静止出发必须看到持续的行驶级振动（≥5 s），手在动手机不算。
      if (motionFresh && vib >= VS.movingNoGpsVibG && imuSettled) st.noGpsMoveSince ??= t; else st.noGpsMoveSince = null;
      stoppedNow = st.noGpsMoveSince === null || t - st.noGpsMoveSince < VS.movingNoGpsHoldS;
    } else stoppedNow = motionFresh && vib < 0.1 && Math.abs(deg(yaw2)) < 3;
    // 状态判定用再平滑 0.3 s 的纵向加速度（强度用未再平滑的值，响应更快）；只有 IMU 时门限放大 1.5 倍。
    st.aState += (st.longG - st.aState) * alpha(dt, VS.aStateTauS);
    const a = st.longSource === 'imu' ? st.aState / VS.imuOnlyThresholdScale : st.aState;
    const conf = st.longSource === 'gps+imu' ? 0.8 : st.longSource === 'gps' ? 0.65 : st.longSource === 'imu' ? 0.35 : 0.2;
    const cur = st.motion;
    let want;
    if (stoppedNow) want = 'stopped';
    else if (cur === 'stopped') want = a > 0.02 || st.speed === null ? 'launching' : 'cruising';
    else if (cur === 'launching' && (st.speed ?? 0) < VS.launchMaxMps && t - (st.launchAt ?? t) < VS.launchMaxS && a > 0) want = 'launching';
    else if (st.longSource === 'none') want = 'cruising';
    else {
      const wasBrake = cur === 'braking' || cur === 'hardBraking', wasAccel = cur === 'accelerating' || cur === 'launching';
      if (a <= (cur === 'hardBraking' ? VS.hardOffG : VS.hardOnG)) want = 'hardBraking';
      else if (a <= (wasBrake ? VS.brakeOffG : VS.brakeOnG)) want = 'braking';
      else if (a >= (wasAccel ? VS.accelOffG : VS.accelOnG)) want = 'accelerating';
      else if (a <= VS.coastOnG) want = 'coasting';
      else want = 'cruising';
    }
    // 想去的状态要持续 holdS；离开当前状态的条件持续 1.2 s 而目标仍在变时，按最新目标（≥0.2 s）切换。
    if (want === cur) st.pending = null;
    else {
      st.pending ??= {since: t, state: want, stateSince: t};
      if (st.pending.state !== want) { st.pending.state = want; st.pending.stateSince = t; }
      const hold = cur === 'stopped' && want !== 'stopped' ? 0 : VS.holdS[want] ?? 0.5;
      if (t - st.pending.stateSince >= hold || (t - st.pending.since >= VS.leaveMaxS && t - st.pending.stateSince >= 0.2)) { if (want === 'launching') st.launchAt = t; setMotion(t, want, want === 'stopped' ? (st.speed !== null ? 0.85 : 0.5) : conf); st.pending = null; }
    }
    if (st.motion === cur) st.motionConf = st.motion === 'stopped' ? (st.speed !== null ? 0.85 : 0.5) : conf;
    const moving = st.motion !== 'stopped';
    // ---------- 发动机 ----------
    const micLive = acT !== null && t - acT <= 1;
    let engine = st.engine, econf = st.engineConf;
    if (moving) { engine = 'running'; econf = st.speed !== null ? 0.9 : 0.6; st.onEvidenceSince = null; st.offEvidenceSince = null; }
    else if (motionFresh && imuSettled) {
      if (vib >= VS.vibOnG) { st.onEvidenceSince ??= t; st.offEvidenceSince = null; }
      else if (vib < VS.vibOffG) { st.offEvidenceSince ??= t; st.onEvidenceSince = null; }
      else { st.onEvidenceSince = null; st.offEvidenceSince = null; }
      const micAgrees = micLive && floor !== null && level - floor >= VS.micOnAboveFloorDb;
      if (st.onEvidenceSince !== null && t - st.onEvidenceSince >= VS.engineOnHoldS && !['idle', 'revving'].includes(engine)) { engine = 'idle'; econf = micLive ? (micAgrees ? 0.85 : 0.6) : 0.65; }
      else if (st.offEvidenceSince !== null && t - st.offEvidenceSince >= VS.engineOffHoldS && engine !== 'off') { engine = 'off'; econf = micLive ? (micAgrees ? 0.45 : 0.85) : 0.7; }
      else if (engine === 'running') engine = 'idle';
    } else if (micLive && floor !== null && (!motionFresh || !imuSettled)) {
      // IMU 不可用（无数据或手在动）：只看声音是否明显高于本次最安静水平。
      // 底噪需先观察 ≥5 s，且高出底噪要持续 2 s。
      const loud = t - st.micStart >= 5 && level - floor >= VS.micOnAboveFloorDb + 2;
      if (loud) st.micOnSince ??= t; else st.micOnSince = null;
      if (loud && t - st.micOnSince >= 2) { if (engine === 'off' || engine === 'unknown' || engine === 'running') { engine = 'idle'; econf = 0.45; } }
      else if (!loud && engine === 'running') engine = 'idle';
      // 声音安静不能单独判熄火（底噪可能就是怠速声）：保持原状态。
    } else if (engine === 'running') engine = 'idle';
    if (levelFast !== null) { st.lfHist.push(levelFast); if (st.lfHist.length > 6) st.lfHist.shift(); }
    // 原地轰油门：静止且发动机在转，快声级比慢声级（3 s）骤升；基线在轰油门开始时冻结。
    if (!moving && (engine === 'idle' || engine === 'revving') && micLive && levelSlow !== null) {
      if (engine === 'idle') {
        if (t - st.motionSince >= VS.revSettleS && levelFast - levelSlow >= VS.revRiseDb && levelFast - Math.min(...st.lfHist) >= VS.revOnsetDb) { engine = 'revving'; econf = 0.55; st.revSince = t; st.revBase = levelSlow; }
      } else if (levelFast - st.revBase <= VS.revFallDb || t - (st.revSince ?? t) > VS.revMaxS) { engine = 'idle'; econf = 0.6; }
    } else if (engine === 'revving') engine = moving ? 'running' : 'idle';
    setEngine(t, engine, econf);
    // ---------- 转弯 ----------
    const yawDeg = deg(yaw2);
    st.yawDegS = yawDeg;
    const canTurn = moving && st.speed !== null && st.speed >= VS.turnMinMps;
    const sign = Math.sign(yawDeg), mag = Math.abs(yawDeg);
    // 弯的起点回溯到 |偏航| 越过退出阈值的时刻（检测本身有 0.3 s 保持 + 滤波延迟）。
    if (!canTurn || mag < VS.turnOffDegS || (st.rise && st.rise.sign !== sign)) st.rise = null;
    if (canTurn && mag >= VS.turnOffDegS) { st.rise ??= {t, sign, angle: 0}; st.rise.angle += yawDeg * dt; }
    if (!canTurn) { endCorner(t); st.turnCandSince = null; st.turnCandSign = 0; st.turnOffSince = null; setTurn(t, 'none'); }
    else {
      const want = mag >= VS.turnOnDegS ? (sign > 0 ? 'left' : 'right') : null;
      if (st.turn === 'none') {
        if (want) { if (st.turnCandSign !== sign) { st.turnCandSign = sign; st.turnCandSince = t; } if (t - st.turnCandSince >= VS.turnOnHoldS) { setTurn(t, want); startCorner(t, sign); } }
        else st.turnCandSince = null, st.turnCandSign = 0;
      } else {
        const curSign = st.turn === 'left' ? 1 : -1;
        if (want && sign !== curSign) {
          if (st.turnCandSign !== sign) { st.turnCandSign = sign; st.turnCandSince = t; }
          if (t - st.turnCandSince >= VS.turnOnHoldS) { endCorner(t); setTurn(t, want); startCorner(t, sign); }
        } else if (mag < VS.turnOffDegS || sign !== curSign) {
          st.turnOffSince ??= t;
          if (t - st.turnOffSince >= VS.turnOffHoldS) { endCorner(t); setTurn(t, 'none'); }
        } else { st.turnOffSince = null; st.turnCandSign = curSign; }
      }
    }
    if (st.corner) {
      const c = st.corner;
      c.angle += yawDeg * dt; c.peak = Math.max(c.peak, mag);
      const rising = mag > c.last + 0.15;
      c.last = mag;
      st.phase = t - c.t0 < 0.5 || (rising && mag < c.peak * 0.98) ? (mag >= c.peak * 0.98 && t - c.t0 >= 0.5 ? 'apex' : 'entry') : mag < c.peak * 0.6 ? 'exit' : 'apex';
    } else st.phase = 'none';
    // 倾角（只驱动画面）：离心力关系 atan(v·ω/g)。
    const leanT = canTurn ? clamp(deg(Math.atan((st.speed * yaw2) / G0)), -VS.leanMaxDeg, VS.leanMaxDeg) : 0;
    st.lean += (leanT - st.lean) * alpha(dt, 0.25);
    // ---------- 疑似换挡：加速中纵向加速度短暂回落（+ 有麦克风时声音同时回落再回升）----------
    detectShift(t, micLive);
  }

  function startCorner(t, sign) { const r = st.rise && st.rise.sign === sign && st.rise.t >= st.lastCornerEnd ? st.rise : null; st.corner = {t0: r ? r.t : t, sign, angle: r ? r.angle - yaw2Deg() * VS.tickS : 0, peak: 0, last: 0}; }
  const yaw2Deg = () => deg(yaw2);
  function endCorner(t) {
    const c = st.corner; st.corner = null;
    if (!c) return;
    st.lastCornerEnd = t;
    const dur = t - c.t0;
    if (Math.abs(c.angle) >= VS.cornerMinDeg && dur >= VS.cornerMinS) emit({t, type: 'corner', dir: c.sign > 0 ? 'left' : 'right', start: c.t0, end: t, angleDeg: Math.round(Math.abs(c.angle)), peakDegS: Math.round(c.peak * 10) / 10, confidence: clamp(0.4 + Math.abs(c.angle) / 200, 0.4, 0.8), source});
  }
  function detectShift(t, micLive) {
    const a = st.longG;
    const accelerating = st.motion === 'accelerating' || st.motion === 'launching';
    if (!accelerating) { st.accelSince = null; st.shiftCand = null; st.accelPeak = 0; return; }
    st.accelSince ??= t;
    // 只在 IMU 前进轴收敛后才看得见 0.2–0.8 s 的回落，且需要麦克风；否则不报（保守）。
    if (mount.status !== 'converged' || st.longSource !== 'gps+imu' || !micLive) return;
    if (!st.shiftCand) {
      st.accelPeak = Math.max(st.accelPeak * Math.exp(-VS.tickS / 2), a);
      if (t - st.accelSince >= VS.shiftMinAccelS && st.accelPeak >= 0.08 && a <= st.accelPeak * VS.shiftCandFrac && t - st.lastShiftT >= VS.shiftCooldownS) st.shiftCand = {t0: t, peak: st.accelPeak, min: a, lvl0: micLive && st.lfHist.length ? Math.max(...st.lfHist) : null, lvlMin: micLive ? levelFast : null};
    } else {
      const c = st.shiftCand; c.min = Math.min(c.min, a);
      if (micLive && c.lvlMin !== null) c.lvlMin = Math.min(c.lvlMin, levelFast);
      const dur = t - c.t0;
      if (dur > 1.0) { st.shiftCand = null; return; }
      if (a >= c.peak * 0.7 && dur >= 0.15) {
        // 纵向回落 + 声音同时回落 ≥2 dB 后回升，两者都要。没有麦克风不报：合成回放里只靠 IMU 的回落全是支架振动误报。
        const deep = c.min <= c.peak * st.shiftDeepFrac;
        const soundDip = c.lvl0 !== null && c.lvlMin !== null ? c.lvl0 - c.lvlMin : null;
        const sound = soundDip !== null && soundDip >= VS.shiftSoundDipDb && levelFast >= c.lvlMin + 1;
        st.shiftCand = null;
        if (!sound) return;
        const confidence = deep ? 0.45 : 0.35;
        st.shift = {t: c.t0, confidence}; st.lastShiftT = t;
        emit({t: c.t0, type: 'suspectedShift', dipG: Math.round((c.peak - c.min) * 1000) / 1000, soundDipDb: soundDip === null ? null : Math.round(soundDip * 10) / 10, confidence, source});
      }
    }
  }

  function snapshot() {
    const accelOn = ['accelerating', 'launching'].includes(st.motion), brakeOn = ['braking', 'hardBraking'].includes(st.motion);
    const moving = st.motion !== 'stopped';
    return {
      t: lastTickT, source,
      engine: {state: st.engine, confidence: round(st.engineConf), source},
      motion: {state: st.motion, confidence: round(st.motionConf), source},
      longitudinalG: moving ? round(st.longG, 3) : 0, longitudinalSource: st.longSource,
      accelIntensity: moving ? round(clamp((st.longG - 0.02) / 0.22, 0, 1) * (accelOn ? 1 : 0.4)) : 0,
      brakeIntensity: moving ? round(clamp((-st.longG - 0.03) / 0.3, 0, 1) * (brakeOn ? 1 : 0.4)) : 0,
      speedMps: st.speed === null ? null : round(st.speed, 2), speedSource: st.speedSource,
      turn: {state: st.turn, yawRateDegS: round(st.yawDegS, 1), leanEstimateDeg: round(st.lean, 1), leanSource: 'inferred', cornerPhase: st.phase, confidence: st.turn === 'none' ? 0 : round(turnConfidence())},
      mount: {...mount.state, forward: mount.forward ? mount.forward.map(v => round(v, 3)) : null, up: upSlow ? upSlow.map(v => round(v, 3)) : null},
      shift: st.shift ? {t: st.shift.t, confidence: st.shift.confidence} : null,
      sound: level === null ? null : {levelDb: round(level, 1), floorDb: round(floor, 1), lowTiltDb: lowTilt === null ? null : round(lowTilt, 1)},
      vibrationG: round(Math.sqrt(Math.max(0, vibMs)), 4),
    };
  }
  const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
  return {motion, gps, imuSpeed, acoustic, advance, snapshot, recalibrateMount: () => { mount.reset('learning'); upRef = upSlow; },
    /* 个人学习阈值（VehicleLearningService）调灵敏度：深回落门限。 */
    setShiftSensitivity: frac => { st.shiftDeepFrac = clamp(frac, 0.3, 0.6); }, get events() { return events.slice(); }, get mount() { return mount; }};
}
