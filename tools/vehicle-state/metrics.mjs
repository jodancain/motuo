/* 回放指标：真实骑行（groundTruthNotes 人工参考）与合成回放（truth 分段真值）共用。
 * 标准与产品负责人给定的一致，不为凑数放宽：参考弯匹配、静止段不报加速/刹车/转弯、红灯段 idle、
 * 0–100 s 熄火、高速直线以 turn=none 为主、刹车段对应速度明显下降。 */
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = v => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

function speedAt(gps, t) {
  if (!gps) return null;
  let best = null;
  for (let i = 0; i < gps.t.length; i++) { if (gps.t[i] <= t) { if (Number.isFinite(gps.speed_mps[i])) best = gps.speed_mps[i]; } else break; }
  return best;
}
function frac(snaps, a, b, pred) {
  const s = snaps.filter(x => x.t >= a && x.t < b);
  return s.length ? s.filter(pred).length / s.length : NaN;
}
/* 状态切换事件 → 连续区段。 */
export function episodes(events, field, states, tEnd) {
  const out = []; let cur = null;
  for (const e of events.filter(e => e.type === 'state' && e.field === field)) {
    if (cur && !states.includes(e.to)) { cur.t1 = e.t; out.push(cur); cur = null; }
    if (!cur && states.includes(e.to)) cur = {t0: e.t, state: e.to, peak: e.to};
    else if (cur && states.includes(e.to)) { if (e.to === 'hardBraking') cur.peak = 'hardBraking'; }
  }
  if (cur) { cur.t1 = tEnd; out.push(cur); }
  return out;
}

export function parseReferenceCorners(notes) {
  const text = notes?.corners_from_desk_analysis;
  if (typeof text !== 'string') return [];
  const m = text.match(/[:：]\s*([0-9.,\s]+)\s*s/);
  return m ? m[1].split(/[,，\s]+/).filter(Boolean).map(Number).filter(Number.isFinite) : [];
}

/* 参考弯时刻 r 与检测到的弯 [start, end]：r ∈ [start − 3, end + 1.5] 视为同一个弯，一对一（按时间最近）。 */
export function matchCorners(ref, corners, {before = 3, after = 1.5} = {}) {
  const used = new Set(), pairs = [];
  for (const r of ref) {
    let best = null, bd = Infinity;
    corners.forEach((c, i) => {
      if (used.has(i) || r < c.start - before || r > c.end + after) return;
      const d = Math.abs(r - c.start);
      if (d < bd) { bd = d; best = i; }
    });
    if (best !== null) { used.add(best); pairs.push({ref: r, corner: corners[best]}); } else pairs.push({ref: r, corner: null});
  }
  const extra = corners.filter((_, i) => !used.has(i));
  return {pairs, matched: pairs.filter(p => p.corner).length, extra};
}

