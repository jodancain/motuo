/* 原生复盘 → 「今日骑行漫画」的骑行记录。
 * 数值只取原生保存的记录：时间线（遥测里保存的 GPS / 演示速度，约 1Hz，骑行计时时基）、汇总（里程、时长、最高速）、
 * 事件（原生检测的转向等）。网页实时记录只补充原生不保存的“游戏层”内容：所在世界、速度突破剧目、游戏分。
 * 时间线不足 2 条有效读数（例如旧记录）时退回网页实时记录；两者都不足就不生成漫画。纯函数，便于测试。 */

const NATIVE_EVENT_KIND = Object.freeze({turn: 'corner', braking: 'brake'});

function worldAt(worlds, t, fallback) {
  let w = fallback;
  for (const x of worlds || []) { if (x.t <= t + 1e-6) w = x.world; else break; }
  return w;
}

export function buildComicRecord({finished, live = null, makeModel, world = 'neon'}) {
  if (!finished || typeof makeModel !== 'function') return null;
  const simulated = !!finished.simulated;
  const timeline = (finished.timeline || []).filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const validCount = timeline.filter(p => Number.isFinite(p.v)).length;
  const liveWorlds = live?.worlds?.length ? live.worlds : [{t: 0, world}];
  const summary = {distanceM: finished.distanceM, durationS: finished.durationS, maxSpeedKmh: finished.maxSpeedKmh};
  let record;
  if (validCount >= 2) {
    // 按保存的读数重放：显示文本、差分加速度、游戏事件都由同一套规则从记录算出，不插值。
    const model = makeModel();
    const first = timeline[0].t;
    model.begin({t: first, source: 'native', world: worldAt(liveWorlds, first, world)});
    for (const p of timeline) {
      const w = worldAt(liveWorlds, p.t, world);
      if (w !== model.world) model.setWorld(w, p.t);
      model.ingest({t: p.t, speedKmh: p.v, source: Number.isFinite(p.v) ? 'gps' : 'unavailable', simulated, motion: 'cruise'});
      model.tick(p.t);
    }
    const end = Math.max(first, timeline[timeline.length - 1].t);
    record = model.finish(end, summary);
    record.origin = 'native-timeline';
  } else if (live && (live.readings || []).filter(r => Number.isFinite(r.speedKmh)).length >= 2) {
    record = {...live, readings: [...live.readings], events: [...live.events], summary: {...(live.summary || {}), ...summary}};
    record.origin = 'live';
  } else return null;
  // 原生检测事件（转向等）并入事件表；同类型以原生为准、保留时刻。
  for (const e of finished.events || []) {
    const kind = NATIVE_EVENT_KIND[e.kind];
    if (kind && Number.isFinite(e.t)) record.events.push({kind, t: e.t, native: true});
  }
  record.events.sort((a, b) => a.t - b.t);
  record.milestones = (live?.milestones || []).filter(m => Number.isFinite(m.t));
  record.worlds = liveWorlds;
  record.source = 'native';
  record.summary = {
    ...record.summary, ...summary, simulated,
    maxSpeedKmh: Number.isFinite(summary.maxSpeedKmh) ? summary.maxSpeedKmh : record.summary?.maxSpeedKmh ?? null,
    origin: 'native',
    // 游戏分以骑行中实际显示的为准（同一次骑行）；没有实时记录时用重放结果。
    score: live?.summary?.score ?? record.summary?.score ?? 0,
  };
  return record;
}
