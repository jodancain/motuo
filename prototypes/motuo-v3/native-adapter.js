/* 原生桥（v3 native runtime）：原生 → 网页 window.MotuoNativeReceive(snapshot)；网页 → 原生 webkit.messageHandlers.motuo。
 * 原生拥有记录、传感器、权限、导航、音乐、外观持久化与分享；网页只渲染。浏览器预览里没有 webkit 桥，本模块不生效。
 *
 * 快照（NativeCockpitView.swift CockpitSnapshotInput.json() 生成，v2 字段保留）：
 *   phase 'idle'|'riding'|'paused'，seconds（骑行计时，不含暂停），distanceM，speedKmh，speedSource 'gps'|'inertial'|'unavailable'，
 *   speedSampleTime（这条速度读数的单调时刻，GPS/演示 1Hz）、speedSampleElapsed（读数时的骑行计时）、sampleTime（快照时刻），
 *   uncertaintyKmh，motion，simulated，demoMode，reduced，thermal，thermalState 'nominal'|'fair'|'serious'|'critical'，lowPower，
 *   modal，active（驾驶舱 tab 可见且 App 前台），locationStatus，stateLabel，
 *   sound {live,status,level,db,spectrum[32],wave[64],clipped}，appearance {paint,finish,world}|null，panel {id,name}|null，
 *   finishedRide {id,distanceM,durationS,maxSpeedKmh,simulated,validSpeedSamples,timeline:[{t,v}],events:[{t,kind}]}，
 *   roadlog {active,bytes,motionHz,degraded}|null（路谱采集中时；只用于左上角小贴纸）
 * 动作（全部在 CockpitWebView.swift Coordinator.commands 白名单里，有测试扫描本目录源码核对）：见 NATIVE_ACTIONS。 */
export const NATIVE_STALE_MS = 1500;
const MOTIONS = new Set(['ready', 'launch', 'accelerate', 'cruise', 'load', 'turn', 'brake', 'stop', 'gps']);
export const PAINT_KEYS = Object.freeze(['panda', 'stealth', 'glacier', 'ember', 'violet']);
export const FINISH_KEYS = Object.freeze(['gloss', 'satin']);
export const WORLD_KEYS = Object.freeze(['neon', 'sunset', 'snow', 'cosmic']);

// 与 v2 共用的状态标题（准备出发 / 路上见 / 暂停中）。
export const rideTitle = phase => (phase === 'riding' ? '路上见' : phase === 'paused' ? '暂停中' : '准备出发');

/* 发热 / 低电量 → 画质封顶。serious、critical 或低电量模式 → 低档；旧版只有布尔 thermal 时同样按低档。 */
export function tierCap({thermalState = null, thermal = false, lowPower = false} = {}) {
  if (lowPower || thermalState === 'serious' || thermalState === 'critical') return 'low';
  if (!thermalState && thermal) return 'low';
  return null;
}

/* 路谱采集小贴纸文字：“路谱采集中 · 已记录 12.3 MB · 100Hz”；未采集返回 null。compact 用于竖屏窄宽。 */
export function roadlogLabel(r, {compact = false} = {}) {
  if (!r || typeof r !== 'object' || r.active !== true) return null;
  const mb = Number.isFinite(r.bytes) && r.bytes >= 0 ? (r.bytes / 1e6).toFixed(1) : null;
  const hz = Number.isFinite(r.motionHz) && r.motionHz > 0 ? `${Math.round(r.motionHz)}Hz` : null;
  const parts = compact ? ['路谱', mb && `${mb}MB`, hz] : ['路谱采集中', mb && `已记录 ${mb} MB`, hz];
  return parts.filter(Boolean).join(' · ') + (r.degraded ? (compact ? ' · 降级' : ' · 存储不足已降级') : '');
}

function cleanAppearance(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  if (PAINT_KEYS.includes(a.paint)) out.paint = a.paint;
  if (FINISH_KEYS.includes(a.finish)) out.finish = a.finish;
  if (WORLD_KEYS.includes(a.world)) out.world = a.world;
  return Object.keys(out).length ? out : null;
}

