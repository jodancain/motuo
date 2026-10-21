/* 「今日骑行漫画」：从骑行记录挑关键时刻、排一页 4–6 格、生成注释。
 * 每一个数字都来自记录（读数、差分加速度、计时、积分里程、游戏分），
 * 这里只做挑选与格式化，不产生新数值。纯函数，便于测试。
 */
import {rectPoly, clipAll, cut} from './geometry.js';
import {formatClock, formatKm} from './ride-model.js';
import {ACTS} from './milestone-director.js';
const actLabel = id => ACTS[id]?.name || (id === 'comeback' ? '再次突破' : '速度突破');

export const PAGE = Object.freeze({W: 1080, H: 1528, margin: 44, header: 196, footer: 168, gutter: 18});

export const MOMENT_COPY = Object.freeze({
  launch: {title: '起步', sfx: 'VROOM!', tone: 'cyan'},
  top: {title: '最高速', sfx: 'ZOOOM!', tone: 'red'},
  accel: {title: '最强加速', sfx: '轰！', tone: 'amber'},
  corner: {title: '过弯', sfx: 'SWOOSH!', tone: 'violet'},
  brake: {title: '急减速', sfx: '吱——！', tone: 'red'},
  cruise: {title: '巡航', sfx: 'WHOOSH', tone: 'cyan'},
  milestone: {title: '速度突破', sfx: 'BREAK!', tone: 'amber'},
  finish: {title: '结束', sfx: 'FIN.', tone: 'ink'},
});

const valid = r => Number.isFinite(r?.speedKmh);
// 事件发生时刻对应的读数：不晚于事件时刻的最后一条有效读数（显示中的那一条）。
function readingAt(readings, t) {
  let hit = null;
  for (const r of readings) { if (r.t <= t + 1e-6 && valid(r)) hit = r; else if (r.t > t) break; }
  return hit;
}

export function selectMoments(record, {max = 6} = {}) {
  const readings = (record?.readings || []).filter(valid);
  if (readings.length < 2) return [];
  const events = record.events || [];
  const out = [];
  const used = new Set();
  const add = (kind, r, extra = {}) => {
    if (!r || used.has(r.t)) return false;
    used.add(r.t);
    out.push({kind, t: r.t, speedKmh: r.speedKmh, shown: r.shown, accelMs2: r.accelMs2 ?? null, world: r.world,
      simulated: !!r.simulated, source: r.source, distanceM: r.distanceM, score: r.score, ...extra});
    return true;
  };
  const firstEvent = k => events.find(e => e.kind === k);
  const launch = firstEvent('launch');
  add('launch', launch ? readingAt(readings, launch.t) : readings.find(r => r.speedKmh > 0));
  const top = readings.reduce((m, r) => (r.speedKmh > m.speedKmh ? r : m), readings[0]);
  add('top', top);
  const withAccel = readings.filter(r => Number.isFinite(r.accelMs2));
  const strongest = withAccel.filter(r => r.accelMs2 > .3).sort((a, b) => b.accelMs2 - a.accelMs2);
  for (const r of strongest) if (add('accel', r)) break;
  const corner = firstEvent('corner');
  if (corner) add('corner', readingAt(readings, corner.t));
  const brakes = withAccel.filter(r => r.accelMs2 < -.5).sort((a, b) => a.accelMs2 - b.accelMs2);
  for (const r of brakes) if (add('brake', r)) break;
  // 最精彩的一次突破（今日新高 > 等级 > 阈值）占一格；数值取当时那条读数。
  const ms = (record.milestones || []).filter(m => !m.comeback && Number.isFinite(m.threshold));
  if (ms.length) {
    const best = [...ms].sort((a, b) => (b.newHigh - a.newHigh) || (b.tier - a.tier) || (b.threshold - a.threshold))[0];
    const r = readingAt(readings, best.t);
    if (r) {
      const extra = {threshold: best.threshold, plan: best};
      const clash = out.findIndex(m => m.t === r.t);
      if (clash >= 0 && out[clash].kind !== 'launch') out.splice(clash, 1, {...out[clash], kind: 'milestone', ...extra});
      else if (clash < 0) add('milestone', r, extra);
    }
  }
  // 最后一格永远是结束；不足 4 格时补一格中段巡航。
  const last = record.readings[record.readings.length - 1];
  const finishReading = valid(last) ? last : readings[readings.length - 1];
  const keep = ['launch', 'milestone', 'top', 'brake', 'corner', 'accel'];
  const body = [...out].sort((a, b) => keep.indexOf(a.kind) - keep.indexOf(b.kind)).slice(0, max - 1);
  // 不足 3 格（短骑行时各时刻撞在同一条读数上）：按中段、三分点补巡航格，仍只用不同的已记录读数。
  for (const f of [.5, .33, .67, .2, .8]) {
    if (body.length >= 3) break;
    const mid = readings[Math.min(readings.length - 1, Math.floor(readings.length * f))];
    if (!used.has(mid.t) && mid !== readings[readings.length - 1]) { used.add(mid.t); body.push({kind: 'cruise', t: mid.t, speedKmh: mid.speedKmh, shown: mid.shown, accelMs2: mid.accelMs2 ?? null, world: mid.world, simulated: !!mid.simulated, source: mid.source, distanceM: mid.distanceM, score: mid.score}); }
  }
  body.sort((a, b) => a.t - b.t);
  const s = record.summary || {};
  body.push({kind: 'finish', t: finishReading.t, speedKmh: finishReading.speedKmh, shown: finishReading.shown, accelMs2: finishReading.accelMs2 ?? null,
    world: finishReading.world, simulated: !!finishReading.simulated, source: finishReading.source,
    distanceM: s.distanceM ?? finishReading.distanceM, durationS: s.durationS ?? finishReading.t, maxSpeedKmh: s.maxSpeedKmh ?? top.speedKmh, score: s.score ?? finishReading.score});
  return body.slice(0, max);
}

