/* 骑行数据模型：读数 → 显示文本、差分加速度、里程、游戏事件与“骑行记录”。
 * 速度显示永远是“最新一条有效读数取整”；动画层拿不到任何中间值。
 * signals / game 工厂注入（浏览器里来自复制的 v2 drive-signals.js 与 game-events.js）。
 */

export const SOURCE_LABEL = Object.freeze({
  demo: 'DEMO 模拟读数', gps: 'GPS 实测', inertial: '惯导短时估计', unavailable: '等待有效定位',
});

export function speedText({phase, reading}) {
  if (phase === 'idle' || phase === 'countdown') return {text: '0', known: false, estimated: false};
  const has = !!reading && Number.isFinite(reading.speedKmh) && reading.source !== 'unavailable';
  // 暂停：定格最后一条真实读数（标“定格”），没有读数则显示 “—”。不产生新值。
  if (phase === 'paused') return has ? {text: String(Math.max(0, Math.round(reading.speedKmh))), known: true, estimated: reading.source === 'inertial', frozen: true} : {text: '—', known: false, estimated: false, frozen: true};
  if (phase !== 'riding' || !has) return {text: '—', known: false, estimated: false};
  const estimated = reading.source === 'inertial';
  return {text: String(Math.max(0, Math.round(reading.speedKmh))), known: true, estimated};
}

export function sourceLabel(reading, phase) {
  if (phase === 'paused') return '记录已暂停';
  if (!reading) return phase === 'riding' ? SOURCE_LABEL.unavailable : '待机';
  if (reading.simulated) return SOURCE_LABEL.demo;
  return SOURCE_LABEL[reading.source] || SOURCE_LABEL.unavailable;
}

export const formatClock = s => {
  const v = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};
export const formatKm = m => (Math.max(0, m || 0) / 1000).toFixed(2);