export function mapSnapshot(s, {receivedAt = 0, now = receivedAt} = {}) {
  if (!s || !['idle', 'riding', 'paused'].includes(s.phase)) return null;
  const stale = now - receivedAt > NATIVE_STALE_MS;
  const riding = s.phase === 'riding';
  const valid = riding && !stale && Number.isFinite(s.speedKmh) && s.speedKmh >= 0 && s.speedSource !== 'unavailable';
  const source = valid ? (s.speedSource === 'inertial' ? 'inertial' : 'gps') : 'unavailable';
  const elapsed = Math.max(0, Number.isFinite(s.seconds) ? s.seconds : 0);
  // 读数身份：GPS/演示按原生读数时刻（1Hz，同一条不重复计入）；惯导估计每个快照都是新估计；无读数只记一次。
  const sampleKey = source === 'gps' ? (Number.isFinite(s.speedSampleTime) ? s.speedSampleTime : s.sampleTime) : source === 'inertial' ? s.sampleTime : 'none';
  // 读数帧的时刻用骑行计时（不含暂停），与原生保存的时间线同一时基；漫画里的时刻因此是骑行时间。
  const t = source === 'gps' && Number.isFinite(s.speedSampleElapsed) ? Math.min(elapsed, Math.max(0, s.speedSampleElapsed)) : elapsed;
  const spectrum = Array.isArray(s.sound?.spectrum) ? s.sound.spectrum : [];
  const bands = Array.from({length: 16}, (_, i) => Math.max(0, Math.min(1, ((spectrum[i * 2] || 0) + (spectrum[i * 2 + 1] || 0)) / 2)));
  const fr = s.finishedRide && typeof s.finishedRide.id === 'string' ? s.finishedRide : null;
  return {
    phase: s.phase, stale, sampleKey: riding ? `${source}:${sampleKey}` : null,
    frame: riding ? {t, speedKmh: valid ? s.speedKmh : null, source, simulated: !!s.simulated, motion: MOTIONS.has(s.motion) ? s.motion : 'ready', uncertaintyKmh: Number.isFinite(s.uncertaintyKmh) ? s.uncertaintyKmh : null} : null,
    elapsedS: elapsed, distanceM: Math.max(0, s.distanceM || 0),
    sound: s.sound?.live && !stale && s.phase !== 'paused' ? {valid: true, demo: false, level: Math.max(0, Math.min(1, s.sound.level || 0)), bands, status: s.sound.status || '麦克风'} : {valid: false, status: s.sound?.status || '麦克风关闭'},
    reduced: !!s.reduced, thermal: !!s.thermal, thermalState: typeof s.thermalState === 'string' ? s.thermalState : null, lowPower: !!s.lowPower,
    cap: tierCap(s), modal: !!s.modal, active: s.active !== false, simulated: !!s.simulated, demoMode: !!s.demoMode,
    locationStatus: s.locationStatus || '', stateLabel: s.stateLabel || '', title: rideTitle(s.phase),
    appearance: cleanAppearance(s.appearance),
    roadlog: roadlogLabel(s.roadlog), roadlogCompact: roadlogLabel(s.roadlog, {compact: true}),
    panel: s.panel && typeof s.panel.id === 'string' && ['garage', 'world', 'sound', 'settings'].includes(s.panel.name) ? {id: s.panel.id, name: s.panel.name} : null,
    finishedRide: fr ? {
      id: fr.id, distanceM: Math.max(0, fr.distanceM || 0), durationS: Math.max(0, fr.durationS || 0),
      maxSpeedKmh: Number.isFinite(fr.maxSpeedKmh) ? Math.max(0, fr.maxSpeedKmh) : null, simulated: !!fr.simulated,
      validSpeedSamples: fr.validSpeedSamples | 0,
      timeline: Array.isArray(fr.timeline) ? fr.timeline.filter(p => Number.isFinite(p?.t)).map(p => ({t: p.t, v: Number.isFinite(p.v) && p.v >= 0 ? p.v : null})) : [],
      events: Array.isArray(fr.events) ? fr.events.filter(e => Number.isFinite(e?.t) && typeof e.kind === 'string').map(e => ({t: e.t, kind: e.kind})) : [],
    } : null,
  };
}

/* 网页 → 原生的全部动作。每个都必须在 CockpitWebView.swift 白名单里（Swift 与 node 测试都会扫描源码核对）。
 * 带参数的动作只允许这里列出的键；原生侧还会再校验取值。 */
