/* 原生适配层：接收与 ios/Motuo/Cockpit/native-runtime.js 相同形状的快照 MotuoNativeReceive(state)，
 * 映射为 v3 的读数帧与控制信号。本轮只在 HTML 中可测，未接入原生工程。
 *
 * 输入快照（原生 RideEngine 推送，字段与 v2 一致）：
 *   phase 'idle'|'riding'|'paused'，seconds，distanceM，speedKmh，sampleTime，
 *   speedSource 'gps'|'inertial'|'unavailable'，uncertaintyKmh，motion，simulated，
 *   reduced，thermal，modal，musicPlaying，locationStatus，stateLabel，
 *   sound {live,status,level,db,spectrum[32],wave[64],clipped}，finishedRide {id,distanceM,durationS,maxSpeedKmh,simulated}
 */
export const NATIVE_STALE_MS = 1500;
const MOTIONS = new Set(['ready', 'launch', 'accelerate', 'cruise', 'load', 'turn', 'brake', 'stop', 'gps']);

export function mapSnapshot(s, {receivedAt = 0, now = receivedAt} = {}) {
  if (!s || !['idle', 'riding', 'paused'].includes(s.phase)) return null;
  const stale = now - receivedAt > NATIVE_STALE_MS;
  const riding = s.phase === 'riding';
  const valid = riding && !stale && Number.isFinite(s.speedKmh) && s.speedKmh >= 0 && s.speedSource !== 'unavailable';
  const source = valid ? (s.speedSource === 'inertial' ? 'inertial' : 'gps') : 'unavailable';
  // 读数时刻用原生 sampleTime（单调秒）；缺失时退回骑行秒数。同一 sampleTime 不重复计入。
  const t = Number.isFinite(s.sampleTime) ? s.sampleTime : Math.max(0, s.seconds || 0);
  const spectrum = Array.isArray(s.sound?.spectrum) ? s.sound.spectrum : [];
  const bands = Array.from({length: 16}, (_, i) => Math.max(0, Math.min(1, ((spectrum[i * 2] || 0) + (spectrum[i * 2 + 1] || 0)) / 2)));
  return {
    phase: s.phase, stale,
    frame: riding ? {t, speedKmh: valid ? s.speedKmh : null, source, simulated: !!s.simulated, motion: MOTIONS.has(s.motion) ? s.motion : 'ready', uncertaintyKmh: Number.isFinite(s.uncertaintyKmh) ? s.uncertaintyKmh : null} : null,
    elapsedS: Math.max(0, s.seconds || 0), distanceM: Math.max(0, s.distanceM || 0),
    sound: s.sound?.live && !stale && s.phase !== 'paused' ? {valid: true, demo: false, level: Math.max(0, Math.min(1, s.sound.level || 0)), bands, status: s.sound.status || '麦克风'} : {valid: false, status: s.sound?.status || '麦克风关闭'},
    reduced: !!s.reduced, thermal: !!s.thermal, modal: !!s.modal, simulated: !!s.simulated,
    locationStatus: s.locationStatus || '', finishedRide: s.finishedRide && s.finishedRide.id ? {...s.finishedRide} : null,
  };
}

// 原生动作白名单与 CockpitWebView.swift 的 commands 一致的子集。
export const NATIVE_ACTIONS = Object.freeze(['ready', 'primary', 'finish', 'demoStart', 'microphone', 'stopMicrophone', 'garage', 'settings', 'wrappedShown', 'rideDetail', 'wrappedDone']);

export function installNativeAdapter(app, win = globalThis) {
  const host = win.webkit?.messageHandlers?.motuo;
  let receivedAt = 0, lastT = null, lastPhase = 'idle', finishedId = null;
  const send = action => { if (host && NATIVE_ACTIONS.includes(action)) host.postMessage({action}); };
  win.MotuoNativeReceive = snapshot => {
    receivedAt = performance.now();
    const m = mapSnapshot(snapshot, {receivedAt, now: receivedAt});
    if (!m) return;
    if (m.phase !== lastPhase) app.nativePhase(m.phase, lastPhase);
    lastPhase = m.phase;
    app.nativeFlags(m);
    if (m.frame && m.frame.t !== lastT) { lastT = m.frame.t; app.nativeReading(m.frame, m); }
    if (m.finishedRide && m.finishedRide.id !== finishedId) { finishedId = m.finishedRide.id; app.nativeFinished(m.finishedRide); send('wrappedShown'); }
  };
  // 原生快照超过 1.5s 未到：速度显示 “—”。
  const watchdog = () => (host && lastPhase === 'riding' && performance.now() - receivedAt > NATIVE_STALE_MS ? app.nativeStale() : null);
  if (host) { send('ready'); win.setInterval?.(watchdog, 500); }
  return {native: !!host, send};
}
