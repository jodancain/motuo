/* 回放适配器：把“回放文件”（与真实骑行去标识化导出同一格式：gps / motion / acoustic 分列数组，t 为骑行开始后秒数）
 * 按时间合并成一条事件流，逐条喂给车辆状态估计器。浏览器回放、node 测试与报告脚本共用。
 * 文件只在调用方提供时读取（文件选择器、?replay=<本机URL>、环境变量），本模块从不打包任何真实数据。 */
import {createVehicleStateEstimator} from './vehicle-state.js';

/* 统一成 {t, kind, ...} 并按 t 排序。kind: motion | gps | acoustic。 */
export function replayEvents(data) {
  if (!data || typeof data !== 'object') throw new TypeError('回放文件不是 JSON 对象');
  const out = [];
  const m = data.motion;
  if (m && Array.isArray(m.t)) {
    for (let i = 0; i < m.t.length; i++) {
      out.push({t: m.t[i], kind: 'motion', ua: [m.user_acc_x[i], m.user_acc_y[i], m.user_acc_z[i]], g: [m.gravity_x[i], m.gravity_y[i], m.gravity_z[i]], r: [m.rot_x[i], m.rot_y[i], m.rot_z[i]]});
    }
  }
  const g = data.gps;
  if (g && Array.isArray(g.t)) for (let i = 0; i < g.t.length; i++) out.push({t: g.t[i], kind: 'gps', v: g.speed_mps[i], acc: g.speed_acc_mps?.[i] ?? 0.5, h: g.h_acc_m?.[i] ?? 5});
  const a = data.acoustic;
  if (a && Array.isArray(a.t)) {
    const bands = Array.isArray(a.bands) ? a.bands : [];
    for (let i = 0; i < a.t.length; i++) out.push({t: a.t[i], kind: 'acoustic', rms: a.rms_dbfs[i], bands: bands.length ? bands.map(b => b[i]) : null});
  }
  const rank = {gps: 0, acoustic: 1, motion: 2};
  out.sort((x, y) => x.t - y.t || rank[x.kind] - rank[y.kind]);
  return out;
}

export function feed(est, e) {
  if (e.kind === 'motion') est.motion(e.t, e.ua, e.g, e.r);
  else if (e.kind === 'gps') est.gps(e.t, e.v, e.acc, e.h);
  else est.acoustic(e.t, e.rms, e.bands);
}

/* 整段离线回放：返回 10 Hz 快照序列与事件。 */
export function runReplay(data, {simulated = false, sampleEvery = 0.1, withMic = true} = {}) {
  const events = [];
  const est = createVehicleStateEstimator({simulated, onEvent: e => events.push(e)});
  const evs = replayEvents(data);
  const snaps = [];
  let next = evs.length ? Math.ceil(evs[0].t * 10) / 10 : 0;
  for (const e of evs) {
    if (!withMic && e.kind === 'acoustic') continue;
    while (e.t >= next) { const s = est.snapshot(); if (s.t !== null) snaps.push(s); next += sampleEvery; }
    feed(est, e);
  }
  return {snaps, events, mount: est.mount.state, duration: evs.length ? evs[evs.length - 1].t : 0};
}

/* 实时回放（浏览器）：按墙钟推进，speedup 倍速；每次 step(dtWall) 返回最新快照与这段时间里的新事件。 */
export function createReplayPlayer(data, {simulated = false, speedup = 1, startAt = 0, loop = false} = {}) {
  const evs = replayEvents(data);
  const t0 = evs.length ? evs[0].t : 0, t1 = evs.length ? evs[evs.length - 1].t : 0;
  let est, i, t, fresh, lastGps, loops = 0;
  const reset = at => {
    fresh = [];
    est = createVehicleStateEstimator({simulated, onEvent: e => fresh.push(e)});
    i = 0; t = at; lastGps = null;
    while (i < evs.length && evs[i].t < at - 4) i++;  // 预热 4 s，滤波器先收敛
    while (i < evs.length && evs[i].t < at) { if (evs[i].kind === 'gps') lastGps = evs[i]; feed(est, evs[i++]); }
    fresh = [];
  };
  reset(startAt || t0);
  return {
    get t() { return t; }, get duration() { return t1; }, get done() { return i >= evs.length; }, get loops() { return loops; },
    seek: at => reset(at),
    step(dtWall) {
      t += dtWall * speedup;
      while (i < evs.length && evs[i].t <= t) { if (evs[i].kind === 'gps') lastGps = evs[i]; feed(est, evs[i++]); }
      if (i >= evs.length && loop) { loops++; reset(t0); }
      const out = fresh; fresh = [];
      return {snapshot: est.snapshot(), events: out, gps: lastGps, t};
    },
  };
}