export function createRideModel({signals, game, gameHz = 10}) {
  if (!signals?.create || !game?.createGame) throw new TypeError('ride model needs drive-signals and game modules');
  const tracker = signals.create();
  const gameState = game.createGame();
  let phase = 'idle', reading = null, accel = null, accelStatus = 'idle', segment = 0, rideT = 0;
  let distanceM = 0, lastDistanceReading = null, lastGameT = -Infinity, motion = 'ready';
  let record = null, listeners = new Set(), world = 'neon', paint = null, modal = false;

  const emit = list => { for (const ev of list) for (const fn of [...listeners]) fn(ev); };

  function begin({t = 0, source = 'demo', world: w = world, paint: p = paint, title = ''} = {}) {
    tracker.reset(); gameState.reset();
    phase = 'riding'; reading = null; accel = null; accelStatus = 'warming'; segment++;
    rideT = t; distanceM = 0; lastDistanceReading = null; lastGameT = -Infinity; motion = 'ready';
    world = w; paint = p;
    record = {startedAt: new Date().toISOString(), source, title, readings: [], events: [], worlds: [{t, world}], pauses: [], milestones: [], finishedAt: null, summary: null};
  }

  // 一条读数帧：{t, speedKmh, source:'gps'|'inertial'|'unavailable', simulated, motion}
  function ingest(frame) {
    if (phase !== 'riding' || !frame) return null;
    rideT = Math.max(rideT, frame.t);
    motion = frame.motion || motion;
    const valid = Number.isFinite(frame.speedKmh) && frame.speedKmh >= 0 && frame.source !== 'unavailable';
    reading = {t: frame.t, speedKmh: valid ? frame.speedKmh : null, source: valid ? (frame.source || 'gps') : 'unavailable',
      simulated: !!frame.simulated, motion, uncertaintyKmh: frame.uncertaintyKmh ?? null};
    const s = tracker.sample({phase: 'riding', seconds: frame.t, speedKmh: valid ? frame.speedKmh : NaN,
      source: reading.source === 'unavailable' ? 'gps' : reading.source, scenario: 'normal', scenarioStarted: segment, motion});
    accel = s.accelMs2; accelStatus = s.status;
    // 里程：相邻有效读数梯形积分（2s 以上缺口不计），DEMO 时随读数一起标注 DEMO。
    if (valid && lastDistanceReading && frame.t - lastDistanceReading.t > 0 && frame.t - lastDistanceReading.t <= 2) {
      distanceM += (lastDistanceReading.speedKmh + frame.speedKmh) / 2 / 3.6 * (frame.t - lastDistanceReading.t);
    }
    lastDistanceReading = valid ? {t: frame.t, speedKmh: frame.speedKmh} : null;
    const entry = {t: frame.t, speedKmh: reading.speedKmh, shown: speedText({phase, reading}).text, accelMs2: accel,
      motion, source: reading.source, simulated: reading.simulated, world, distanceM, score: gameState.score};
    record.readings.push(entry);
    return entry;
  }

  // 主时钟每帧调用；游戏层以 gameHz 读“当前已显示”的值（保持，不插值）。
  function tick(t) {
    if (phase !== 'riding' || modal) return [];
    rideT = Math.max(rideT, t);
    if (t - lastGameT < 1 / gameHz - 1e-6) return [];
    lastGameT = t;
    const shown = speedText({phase, reading});
    const events = gameState.update({t, active: true, paused: false, speedKmh: shown.known ? reading.speedKmh : null,
      estimated: shown.estimated, accel: accelStatus === 'valid' ? accel : null, motion});
    for (const ev of events) {
      const at = {...ev, speedShown: shown.text, readingT: reading?.t ?? null, world};
      if (ev.kind !== 'rhythm') record.events.push(at);
    }
    emit(events.map(ev => ({...ev, speedShown: shown.text, readingT: reading?.t ?? null})));
    return events;
  }

  function pause(t) {
    if (phase !== 'riding') return;
    phase = 'paused'; record.pauses.push({t}); tracker.reset(); accel = null; accelStatus = 'paused';
    lastDistanceReading = null;
  }
  function resume(t) {
    if (phase !== 'paused') return;
    phase = 'riding'; segment++; accelStatus = 'warming'; reading = null;
    const last = record.pauses[record.pauses.length - 1]; if (last) last.resumedT = t;
  }
  function setWorld(next, t = rideT) {
    world = next;
    if (record && phase !== 'idle') record.worlds.push({t, world});
  }
  function finish(t = rideT, {distanceM: nativeDistance = null, durationS = null, maxSpeedKmh = null} = {}) {
    if (!record) return null;
    const sum = gameState.summary();
    const valid = record.readings.filter(r => Number.isFinite(r.speedKmh));
    record.finishedAt = new Date().toISOString();
    record.summary = {
      durationS: durationS ?? t,
      distanceM: nativeDistance ?? distanceM,
      maxSpeedKmh: maxSpeedKmh ?? (valid.length ? Math.max(...valid.map(r => r.speedKmh)) : null),
      simulated: record.readings.some(r => r.simulated),
      score: sum.score, maxCombo: sum.maxCombo, rating: sum.rating, scoreLabel: '游戏分 · 非驾驶评价',
    };
    phase = 'idle'; reading = null; accel = null;
    const done = record; return done;
  }
  function reset() { phase = 'idle'; reading = null; accel = null; tracker.reset(); gameState.reset(); record = null; distanceM = 0; }

  return {
    begin, ingest, tick, pause, resume, finish, reset, setWorld,
    setPaint(p) { paint = p; },
    setModal(v) { modal = !!v; },
    get modal() { return modal; },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get phase() { return phase; }, get reading() { return reading; },
    get accel() { return accelStatus === 'valid' ? accel : null; }, get accelStatus() { return accelStatus; },
    get distanceM() { return distanceM; }, get rideT() { return rideT; }, get motion() { return motion; },
    get score() { return gameState.score; }, get combo() { return gameState.combo; },
    get record() { return record; }, get world() { return world; },
    get display() { return speedText({phase, reading}); },
  };
}