export const NATIVE_ACTIONS = Object.freeze(['ready', 'primary', 'finish', 'demoStart', 'countdown', 'countdownCancel', 'microphone', 'stopMicrophone',
  'garage', 'appearance', 'share', 'wrappedShown', 'rideDetail', 'wrappedDone']);
const PAYLOAD_KEYS = Object.freeze({appearance: ['paint', 'finish', 'world'], share: ['png']});

export function nativeMessage(action, payload = {}) {
  if (!NATIVE_ACTIONS.includes(action)) return null;
  const msg = {action};
  for (const k of PAYLOAD_KEYS[action] || []) if (payload[k] !== undefined) msg[k] = payload[k];
  if (action === 'appearance') {
    const clean = cleanAppearance(msg);
    if (!clean) return null;
    return {action, ...clean};
  }
  if (action === 'share' && !(typeof msg.png === 'string' && msg.png.startsWith('data:image/png;base64,'))) return null;
  return msg;
}

export function installNativeAdapter(app, win = globalThis) {
  const host = win.webkit?.messageHandlers?.motuo;
  let receivedAt = 0, lastKey = null, lastPhase = 'idle', finishedId = null, lastPanel = null, active = true, lastAppearance = null;
  const send = (action, payload) => { const msg = nativeMessage(action, payload); if (host && msg) host.postMessage(msg); return !!(host && msg); };
  const perfNow = () => (win.performance || globalThis.performance).now();
  // 路谱贴纸：原生独有的一个小元素，不参与场景/剧场排版（pointer-events:none，见 native-runtime.css）。
  let badge = null, badgeText = null;
  const showRoadlog = (full, compact) => {
    const doc = win.document;
    if (!doc?.createElement || !doc.body) return;
    const portrait = (win.innerWidth || 0) < (win.innerHeight || 0);
    const text = portrait ? compact : full;
    if (text === badgeText) return;
    badgeText = text;
    if (!badge && text) {
      badge = doc.createElement('div'); badge.id = 'roadlog-badge'; badge.className = 'roadlog-badge';
      badge.setAttribute?.('role', 'status'); doc.body.appendChild(badge);
    }
    if (!badge) return;
    badge.textContent = text || ''; badge.hidden = !text;
  };
  win.MotuoNativeReceive = snapshot => {
    receivedAt = perfNow();
    const m = mapSnapshot(snapshot, {receivedAt, now: receivedAt});
    if (!m) return;
    if (m.active !== active) { active = m.active; app.nativeActive?.(active); }
    app.nativeFlags(m);
    showRoadlog(m.roadlog, m.roadlogCompact);
    if (m.appearance && JSON.stringify(m.appearance) !== lastAppearance) { lastAppearance = JSON.stringify(m.appearance); app.nativeAppearance?.(m.appearance); }
    if (m.phase !== lastPhase) { const old = lastPhase; lastPhase = m.phase; if (m.phase !== 'riding') lastKey = null; app.nativePhase(m.phase, old, m); }
    if (m.frame && m.sampleKey !== lastKey) { lastKey = m.sampleKey; app.nativeReading(m.frame, m); }
    if (m.panel && m.panel.id !== lastPanel) { lastPanel = m.panel.id; app.nativePanel?.(m.panel.name); }
    if (m.finishedRide && m.finishedRide.id !== finishedId) {
      finishedId = m.finishedRide.id;
      // 先确认接手复盘（原生据此取消 4 秒兜底）；生成失败时网页自己回传 rideDetail。
      send('wrappedShown');
      app.nativeFinished(m.finishedRide);
    } else if (!m.finishedRide && finishedId) { finishedId = null; app.nativeRecapReleased?.(); }
  };
  // 原生快照超过 1.5s 未到：速度显示 “—”。
  const watchdog = () => (host && lastPhase === 'riding' && perfNow() - receivedAt > NATIVE_STALE_MS ? app.nativeStale() : null);
  if (host) { win.setInterval?.(watchdog, 500); }
  return {native: !!host, send, ready: () => send('ready'), get active() { return active; }, get roadlogBadge() { return badgeText; }};
}