export function evaluate(data, res) {
  const {snaps, events, duration} = res;
  const gps = data.gps;
  const lines = [];
  // 安装估计：报告最后一次处于“已收敛”时的状态（真实骑行结尾手机从支架取下会触发重新估计）。
  const lastConverged = [...snaps].reverse().find(s => s.mount.status === 'converged');
  const firstConverged = snaps.find(s => s.mount.status === 'converged');
  const mount = lastConverged ? {...lastConverged.mount, at: lastConverged.t, firstConvergedAt: firstConverged.t, final: res.mount.status} : res.mount;
  const report = {kind: data.synthetic ? 'synthetic' : 'real', duration, snapshots: snaps.length, mount};
  const corners = events.filter(e => e.type === 'corner');
  const shifts = events.filter(e => e.type === 'suspectedShift');
  const brakes = episodes(events, 'motion', ['braking', 'hardBraking'], duration);
  const accels = episodes(events, 'motion', ['accelerating', 'launching'], duration);
  const longs = snaps.map(s => s.longitudinalG);
  report.longG = {max: Math.max(...longs), min: Math.min(...longs)};
  report.counts = {corners: corners.length, left: corners.filter(c => c.dir === 'left').length, right: corners.filter(c => c.dir === 'right').length,
    brakeEpisodes: brakes.length, hardBrakeEpisodes: brakes.filter(b => b.peak === 'hardBraking').length, accelEpisodes: accels.length, suspectedShift: shifts.length,
    stateChanges: events.filter(e => e.type === 'state').length};
  const shiftGaps = shifts.slice(1).map((s, i) => s.t - shifts[i].t);
  report.shift = {count: shifts.length, minGapS: shiftGaps.length ? Math.min(...shiftGaps) : null, medianGapS: shiftGaps.length ? shiftGaps.sort((a, b) => a - b)[Math.floor(shiftGaps.length / 2)] : null,
    perMinuteMoving: null, times: shifts.map(s => Math.round(s.t * 10) / 10), confidences: shifts.map(s => s.confidence)};
  const movingS = snaps.filter(s => s.motion.state !== 'stopped').length * 0.1;
  report.shift.perMinuteMoving = movingS > 0 ? shifts.length / (movingS / 60) : null;
  // 刹车段：段内 GPS 速度下降（段起点前 0.5 s 到段终点后 1 s）。
  // 段内降速 = 段开始附近（前 1.5 s 到后 0.5 s）的最高 GPS 速度 − 段内（到结束后 0.5 s）的最低 GPS 速度。
  const range = (a, b) => (gps ? gps.t.map((t, i) => (t >= a && t <= b && Number.isFinite(gps.speed_mps[i]) ? gps.speed_mps[i] : null)).filter(v => v !== null) : []);
  report.brakes = brakes.map(b => { const hi = range(b.t0 - 1.5, b.t0 + 0.5), lo = range(b.t0, b.t1 + 0.5); return {t0: b.t0, t1: b.t1, peak: b.peak, dropKmh: hi.length && lo.length ? (Math.max(...hi) - Math.min(...lo)) * 3.6 : null}; });
  const okBrakes = report.brakes.filter(b => b.dropKmh !== null && b.dropKmh >= 5).length;
  report.brakeWithDrop = brakes.length ? okBrakes / brakes.length : NaN;
  // 明显减速处（GPS：6 s 内下降 ≥ 15 km/h，局部最大降幅）是否被刹车段覆盖。
  const drops = [];
  if (gps) for (let i = 0; i < gps.t.length; i++) {
    const v0 = gps.speed_mps[i]; if (!Number.isFinite(v0)) continue;
    let j = i; while (j + 1 < gps.t.length && gps.t[j + 1] - gps.t[i] <= 6) j++;
    const v1 = gps.speed_mps[j];
    if (Number.isFinite(v1) && (v0 - v1) * 3.6 >= 15 && !drops.some(d => gps.t[i] < d.t1)) drops.push({t0: gps.t[i], t1: gps.t[j], dropKmh: (v0 - v1) * 3.6});
  }
  report.majorDrops = drops.map(d => ({...d, covered: brakes.some(b => b.t0 <= d.t1 && b.t1 >= d.t0)}));
  report.majorDropCoverage = drops.length ? report.majorDrops.filter(d => d.covered).length / drops.length : NaN;

  if (!data.synthetic) {
    const notes = data.groundTruthNotes || {};
    const ref = parseReferenceCorners(notes);
    const match = matchCorners(ref, corners);
    report.reference = {corners: ref, stops: notes.stops_s, redLight: notes.red_light_idle_s, highway: notes.highway_segment_s, engineStart: notes.engine_start_approx_s};
    report.cornerMatch = {reference: ref.length, detected: corners.length, matched: match.matched, recall: ref.length ? match.matched / ref.length : NaN,
      pairs: match.pairs.map(p => ({ref: p.ref, start: p.corner?.start ?? null, end: p.corner?.end ?? null, dir: p.corner?.dir ?? null, angleDeg: p.corner?.angleDeg ?? null})),
      extra: match.extra.map(c => ({start: c.start, end: c.end, dir: c.dir, angleDeg: c.angleDeg, speedKmh: (speedAt(gps, c.start) ?? 0) * 3.6}))};
    const stopWin = (notes.stops_s || []).map(([a, b]) => [a + 1, b - 1]);
    const inStop = t => stopWin.some(([a, b]) => t >= a && t < b);
    const stopSnaps = snaps.filter(s => inStop(s.t));
    const bad = stopSnaps.filter(s => ['accelerating', 'launching', 'braking', 'hardBraking', 'coasting'].includes(s.motion.state) || s.turn.state !== 'none');
    report.stops = {snapshots: stopSnaps.length, stoppedFraction: stopSnaps.length ? stopSnaps.filter(s => s.motion.state === 'stopped').length / stopSnaps.length : NaN, falseActive: bad.length,
      falseEvents: events.filter(e => inStop(e.t) && (e.type === 'corner' || e.type === 'suspectedShift' || (e.type === 'state' && e.field === 'motion' && ['accelerating', 'braking', 'hardBraking', 'launching'].includes(e.to)) || (e.type === 'state' && e.field === 'turn' && e.to !== 'none'))).length};
    const [ra, rb] = notes.red_light_idle_s || [350, 396];
    report.redLight = {window: [ra + 3, rb - 3], idleFraction: frac(snaps, ra + 3, rb - 3, s => s.engine.state === 'idle' || s.engine.state === 'revving'),
      revving: episodes(events, 'engine', ['revving'], duration).filter(e => e.t0 >= ra && e.t0 < rb).map(e => ({t0: e.t0, t1: e.t1}))};
    report.engineOff = {window: [0, 100], offFraction: frac(snaps, 0, 100, s => s.engine.state === 'off'),
      onEpisodes: episodes(events, 'engine', ['idle', 'revving', 'running'], duration).filter(e => e.t0 < 100).map(e => ({t0: e.t0, t1: e.t1}))};
    const [ha, hb] = notes.highway_segment_s || [190, 350];
    report.highway = {window: [ha + 3, hb - 5], noneFraction: frac(snaps, ha + 3, hb - 5, s => s.turn.state === 'none'), corners: corners.filter(c => c.start >= ha + 3 && c.start < hb - 5).length};
    report.engineFirstOn = (events.find(e => e.type === 'state' && e.field === 'engine' && ['idle', 'running'].includes(e.to) && e.t > 60) || {}).t ?? null;

    lines.push('## 真实回放指标（推断，人工参考为 groundTruthNotes）', '');
    lines.push('| 指标 | 标准 | 结果 |', '|---|---|---|');
    lines.push(`| 参考弯匹配 | 11 个参考弯尽量命中 | ${match.matched}/${ref.length}（${pct(report.cornerMatch.recall)}）；检测到 ${corners.length} 个（左 ${report.counts.left} / 右 ${report.counts.right}），未在参考里的 ${match.extra.length} 个 |`);
    lines.push(`| 静止段（${stopWin.map(w => w.join('–')).join('、')} s）| 不报加速/刹车/转弯 | 静止占比 ${pct(report.stops.stoppedFraction)}；误报快照 ${report.stops.falseActive}，误报事件 ${report.stops.falseEvents} |`);
    lines.push(`| 红灯段 ${ra + 3}–${rb - 3} s | engine=idle | idle/revving 占比 ${pct(report.redLight.idleFraction)}；轰油门 ${report.redLight.revving.length} 次 |`);
    lines.push(`| 0–100 s | engine=off | off 占比 ${pct(report.engineOff.offFraction)}；判为运转的区段 ${report.engineOff.onEpisodes.map(e => `${fmt(e.t0)}–${fmt(e.t1)}`).join('、') || '无'} |`);
    lines.push(`| 高速直线 ${ha + 3}–${hb - 5} s | turn=none 为主 | none 占比 ${pct(report.highway.noneFraction)}；该段过弯事件 ${report.highway.corners} |`);
    lines.push(`| 刹车段 | 对应速度明显下降 | ${brakes.length} 段（急刹 ${report.counts.hardBrakeEpisodes}），段内降速 ≥5 km/h 的 ${okBrakes}（${pct(report.brakeWithDrop)}）；GPS 明显减速处（6 s 内 ≥15 km/h）${drops.length} 个，被刹车段覆盖 ${pct(report.majorDropCoverage)} |`);
    lines.push(`| 纵向加速度 | 参考 −0.30 g / +0.24 g | 估计 ${fmt(report.longG.min, 2)} g / +${fmt(report.longG.max, 2)} g |`);
    lines.push(`| 疑似换挡 | 不再定时饱和 | ${shifts.length} 次（行驶中每分钟 ${fmt(report.shift.perMinuteMoving, 2)}），最短间隔 ${fmt(report.shift.minGapS)} s；旧算法每 12 s 一次 |`);
    lines.push(`| 发动机首次判为运转（60 s 后） | 参考约 ${notes.engine_start_approx_s} s | ${fmt(report.engineFirstOn)} s |`);
    lines.push(`| 安装估计 | 收敛 | ${mount.firstConvergedAt ? `${fmt(mount.firstConvergedAt)} s 首次收敛，至 ${fmt(mount.at)} s 保持；置信度 ${fmt(mount.confidence, 2)}，R=${fmt(mount.r, 2)}，增益 ${fmt(mount.gain, 2)}，有效样本 ${mount.informative}；结束时 ${mount.final}（手机取下后重新估计）` : '未收敛'} |`);
    lines.push('', '### 参考弯逐个对照（方向来自估计；参考未给方向）', '', '| 参考 s | 检测起–止 s | 方向 | 转角° |', '|---|---|---|---|');
    for (const p of report.cornerMatch.pairs) lines.push(`| ${p.ref} | ${p.start === null ? '未命中' : `${fmt(p.start)}–${fmt(p.end)}`} | ${p.dir === 'left' ? '左' : p.dir === 'right' ? '右' : '—'} | ${p.angleDeg ?? '—'} |`);
    if (match.extra.length) { lines.push('', '未在参考列表中的检测弯：', '', '| 起–止 s | 方向 | 转角° | 速度 km/h |', '|---|---|---|---|'); for (const c of report.cornerMatch.extra) lines.push(`| ${fmt(c.start)}–${fmt(c.end)} | ${c.dir === 'left' ? '左' : '右'} | ${c.angleDeg} | ${fmt(c.speedKmh, 0)} |`); }
  } else {
    // 合成回放：逐段真值对比。
    const truth = data.truth || [];
    const fields = ['engine', 'motion', 'turn'];
    report.truth = {};
    for (const f of fields) {
      const segs = truth.filter(s => s[f]);
      let n = 0, ok = 0;
      for (const seg of segs) for (const s of snaps) {
        if (s.t < seg.t0 + (seg.settle ?? 1) || s.t >= seg.t1) continue;
        n++; const v = f === 'turn' ? s.turn.state : s[f].state;
        if ([].concat(seg[f]).includes(v)) ok++;
      }
      report.truth[f] = {snapshots: n, accuracy: n ? ok / n : NaN};
    }
    report.truthCorners = truth.filter(s => s.corner).map(s => { const c = corners.find(c => c.start >= s.t0 - 1 && c.start <= s.t1 && c.dir === s.corner); return {t0: s.t0, dir: s.corner, found: !!c}; });
    lines.push('## 合成回放指标', '', '| 字段 | 真值段内准确率 |', '|---|---|');
    for (const f of fields) lines.push(`| ${f} | ${pct(report.truth[f].accuracy)}（${report.truth[f].snapshots} 快照）|`);
    lines.push(`| 过弯 | ${report.truthCorners.filter(c => c.found).length}/${report.truthCorners.length} 个按方向命中 |`);
    lines.push(`| 疑似换挡 | ${shifts.length} 次 @ ${report.shift.times.join(', ')} s |`);
    lines.push(`| 刹车段 | ${brakes.length}（急刹 ${report.counts.hardBrakeEpisodes}）|`);
  }
  report.markdown = lines.join('\n');
  return report;
}