// 注释文本：values 列出本格用到的每一个格式化数值，测试据此核对“没有凭空数字”。
export function captionFor(m) {
  const copy = MOMENT_COPY[m.kind] || MOMENT_COPY.cruise;
  const speed = String(Math.round(m.speedKmh));
  const time = formatClock(m.t);
  const values = [time, speed];
  const lines = [`${speed} km/h`];
  if (Number.isFinite(m.accelMs2) && (m.kind === 'accel' || m.kind === 'brake' || m.kind === 'launch')) {
    const a = (m.accelMs2 >= 0 ? '+' : '−') + Math.abs(m.accelMs2).toFixed(1);
    values.push(a); lines.push(`${a} m/s²`);
  }
  if (m.kind === 'milestone' && Number.isFinite(m.threshold)) {
    const th = String(m.threshold);
    values.push(th);
    return {title: `突破 ${th} KM/H`, time, lines: [`${speed} km/h`, m.plan?.main ? actLabel(m.plan.main) : '速度突破'], sfx: m.plan?.newHigh ? '今日新高！' : 'BREAK!', tone: copy.tone,
      badge: m.simulated ? 'DEMO 模拟读数' : m.source === 'inertial' ? '惯导估计' : 'GPS 实测', values, big: null};
  }
  if (m.kind === 'finish') {
    const km = formatKm(m.distanceM), dur = formatClock(m.durationS), top = String(Math.round(m.maxSpeedKmh));
    values.push(km, dur, top);
    lines.splice(0, lines.length, `${dur} · ${km} km`, `最高 ${top} km/h`);
  }
  const badge = m.simulated ? 'DEMO 模拟读数' : m.source === 'inertial' ? '惯导估计' : 'GPS 实测';
  return {title: copy.title, time, lines, sfx: copy.sfx, tone: copy.tone, badge, values, big: m.kind === 'top' ? speed : null};
}

export function pageSummary(record) {
  const s = record?.summary || {};
  const values = [formatClock(s.durationS), formatKm(s.distanceM), String(Math.round(s.maxSpeedKmh ?? 0)), String(s.score ?? 0)];
  return {
    values,
    line: `时长 ${values[0]} · 里程 ${values[1]} km · 最高 ${values[2]} km/h`,
    score: `游戏分 ${values[3]}（游戏分 · 非驾驶评价）`,
    // 原生：里程、时长、最高速来自原生保存的汇总，读数来自保存的遥测时间线。
    source: s.simulated ? (s.origin === 'native' ? '数据：DEMO · 原生演示骑行（模拟读数）' : '数据：DEMO 模拟读数（1Hz），里程由读数积分') : s.origin === 'native' ? '数据：本机记录 · GPS 实测' : '数据：本机记录',
  };
}

const ROWS = Object.freeze({4: [1, 2, 1], 5: [1, 2, 2], 6: [1, 2, 2, 1]});

/* 斜切格页面：行分隔线交替倾斜，行内分隔线也带斜度；格间距 = gutter。 */
export function pageLayout(count, page = PAGE) {
  const n = Math.max(4, Math.min(6, count | 0));
  const rows = ROWS[n];
  const x0 = page.margin, x1 = page.W - page.margin, y0 = page.header, y1 = page.H - page.footer;
  const area = rectPoly(x0, y0, x1 - x0, y1 - y0);
  const weights = rows.map(c => (c === 1 ? .92 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const panels = [];
  let acc = 0;
  const lines = [];
  for (let i = 0; i < rows.length - 1; i++) {
    acc += weights[i];
    const y = y0 + (y1 - y0) * acc / total, d = (i % 2 ? -1 : 1) * 26;
    lines.push([[x1, y - d], [x0, y + d]]); // 从右到左，左侧 = 下方
  }
  for (let r = 0; r < rows.length; r++) {
    const planes = [];
    if (r > 0) { const [below] = cut(lines[r - 1][0], lines[r - 1][1], page.gutter); planes.push(below); }
    if (r < rows.length - 1) { const [, above] = cut(lines[r][0], lines[r][1], page.gutter); planes.push(above); }
    const row = clipAll(area, planes);
    if (rows[r] === 1) { panels.push({row: r, poly: row}); continue; }
    const ys = row.map(p => p[1]), top = Math.min(...ys), bottom = Math.max(...ys);
    const split = .5 + (r % 2 ? .08 : -.08), s = 34;
    const xm = x0 + (x1 - x0) * split;
    const [left, right] = cut([xm - s, bottom], [xm + s, top], page.gutter);
    panels.push({row: r, poly: clipAll(row, [left])}, {row: r, poly: clipAll(row, [right])});
  }
  return {page, count: n, panels: panels.slice(0, n)};
}

export function comicFilename(date = new Date()) {
  const p = v => String(v).padStart(2, '0');
  return `motuo-ride-comic-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.png`;
}
