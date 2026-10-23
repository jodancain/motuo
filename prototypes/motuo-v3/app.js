/* Motuo v3 · 骑行即漫画 MV —— 主程序。
 * 状态：idle → countdown → riding ⇄ paused → finishing → comic → idle
 * 一个 rAF（core/loop.js）驱动：world 60fps · bike 12fps · fx 30fps · logic 每帧。
 */
import {createLoop, createPerfGovernor, TIER_CONFIG} from './core/loop.js';
import {buildDemoScript, createDemoPlayer} from './core/demo-script.js';
import {createRideModel, speedText, sourceLabel, formatClock, formatKm} from './core/ride-model.js';
import {createDirector, createFlashLimiter, cutinLayout, IMPACT_MS} from './core/director.js';
import {selectMoments, PAGE, PAGE_LANDSCAPE} from './core/comic-layout.js';
import {createComicView} from './render/comic-view.js';
import {stageLayout, speedFit, countdownFit, maxDash, clampBikeShift, bikeMapping as mapBike} from './core/layout.js';
import {tracePath} from './core/geometry.js';
import {WORLDS, WORLD_ORDER, nextWorld, normalizeWorld} from './render/worlds.js';
import {createWorldPainter} from './render/scene.js';
import {createBike, bikeMapping} from './render/bike.js';
import {createFx, drawWheelArcs, drawContactShadow} from './render/fx.js';
import {createCutinRenderer} from './render/cutin.js';
import {renderComicPage, downloadComic, exportComic} from './render/comic-render.js';
import {createSfx} from './audio/sfx.js';
import {createSoundSource} from './audio/sound.js';
import {installNativeAdapter} from './native-adapter.js';
import {buildComicRecord} from './core/native-record.js';
import {createResizeController} from './core/resize.js';
import {createMilestoneDirector, ACTS as MILESTONE_ACTS} from './core/milestone-director.js';
import {createMilestonePlayer} from './render/milestone-player.js';
import {GALLERY_ITEMS, GALLERY_TIERS, galleryPlan} from './core/milestone-gallery.js';
import {vehicleVisuals, createVehicleDirector, placeWord, reducedHint, normalizeVehicle, FX_LEVELS} from './core/vehicle-fx.js';
import {createReplayPlayer} from './core/vehicle-replay.js';
import {generateSynthetic} from './core/vehicle-synth.js';

const $ = id => document.getElementById(id);
// 脚本错误计数（屏幕阅读器可读、原生 UI 测试断言为 0）；渲染任务出错会被主时钟移除，这里让它不再静默。
let scriptErrors = 0;
const noteError = e => { scriptErrors++; const el = $('ax-error'); if (el) el.textContent = `座舱脚本错误 ${scriptErrors}：${String(e?.message || e?.reason?.message || e?.reason || e).slice(0, 120)}`; };
addEventListener('error', noteError); addEventListener('unhandledrejection', noteError);
const app = $('app'), panel = $('panel'), camera = $('camera');
const sceneCanvas = $('scene'), fxCanvas = $('fx'), cutCanvas = $('cutin'), flipCanvas = $('flip');
const speedEl = $('speed'), speedValue = $('speed-value'), ghosts = [...speedEl.querySelectorAll('.speed-ghost')];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => performance.now();
const Game = globalThis.MotuoGame, Signals = globalThis.MotuoDriveSignals;

/* ---------- 偏好 ---------- */
const PREF_KEY = 'motuo.v3.prefs';
const PRESETS = Object.freeze({ // 与 v2 vehicle-garage.js 预设一致
  panda: {name: '熊猫白', bodyColor: '#f2f1ec', accentColor: '#171b22'},
  stealth: {name: '曜石黑', bodyColor: '#252b35', accentColor: '#b8c4ce'},
  glacier: {name: '冰川蓝', bodyColor: '#409bc6', accentColor: '#131c2c'},
  ember: {name: '熔岩红', bodyColor: '#c93241', accentColor: '#191c24'},
  violet: {name: '电光紫', bodyColor: '#7854ba', accentColor: '#191a28'},
});
let prefs = {world: 'neon', paint: 'ember', finish: 'gloss', tier: 'auto', sfx: true, reduce: 'system', fx: 'std'};
try { prefs = {...prefs, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}')}; } catch { /* 默认值 */ }
prefs.world = normalizeWorld(prefs.world);
if (!PRESETS[prefs.paint]) prefs.paint = 'ember';
if (!(prefs.fx in FX_LEVELS)) prefs.fx = 'std';
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 预览不保存 */ } };

/* ---------- 子系统 ---------- */
const governor = createPerfGovernor();
const loop = createLoop({raf: f => requestAnimationFrame(f), caf: h => cancelAnimationFrame(h), now, hidden: () => document.hidden || !!S.nativeInactive, governor});
const limiter = createFlashLimiter({maxPerSecond: 2});
const sysReduced = matchMedia('(prefers-reduced-motion: reduce)');
const isReduced = () => prefs.reduce === 'on' || sysReduced.matches || S.nativeReduced;
const director = createDirector({limiter, reduced: isReduced});
const vdirector = createVehicleDirector({requestFlash: (t, kind) => director.requestFlash(t, kind)});
const VIS_REST = vehicleVisuals(null);
const ride = createRideModel({signals: Signals, game: Game});
const painter = createWorldPainter();
const fx = createFx();
const cutRenderer = createCutinRenderer();
// 速度突破剧场：导演（读数 → 计划）+ 播放器（计划 → 画面）。演示用固定种子，可复现。
let mdir = createMilestoneDirector({seed: 20261021, storage: globalThis.localStorage});
const IDLE_CAM = Object.freeze({sceneScale: 1, panX: 0, timeScale: 1, desat: 0});
const sfx = createSfx({enabled: prefs.sfx});
const sound = createSoundSource();
const bike = createBike({glCanvas: $('bike-gl'), vecCanvas: $('bike-vec'), modelURL: './assets/models/suzuki-gsx-r1000/model.glb',
  onStatus: s => { $('bike-mode').textContent = s.status === 'ready' ? '漫画渲染：实时 GLB（GSX-R1000 近似外观）· 12fps 步进' : s.status === 'fallback' ? s.message : s.message; app.dataset.bike = s.status; }});
const script = buildDemoScript();
const mplayer = createMilestonePlayer({canvas: $('milestone'), reduced: () => isReduced(), requestFlash: (t, kind) => flash(kind, .4), shake: v => { S.shake = Math.max(S.shake, v); }});

const S = {
  phase: 'idle', mode: null, world: prefs.world, W: 1, H: 1, L: null, dpr: 1,
  speedVis: 0, idleBoost: 0, tilt: 0, shake: 0, focus: 0, lastSpeedText: null, nativeReduced: false,
  wheelieUntil: 0, wheeliePitch: -.3, brakeUntil: 0, cornerUntil: 0, revUntil: 0, burn: null, dash: null, drag: null, drift: null,
  cut: null, cutStep: -1, countdownLabel: '', goUntil: 0, demoSoundRestore: null, lastSmoke: 0, lastSoundT: 0, comic: null,
  eventsLog: [], sound: {valid: false},
  // 车辆状态（估计器快照，原生或浏览器回放）与平滑后的画面参数。
  vs: null, vsAt: 0, vis: null, roll: 0, lungeKick: 0, nextFlame: 0, nextPuff: 0, nextRipple: 0, nextRev: 0, joltUntil: 0, vsWords: [],
};
const st = {x: 0, t: 0, speed: 0, accel: null, eq: null, misprint: true, particles: 1, weather: [], lines: [], focus: 0, focusX: 0, focusY: 0, dt: 0};
const springs = {pitch: {x: 0, v: 0}, yaw: {x: 0, v: 0}, squash: {x: 1, v: 0}};
const spring = (s, target, dt, k = 140, c = 17) => { s.v += (k * (target - s.x) - c * s.v) * dt; s.x += s.v * dt; };

/* ---------- 版式 ---------- */
function tier() { return TIER_CONFIG[governor.tier]; }
/* 安全区内边距：原生全出血时场景铺满整屏，HUD 与演员按 env(safe-area-inset-*) 内缩。浏览器里为 0。 */
function readSafe() {
  const cs = getComputedStyle($('safe-probe')), px = v => Math.round(parseFloat(v) || 0);
  return {t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft)};
}
function measure() { const sa = readSafe(); return {W: Math.max(1, panel.clientWidth), H: Math.max(1, panel.clientHeight), dpr: devicePixelRatio || 1, sa, key: `${sa.t},${sa.r},${sa.b},${sa.l}`}; }
// 旋转第一拍（每帧最多一次）：只改 DOM 版式，速度巨字立即按新尺寸适配；画布保持旧缓冲由 CSS 拉伸，不清空。
function layoutLive({W, H, sa}) {
  const L = stageLayout(W, H, sa);
  app.classList.toggle('landscape', L.landscape); app.classList.toggle('portrait', !L.landscape);
  S.liveL = L; fitSpeed(true);
  // 按旧尺寸定位的短命层（拟声字、粒子）直接收掉，不在新版式里错位残留。
  $('sfx-layer').replaceChildren(); fx.clear();
  // 漫画页：换到对应方向的版式，揭示立即收尾，本帧就整页上屏（不出现空格）。
  if (S.phase === 'comic' && comicView) comicView.orient(L.landscape ? 'landscape' : 'portrait', now());
  S.layoutLive = (S.layoutLive || 0) + 1;
}
// 尺寸稳定后：按新尺寸与 devicePixelRatio 重建缓冲，并让正在进行的分镜、剧场、倒计时按新版式继续。
function layoutSettle({W, H, dpr, sa}) {
  S.W = W; S.H = H; S.safe = sa; S.L = stageLayout(W, H, sa); S.liveL = S.L;
  app.classList.toggle('landscape', S.L.landscape); app.classList.toggle('portrait', !S.L.landscape);
  const t = tier();
  S.dpr = Math.min(dpr, t.dpr);
  for (const c of [sceneCanvas, fxCanvas, cutCanvas, flipCanvas, $('milestone')]) {
    const w = Math.round(W * S.dpr), h = Math.round(H * S.dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }
  bike.layout(S.L, W, H, Math.min(dpr, t.bikeDpr));
  const m = bikeMapping(S.L), hit = $('bike-hit');
  Object.assign(hit.style, {left: m.sx(-1.05) + 'px', top: m.sy(1.2) + 'px', width: (m.sx(1.05) - m.sx(-1.05)) + 'px', height: (S.L.bike.ground - m.sy(1.2) + 10) + 'px'});
  app.style.setProperty('--cd-x', S.L.landscape ? '-16%' : '0%');
  fitSpeed(true);
  // 缓冲重建后同一刻重画世界与车，不留空帧。
  if (S.phase !== 'comic') paintWorld(0);
  bike.render();
  // 翻页截的是旧尺寸画面：直接收尾。
  flipCanvas.getAnimations?.().forEach(a => a.finish()); flipCanvas.hidden = true;
  // 分镜：按新尺寸重算斜切版式继续；剧场：每帧按进度重画，换新环境继续。
  if (S.cut) { S.cut.layout = cutinLayout(S.cut.plan.kind, W, H, speedRect()); S.cutStep = -1; }
  if (mplayer.active) mplayer.relayout(milestoneEnv());
  // 倒计时 / GO / FIN：按新尺寸重放当前字（不再做砸入动画）。
  if (S.countdownShown) showCountdown(S.countdownShown.text, S.countdownShown.cls, {quiet: true});
  S.relayouts = (S.relayouts || 0) + 1;
  setText('ax-layout', `布局 ${S.L.landscape ? '横屏' : '竖屏'} ${W}×${H} · 重排 ${S.relayouts}`);
}
const resizer = createResizeController({measure, live: layoutLive, settle: layoutSettle});
function resize() { resizer.now(); }
function fitSpeed(force) {
  const L = S.liveL || S.L;
  if (!L) return;
  const text = speedValue.textContent || '0';
  const digits = Math.max(2, text.replace(/[^0-9—]/g, '').length);
  if (!force && digits === S.fitDigits) return;
  S.fitDigits = digits;
  const f = speedFit(L, digits);
  app.style.setProperty('--speed-size', f.fontSize + 'px');
  app.style.setProperty('--speed-sx', String(f.scaleX));
  app.style.setProperty('--speed-right', L.speed.right + 'px');
  app.style.setProperty('--speed-top', L.speed.top + 'px');
}
function speedRect() {
  const p = panel.getBoundingClientRect(), r = speedEl.getBoundingClientRect();
  return {x: r.left - p.left - panel.clientLeft, y: r.top - p.top - panel.clientTop, w: r.width, h: r.height};
}

/* ---------- 速度与 HUD ---------- */
function currentSpeed() {
  if (S.phase === 'riding' || S.phase === 'paused') return speedText({phase: ride.phase === 'riding' ? 'riding' : 'paused', reading: ride.reading});
  if (S.phase === 'gallery') return {text: String(S.galleryReading || 0), known: true, estimated: false, preview: true};
  return {text: '0', known: false, estimated: false};
}
function renderSpeed() {
  const d = currentSpeed();
  // 只在变化时写 DOM：巨字带描边与网点，每帧改属性会触发整块重绘。
  const frozen = !!(d.frozen && d.known);
  if (frozen !== S.frozenShown) { S.frozenShown = frozen; speedEl.toggleAttribute('data-frozen', frozen); $('speed-frozen').hidden = !frozen; }
  if (d.text !== S.lastSpeedText) {
    S.lastSpeedText = d.text;
    speedValue.textContent = d.text; speedValue.dataset.v = d.text;
    for (const g of ghosts) g.textContent = d.text;
    fitSpeed(false);
    // 新读数到达：整体替换 + 120ms 盖章，数字始终完整可见。
    if (d.known && !d.frozen && !isReduced()) speedValue.animate([{transform: 'scale(1.1)'}, {transform: 'scale(1)'}], {duration: 120, easing: 'steps(3,end)'});
  }
  if ($('speed-est').hidden === d.estimated) $('speed-est').hidden = !d.estimated;
  if ((d.text === '—') !== S.unknownShown) { S.unknownShown = d.text === '—'; speedEl.classList.toggle('unknown', S.unknownShown); }
  const r = ride.reading;
  const stampText = S.phase === 'gallery' ? '预览 · 非骑行数据' : S.mode === 'replay' ? '回放' : 'DEMO';
  if ($('speed-stamp').textContent !== stampText) $('speed-stamp').textContent = stampText;
  const stampHidden = S.phase !== 'gallery' && !(S.phase !== 'idle' && r?.simulated) && !(S.mode === 'demo' && S.phase !== 'idle');
  if ($('speed-stamp').hidden !== stampHidden) $('speed-stamp').hidden = stampHidden;
  const heat = d.known ? Game.heat(Number(d.text)) : null, heatCss = heat ? heat.css : '#8de8ff';
  if (heatCss !== S.heatCss) { S.heatCss = heatCss; app.style.setProperty('--heat', heatCss); }
  if (S.ariaFor === d.text + r?.simulated) return;
  S.ariaFor = d.text + r?.simulated;
  speedEl.setAttribute('aria-label', d.known ? `速度 ${d.text} 公里每小时${d.estimated ? '，惯导估计' : ''}${d.frozen ? '，暂停定格的最后读数' : ''}${r?.simulated ? '，演示数据' : ''}` : '速度未知');
}
const setText = (id, v) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };
function renderHud() {
  const riding = S.phase === 'riding' || S.phase === 'paused' || S.phase === 'finishing';
  setText('clock', riding ? formatClock(S.mode === 'native' ? S.nativeElapsed : ride.rideT) : '00:00');
  setText('dist', riding ? formatKm(S.mode === 'native' ? S.nativeDistance : ride.distanceM) : '0.00');
  setText('source', S.phase === 'countdown' ? (S.mode === 'native' ? '倒计时 · 出发后开始记录' : S.mode === 'replay' ? `倒计时 · ${S.replayLabel}` : '倒计时 · DEMO') : riding ? (S.mode === 'replay' ? S.replayLabel : sourceLabel(ride.reading, S.phase)) : S.mode === 'native' ? '原生待机 · 未在记录' : '待机 · 未在记录');
  setText('sound-status', S.sound.valid ? (S.sound.demo ? '声浪 DEMO' : '麦克风声浪') : S.mode === 'native' && sound.mode !== 'demo' ? (S.nativeSoundStatus || '麦克风关闭') : sound.status);
  if (S.mode === 'native') setText('ride-title', S.nativeTitle || '准备出发');
  const sec = riding ? Math.floor(S.mode === 'native' ? S.nativeElapsed || 0 : ride.rideT) : 0;
  setText('ax-clock', `骑行计时 ${sec} 秒`);
  setText('ax-theatre', mplayer.active ? '突破剧场播放中' : '突破剧场空闲');
  setText('ax-comic', S.phase === 'comic' && comicView ? `漫画 ${comicView.current === 'landscape' ? '横版' : '竖版'} ${comicView.revealing ? '揭示中' : '完整'}` : '漫画 无');
  setText('score', `游戏分 ${ride.score.toLocaleString('en-US')}`);
  setText('tier-badge', tier().label);
}
function applyWorldLabels() {
  const w = WORLDS[S.world];
  app.dataset.world = w.key;
  setText('chapter', w.chapter); setText('world-name', w.name); setText('world-en', w.en);
  for (const [k, v] of [['--c', w.c], ['--m', w.m], ['--accent', w.accent], ['--yellow', w.y]]) app.style.setProperty(k, v);
  document.querySelectorAll('.world-card').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.world === w.key)));
}

/* ---------- 拟声字 / 闪光 ---------- */
function word(text, x, y, size, {rot = -10, han = /[一-鿿]/.test(text), ms = 720} = {}) {
  if (isReduced()) return;
  const el = document.createElement('span');
  el.className = 'sfx-word' + (han ? ' han' : '');
  el.textContent = text;
  Object.assign(el.style, {left: x + 'px', top: y + 'px', fontSize: size + 'px'});
  el.style.setProperty('--r', rot + 'deg');
  $('sfx-layer').append(el);
  const a = el.animate([{scale: .3, opacity: 1}, {scale: 1.18, opacity: 1, offset: .2}, {scale: 1, opacity: 1, offset: .35}, {scale: 1.02, opacity: 1, offset: .8}, {scale: 1.1, opacity: 0}], {duration: ms, easing: 'steps(9,end)'});
  a.onfinish = () => el.remove();
}
function flash(kind, peak = .55) {
  if (!director.requestFlash(now(), kind)) return false;
  $('flash').animate([{opacity: 0}, {opacity: peak, offset: .3}, {opacity: 0}], {duration: 140});
  return true;
}

/* ---------- 翻页转场 ---------- */
function composite(sepia = false) {
  const g = flipCanvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, flipCanvas.width, flipCanvas.height);
  g.filter = sepia ? 'sepia(.85) saturate(.6) contrast(1.06)' : 'none';
  g.drawImage(sceneCanvas, 0, 0, flipCanvas.width, flipCanvas.height);
  g.drawImage(bike.mode === 'glb' ? $('bike-gl') : $('bike-vec'), 0, 0, flipCanvas.width, flipCanvas.height);
  g.drawImage(fxCanvas, 0, 0, flipCanvas.width, flipCanvas.height);
  g.filter = 'none';
  // 页边阴影，像真的纸张
  const grad = g.createLinearGradient(flipCanvas.width * .8, 0, flipCanvas.width, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,.35)');
  g.fillStyle = grad; g.fillRect(0, 0, flipCanvas.width, flipCanvas.height);
}
function pageFlip(sepia = false) {
  if (isReduced()) return Promise.resolve();
  composite(sepia);
  flipCanvas.hidden = false;
  sfx.play('flip');
  const a = flipCanvas.animate([
    {transform: 'perspective(1400px) rotateY(0deg)', filter: 'brightness(1)'},
    {transform: 'perspective(1400px) rotateY(-38deg)', filter: 'brightness(.92)', offset: .35},
    {transform: 'perspective(1400px) rotateY(-100deg)', filter: 'brightness(.6)'}], {duration: 680, easing: 'cubic-bezier(.5,0,.75,.4)'});
  return a.finished.catch(() => {}).then(() => { flipCanvas.hidden = true; });
}
function switchWorld(key, {flip = true} = {}) {
  key = normalizeWorld(key);
  if (key === S.world) return;
  const p = flip ? pageFlip(false) : null;
  S.world = key; prefs.world = key; savePrefs();
  ride.setWorld(key);
  applyWorldLabels();
  paintWorld(0); // 立即在翻起的纸下画好新世界
  if (S.phase === 'riding') word(WORLDS[key].en, S.W * .34, S.H * .3, Math.min(S.W, S.H) * .11, {rot: -6});
  return p;
}

/* ---------- 演示驾驶 ---------- */
let player = null;
function startDemo() {
  if (S.phase !== 'idle') return;
  sfx.unlock();
  closeSheets();
  S.mode = 'demo';
  // 演示驾驶使用声浪 DEMO（合成特征，标注 DEMO）；结束后恢复原选择。
  if (sound.mode !== 'mic') { S.demoSoundRestore = sound.mode; sound.setMode('demo'); }
  player = createDemoPlayer(script, {
    countdown: () => { setPhase('countdown'); S.burn = {t0: now(), auto: true}; $('btn-skip').hidden = false; },
    go: () => goRide({t: 0, source: 'demo'}),
    reading: frame => { ride.ingest(frame); sound.setDemoLevel(frame.soundLevel); milestoneReading(frame); },
    cue: cue => { if (cue.type === 'world') switchWorld(nextWorld(S.world)); },
    pause: () => doPause(),
    resume: () => doResume(),
    finish: () => doFinish(),
  });
  player.start();
}
function goRide({t = 0, source, fanfare = true}) {
  $('btn-skip').hidden = true;
  clearCountdown();
  S.burn = null; S.nativeCountdown = null;
  ride.begin({t, source, world: S.world, paint: prefs.paint});
  const simulated = source === 'demo' || (source === 'native' && !!S.nativeSimulated);
  mdir = createMilestoneDirector({seed: source === 'demo' ? 20261021 : (Date.now() & 0xffffff), storage: globalThis.localStorage});
  mdir.begin({simulated});
  // 原生演示骑行：没有麦克风时用声浪 DEMO（合成特征，标注 DEMO），结束后恢复。
  if (source === 'native' && simulated && sound.mode === 'off') { S.demoSoundRestore = sound.mode; sound.setMode('demo'); }
  setPhase('riding');
  updateNativeControls();
  if (!fanfare) return;
  S.goUntil = now() + 900;
  showCountdown('GO!!', 'go');
  sfx.play('go');
  if (!isReduced()) goImpact();
  S.dash = {t0: now(), power: .55, go: true};
  if (!isReduced()) fx.emit('ring', bike.point('rearContact').x, bike.point('rearContact').y - 20, {color: '#fff', vr: 900});
}
function setPhase(p) {
  S.phase = p; app.dataset.phase = p;
  if (p !== 'riding') { director.cancel(); hideCutin(); }
  if (p !== 'riding' && p !== 'gallery') { mplayer.cancel(); mdir.cancel(); resetSceneCamera(); }
  if (p === 'paused') camera.style.transform = '';
  renderSpeed();
}
function clearCountdown() { S.countdownShown = null; $('countdown').replaceChildren(); }
function showCountdown(text, cls = '', {quiet = false} = {}) {
  S.countdownShown = {text, cls};
  const b = document.createElement('b'); b.className = cls;
  const f = countdownFit(S.W, S.H, text);
  f.lines.forEach((l, i) => { if (i) b.append(document.createElement('br')); b.append(l); });
  b.setAttribute('aria-label', text);
  Object.assign(b.style, {left: f.x + 'px', top: f.y + 'px', fontSize: f.fontSize + 'px'});
  b.style.setProperty('--sx', f.sx); b.style.setProperty('--sy', f.sy);
  $('countdown').replaceChildren(b);
  if (isReduced() || quiet) return;
  // 冲击缩放：从 3 倍砸到 0.86 再回弹，12fps 步进；同时镜头震动、集中线脉冲、冲击环。
  // 竖屏 GO!! 紧贴速度巨字下方，砸入幅度减小，避免峰值时压到速度区。
  const from = cls === 'go' && !S.L.landscape ? 1.6 : 3.1;
  b.animate([{scale: from, opacity: .15}, {scale: .86, opacity: 1, offset: .38}, {scale: 1.08, offset: .62}, {scale: 1}], {duration: 330, easing: 'steps(4,end)'});
  S.shake = Math.max(S.shake, .8); S.focusKick = 1;
  fx.emit('ring', f.x, f.y, {color: WORLDS[S.world].y, vr: 700, life: .35});
}
// GO!! 冲击帧：墨/纸集中线反相一拍（走闪光限流，被拒时只保留集中线与震动）。
function goImpact() {
  const p = bike.point('headlight');
  if (director.requestFlash(now(), 'go')) {
    const el = $('impact'); el.style.setProperty('--ix', p.x + 'px'); el.style.setProperty('--iy', p.y + 'px');
    el.animate([{opacity: 1}, {opacity: 1, offset: .55}, {opacity: 0}], {duration: 150, easing: 'steps(2,end)'});
    $('flash').animate([{opacity: 0}, {opacity: .45, offset: .5}, {opacity: 0}], {duration: 160, delay: 90});
  }
  S.shake = 1.4; S.focusKick = 1.6;
  for (const k of [0, 1]) fx.emit('ring', p.x, p.y, {color: k ? WORLDS[S.world].m : '#fff', vr: 1100 + k * 500, life: .45});
}
function doPause() {
  if (S.phase !== 'riding') return;
  ride.pause(ride.rideT);
  setPhase('paused');
  $('tbc').hidden = false;
  if (!isReduced()) $('tbc').animate([{translate: '120% 0'}, {translate: '0 0'}], {duration: 360, easing: 'steps(6,end)'});
  sfx.play('stamp');
  $('btn-pause').textContent = S.mode === 'native' ? '继续骑行' : '继续';
}
async function doResume() {
  if (S.phase !== 'paused') return;
  const flipped = pageFlip(true);
  $('tbc').hidden = true;
  ride.resume(ride.rideT);
  setPhase('riding');
  $('btn-pause').textContent = '暂停';
  word('GO!', S.W * .36, S.H * .38, Math.min(S.W, S.H) * .16, {rot: -8});
  await flipped;
}
function doFinish() {
  if (S.phase !== 'riding' && S.phase !== 'paused') return;
  player?.stop();
  $('tbc').hidden = true;
  const record = ride.finish(ride.rideT, S.mode === 'native' ? S.nativeSummary || {} : {});
  setPhase('finishing');
  showCountdown('FIN.', 'ready');
  sfx.play('stamp');
  setTimeout(() => buildComic(record), isReduced() ? 100 : 900);
}

/* ---------- 今日骑行漫画 ---------- */
// 屏显：竖屏竖版页、横屏横版页（render/comic-view.js）；导出 / 分享永远用竖版页。
const comicPages = {portrait: document.createElement('canvas'), landscape: document.createElement('canvas')};
let comicView = null;
const comicOrientation = () => ((S.liveL || S.L)?.landscape ? 'landscape' : 'portrait');
async function buildComic(record) {
  clearCountdown();
  await document.fonts.ready;
  const moments = selectMoments(record);
  const view = $('comic-canvas');
  comicView = null;
  if (moments.length < 2) {
    view.width = PAGE.W; view.height = PAGE.H;
    $('comic-note').textContent = '本次记录的有效读数太少，未生成漫画。';
    setPhase('comic'); $('comic').hidden = false; return;
  }
  const t0 = now(), date = new Date();
  comicView = createComicView({view, reduced: isReduced, onStamp: () => sfx.play('stamp'),
    render: o => { const r = renderComicPage(comicPages[o], {record, moments, painter, bike, date, page: o === 'landscape' ? PAGE_LANDSCAPE : PAGE}); return {canvas: comicPages[o], panels: r.panels, summary: r.summary}; }});
  setPhase('comic'); $('comic').hidden = false;
  const pg = comicView.show(comicOrientation(), now());
  const cv = comicView;
  S.comic = {record, moments, panels: pg.panels, summary: pg.summary, renderMs: Math.round(now() - t0), get revealedAt() { return cv.revealedAt; }};
  $('comic-note').textContent = `${moments.length} 格 · ${pg.summary.source}。游戏分为游戏，非驾驶评价。`;
  sfx.play('shutter');
  // 揭示结束后，空闲时把另一种方向的页也渲染好：旋转时直接贴缓存。
  loop.add(t => {
    if (S.phase !== 'comic' || comicView !== cv) return false;
    if (cv.frame(t)) return true;
    setTimeout(() => { if (comicView === cv) cv.prerender(comicOrientation() === 'landscape' ? 'portrait' : 'landscape'); }, 60);
    return false;
  }, {fps: 30, name: 'comic-reveal'});
  restoreDemoSound();
}
function restoreDemoSound() { if (S.demoSoundRestore !== null) { sound.setMode(S.demoSoundRestore); S.demoSoundRestore = null; } }
function backToIdle() {
  $('comic').hidden = true;
  ride.reset(); player = null; replay = null; S.replayCountdown = null; setVehicle(null); S.mode = native.native ? 'native' : null;
  restoreDemoSound();
  setPhase('idle');
  clearCountdown();
  S.nativeRecapId = null; clearTimeout(S.finishWait);
  updateNativeControls();
}

/* ---------- 分镜 cut-in ---------- */
function startCutin(plan) {
  S.cut = {plan, layout: cutinLayout(plan.kind, S.W, S.H, speedRect())};
  S.cutStep = -1;
  cutCanvas.hidden = false; speedEl.classList.add('framed');
  sfx.play(plan.impact ? 'impact' : 'whoosh');
  S.shake = 1;
}
function hideCutin() { if (!S.cut) return; S.cut = null; cutCanvas.hidden = true; speedEl.classList.remove('framed'); }
function drawCutin(t) {
  const plan = director.active;
  if (!plan) { hideCutin(); return; }
  if (!S.cut || S.cut.plan !== plan) startCutin(plan);
  const elapsed = t - plan.at, step = Math.floor(elapsed / (1000 / 24));
  if (step === S.cutStep) return;
  S.cutStep = step;
  const g = cutCanvas.getContext('2d');
  g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  cutRenderer.draw(g, {plan, layout: S.cut.layout, elapsed, bike, bikeCanvas: bike.mode === 'glb' ? $('bike-gl') : $('bike-vec'), dpr: bike.mode === 'glb' ? $('bike-gl').width / S.W : $('bike-vec').width / S.W, world: WORLDS[S.world], speedRect: speedRect(), roadTop: S.L.roadTop});
}
function reactTo(ev) {
  const t = now(), reduced = isReduced();
  S.eventsLog.push({kind: ev.kind, t, rideT: ride.rideT, word: ev.word, speedShown: ev.speedShown});
  if (ev.kind === 'combo') { const c = $('combo'); c.textContent = `×${ev.combo} 连击`; if (!reduced) c.animate([{scale: 1.6}, {scale: 1}], {duration: 200, easing: 'steps(4,end)'}); return; }
  if (ev.kind === 'rhythm') return;
  // 速度里程碑交给“突破剧场”，不再走单一的分镜 cut-in（游戏分照常累计）。
  if (ev.kind === 'milestone') return;
  // 有车辆状态时，起步 / 加速 / 刹车 / 过弯的画面由车辆状态导演负责（core/vehicle-fx.js），这里只记游戏分。
  if (vsLive() && ['launch', 'boost', 'brake', 'corner'].includes(ev.kind)) return;
  const plan = director.event(ev, t);
  if (plan?.type === 'caption') showCaption(plan);
  if (reduced) return;
  const ex = () => bike.point('exhaust'), fr = () => bike.point('frontContact');
  if (ev.kind === 'launch') { S.wheelieUntil = t + 750; S.wheeliePitch = -.2; fx.emit('flame', ex().x, ex().y, {len: 70, follow: ex}); fx.emit('smoke', bike.point('rearContact').x, bike.point('rearContact').y, {count: 5, particles: tier().particles}); sfx.play('rev'); }
  if (ev.kind === 'boost') { S.wheelieUntil = t + 500; S.wheeliePitch = -.12; for (let i = 0; i < 3; i++) setTimeout(() => fx.emit('flame', ex().x, ex().y, {len: 80, follow: ex}), i * 220); sfx.play('rev'); }
  if (ev.kind === 'brake') { S.brakeUntil = t + 900; fx.emit('sparks', fr().x, fr().y, {len: 90, follow: fr}); fx.emit('skid', fr().x, fr().y, {vx: -200}); sfx.play('screech'); }
  if (ev.kind === 'corner') { S.cornerUntil = t + 1500; sfx.play('whoosh'); }
  if (ev.kind === 'milestone') { sfx.play('stamp'); fx.emit('ring', S.W * .5, S.H * .5, {color: WORLDS[S.world].y}); }
}
function showCaption(c) {
  const el = document.createElement('span'); el.textContent = c.text;
  $('caption').append(el); setTimeout(() => el.remove(), c.until - c.at);
}

/* ---------- 速度突破剧场 ---------- */
function milestoneReading(frame) {
  // 弹窗期间（原生结束确认、麦克风确认、系统弹窗等）不开新剧目。
  if (S.phase !== 'riding' || ride.modal) return;
  const plan = mdir.reading({...frame, world: S.world}, now());
  if (plan) startMilestone(plan);
}
// 车锚点给的是 camera 层坐标；剧场播放器按本帧镜头（平移 + 1.06 缩放）换成屏幕坐标（render/milestone-player.js）。
function milestoneEnv() { return {W: S.W, H: S.H, L: S.L, point: n => bike.point(n), cameraSpace: true, speedRect: speedRect(), particles: isReduced() ? 0 : tier().particles, dpr: S.dpr, seed: 7, bikeImage: bike.mode === 'glb' ? $('bike-gl') : $('bike-vec')}; }
function startMilestone(plan) {
  mplayer.play(plan, milestoneEnv(), plan.startedAt);
  // 分镜让位：剧场期间不出 cut-in，结束后再播排队的那个
  director.hold(plan.startedAt + plan.ms); hideCutin();
  if (!plan.preview && S.phase === 'riding' && ride.record) {
    const {t, threshold, reading, shown, tier: tr, main, acts, layers, title, compare, newHigh, comeback, simulated, world, ms} = plan;
    ride.record.milestones.push({t, threshold, reading, shown, tier: tr, main, acts, layers, title, compare, newHigh, comeback, simulated, world, ms});
  }
  sfx.play(plan.tier >= 4 ? 'go' : plan.comeback ? 'tap' : plan.main === 'stamp' ? 'stamp' : 'impact');
  S.eventsLog.push({kind: 'milestone-act', t: now(), rideT: ride.rideT, threshold: plan.threshold, main: plan.main, acts: plan.acts, tier: plan.tier, comeback: plan.comeback, newHigh: plan.newHigh, preview: !!plan.preview, world: plan.world});
  if (isReduced()) showCaption({text: `突破 ${plan.threshold} KM/H · ${plan.comeback ? '再次突破' : MILESTONE_ACTS[plan.main]?.name || ''}`, at: 0, until: 1600});
}
function resetSceneCamera() { sceneCanvas.style.transform = ''; sceneCanvas.style.filter = ''; S.mcam = IDLE_CAM; S.camKey = ''; }
function applySceneCamera(mc) {
  const key = `${mc.sceneScale.toFixed(3)}|${mc.desat.toFixed(2)}`;
  if (key === S.camKey) return;
  S.camKey = key;
  const c = bike.point('tank');
  sceneCanvas.style.transformOrigin = `${c.x}px ${c.y}px`;
  sceneCanvas.style.transform = mc.sceneScale !== 1 ? `scale(${mc.sceneScale.toFixed(3)})` : '';
  sceneCanvas.style.filter = mc.desat > .01 ? `saturate(${(1 - mc.desat).toFixed(2)}) contrast(1.08)` : '';
}

/* ---------- 突破画廊（预览 · 非骑行数据，不写任何历史） ---------- */
S.gallery = {i: 0, world: S.world, tier: 2, auto: false, playing: false, nextAt: 0};
function openGallery() {
  if (S.phase !== 'idle') return;
  closeSheets(); sfx.unlock();
  setPhase('gallery'); $('gallery').hidden = false;
  renderGallery(); galleryPlay(S.gallery.i);
}
function closeGallery() { $('gallery').hidden = true; mplayer.cancel(); S.galleryReading = 0; setPhase('idle'); }
function galleryPlay(i) {
  const g = S.gallery; g.i = (i + GALLERY_ITEMS.length) % GALLERY_ITEMS.length;
  if (g.world !== S.world) switchWorld(g.world, {flip: false});
  const plan = galleryPlan(g.i, {world: g.world, tier: g.tier});
  plan.startedAt = now(); plan.endsAt = plan.startedAt + plan.ms;
  S.galleryReading = plan.reading; g.playing = true;
  startMilestone(plan); renderGallery();
}
function galleryNext() {
  const g = S.gallery;
  // 自动轮播：剧目依次播，世界每次换一个
  if (g.auto) g.world = WORLD_ORDER[(WORLD_ORDER.indexOf(g.world) + 1) % WORLD_ORDER.length];
  galleryPlay(g.i + 1);
}
function renderGallery() {
  const g = S.gallery, item = GALLERY_ITEMS[g.i];
  const name = item === 'comeback' ? '回归 · 再次突破' : item === 'new-high' ? '今日新高' : item === 'grand' ? '100 KM/H 大事件' : MILESTONE_ACTS[item]?.name;
  setText('g-name', `预览 ${g.i + 1}/${GALLERY_ITEMS.length} · ${name} · ${WORLDS[g.world].name}`);
  $('g-auto').setAttribute('aria-pressed', String(g.auto));
  if (!$('g-worlds').childElementCount) {
    for (const k of WORLD_ORDER) { const b = document.createElement('button'); b.className = 'chip'; b.dataset.gworld = k; b.textContent = WORLDS[k].name; b.addEventListener('click', () => { S.gallery.world = k; galleryPlay(S.gallery.i); }); $('g-worlds').append(b); }
    for (const t of GALLERY_TIERS.slice(0, 3)) { const b = document.createElement('button'); b.className = 'chip'; b.dataset.gtier = t.key; b.textContent = `等级 ${t.label}`; b.addEventListener('click', () => { S.gallery.tier = t.key; galleryPlay(S.gallery.i); }); $('g-tiers').append(b); }
  }
  document.querySelectorAll('[data-gworld]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.gworld === g.world)));
  document.querySelectorAll('[data-gtier]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.gtier) === g.tier)));
}

/* ---------- 车辆状态交互（core/vehicle-fx.js 决定参数，这里只上屏）---------- */
function setVehicle(raw) {
  const v = raw ? normalizeVehicle(raw) : null;
  S.vs = v; S.vsAt = v ? now() : 0;
  if (!v) { vdirector.reset(); }
}
const vsLive = () => !!S.vs && S.phase === 'riding' && now() - S.vsAt < 1500;
function vehicleFrame(t, dt) {
  const reduced = isReduced(), live = vsLive();
  const theatre = mplayer.active || !!director.active;
  const target = live ? vehicleVisuals(S.vs, {level: prefs.fx, reduced, theatre, aspect: S.W / S.H}) : VIS_REST;
  // 平滑：倾斜 / 弯曲 0.3 s，其余 0.18 s；刹车与换挡要“快进快出”。
  const prev = S.vis || VIS_REST, out = {...target};
  for (const [key, tau] of [['tiltDeg', .3], ['zoom', .3], ['bikeRollDeg', .3], ['bend', .35], ['innerFocus', .25], ['accel', .2], ['fov', .35], ['warp', .2], ['parallax', .4], ['speedSkewDeg', .2], ['speedStretch', .2], ['flameLen', .15], ['edgeLines', .25], ['dive', .08], ['lunge', .1], ['brakeGlow', .08], ['reverseLines', .15], ['dim', .6], ['wheelie', .25], ['idleJitter', .3], ['calm', .6], ['bikeYaw', .3]]) {
    out[key] = prev[key] + (target[key] - prev[key]) * (1 - Math.exp(-dt / tau));
  }
  S.vis = out;
  // 一次性效果：拟声字、冲击帧、小分镜、粒子。
  if (live) for (const e of vdirector.step(S.vs, t, {reduced, theatre: mplayer.active, level: prefs.fx})) applyVehicleEffect(e, t, reduced);
  else if (!S.vs) vdirector.reset();
  // 持续粒子：排气火焰随加速强度、怠速排气小烟与低频波纹、轰油门火焰与声浪圈。
  if (S.phase === 'riding' && !reduced && prefs.fx !== 'off') {
    const ex = () => bike.point('exhaust'), p = ex(), world = WORLDS[S.world];
    if (out.flameLen > .22 && t > S.nextFlame) { fx.emit('flame', p.x, p.y, {len: 36 + 170 * out.flameLen * FX_LEVELS[prefs.fx], life: .2, follow: ex}); S.nextFlame = t + 150 - 70 * out.flameLen; }
    if (target.puff > 0 && t > S.nextPuff) { fx.emit('smoke', p.x, p.y, {count: 1, vx: -50, scale: .45 + .3 * target.puff, particles: tier().particles}); S.nextPuff = t + 1100 - 500 * target.puff; }
    if (target.ripple > 0 && t > S.nextRipple) { fx.emit('ring', p.x, p.y, {color: world.c, vr: 140 + 220 * target.ripple, life: .9}); S.nextRipple = t + 1000 - 450 * target.ripple; }
    if (target.revFlame > 0 && t > S.nextRev) { fx.emit('flame', p.x, p.y, {len: 90, life: .25, follow: ex}); S.nextRev = t + 260; }
  }
  // 漫画车压弯：在车轮接地点处旋转车图层（场景层另有整体倾斜）。
  const roll = S.phase === 'riding' && !reduced ? out.bikeRollDeg : 0;
  if (Math.abs(roll - S.roll) > .05 || (roll === 0 && S.roll !== 0)) {
    S.roll = Math.abs(roll) < .05 ? 0 : roll;
    const rc = bike.point('rearContact'), fc = bike.point('frontContact'), ox = ((rc.x + fc.x) / 2).toFixed(0), oy = rc.y.toFixed(0);
    for (const c of [$('bike-gl'), $('bike-vec')]) { c.style.transformOrigin = `${ox}px ${oy}px`; c.style.transform = S.roll ? `rotate(${S.roll.toFixed(2)}deg)` : ''; }
  }
  // 速度巨字：加速时被拉伸 / 更倾斜（最多 1.22 倍、−20°，始终可读）。
  let skew = S.phase === 'riding' ? out.speedSkewDeg : -8, stretch = S.phase === 'riding' ? out.speedStretch : 1;
  if (S.H > S.W) skew = Math.max(skew, -14);   // 竖屏速度巨字接近满宽：倾斜过大左下角会出画
  if (stretch > 1) {
    // 拉伸以右上角为原点向左长：不许长出画面（竖屏里速度巨字本来就接近满宽）。
    const r = speedEl.getBoundingClientRect(), p = panel.getBoundingClientRect(), cur = Number(app.style.getPropertyValue('--speed-stretch')) || 1;
    const base = r.width / cur, room = (r.right - p.left - 10) / Math.max(1, base);
    stretch = Math.max(1, Math.min(stretch, room));
  }
  const key = `${skew.toFixed(1)}|${stretch.toFixed(3)}`;
  if (key !== S.speedKey) { S.speedKey = key; app.style.setProperty('--speed-skew', skew.toFixed(1) + 'deg'); app.style.setProperty('--speed-stretch', stretch.toFixed(3)); }
  // 熄火时场景变暗；减少动态 / 特效关时用文字图标示意。
  const dim = S.phase === 'riding' ? out.dim : 0;
  if (Math.abs(dim - (S.dimShown ?? 0)) > .01) { S.dimShown = dim; $('vs-dim').style.opacity = (dim * .8).toFixed(2); }
  const hint = live && (reduced || prefs.fx === 'off') ? reducedHint(target) : '';
  if (hint !== S.hintShown) { S.hintShown = hint; const el = $('vs-hint'); el.textContent = hint; el.hidden = !hint; el.style.borderColor = target.tint || ''; }
  app.dataset.vehicle = live ? `${S.vs.motion}|${S.vs.turn}|${S.vs.engine}` : '';
}
function applyVehicleEffect(e, t, reduced) {
  const fr = () => bike.point('frontContact'), rc = () => bike.point('rearContact'), ex = () => bike.point('exhaust');
  S.vsWords.push({...e, t}); if (S.vsWords.length > 120) S.vsWords.shift();
  S.eventsLog.push({kind: 'vehicle-' + (e.kind || e.type), t, rideT: ride.rideT, text: e.text || null});
  if (e.type === 'word') {
    if (reduced) { showCaption({text: e.text, at: 0, until: 1200}); return; }
    const size = Math.min(S.W, S.H) * .12 * (e.size || 1) * Math.min(1.2, FX_LEVELS[prefs.fx] || 1);
    const bp = bike.point('tank');
    const at = placeWord({W: S.W, H: S.H, speed: speedRect(), side: e.side, size, bike: bp});
    if (at) { word(e.text, at.x, at.y, size, {rot: at.rot, ms: e.kind === 'hard' ? 820 : 640}); e.box = at.box; }
    if (e.kind === 'cornerIn') sfx.play('whoosh');
    if (e.kind === 'hard' || e.kind === 'brake') sfx.play('screech');
    if (e.kind === 'launch' || e.kind === 'boost' || e.kind === 'rev') sfx.play('rev');
    return;
  }
  if (e.type === 'impact') {
    // 急刹冲击帧（已过闪光限流）：集中线反相一拍 + 镜头前冲急停 + 震动。
    const p = fr(), el = $('impact'); el.style.setProperty('--ix', p.x + 'px'); el.style.setProperty('--iy', p.y + 'px');
    el.animate([{opacity: 1}, {opacity: 1, offset: .5}, {opacity: 0}], {duration: 130, easing: 'steps(2,end)'});
    S.lungeKick = 1; S.shake = Math.max(S.shake, 1.5); S.focusKick = 1.4;
    return;
  }
  if (reduced) return;
  if (e.type === 'cutin') director.event({kind: e.kind, word: e.side === 'left' ? '左弯' : e.side === 'right' ? '右弯' : ''}, t);
  else if (e.type === 'sparks') fx.emit('sparks', fr().x, fr().y, {len: 95, follow: fr});
  else if (e.type === 'smoke') { fx.emit('smoke', fr().x, fr().y, {count: e.count || 3, vx: 160, particles: tier().particles}); fx.emit('skid', fr().x, fr().y, {vx: -220}); }
  else if (e.type === 'flame') fx.emit('flame', ex().x, ex().y, {len: 60 + 70 * (e.len || 1), follow: ex});
  else if (e.type === 'ring') fx.emit('ring', ex().x, ex().y, {color: WORLDS[S.world].y, vr: 700, life: .4});
  else if (e.type === 'jolt' && e.strength > 0) { S.joltUntil = t + 110; S.shake = Math.max(S.shake, .5 * e.strength); }
}
// fx 画布上的车辆状态叠层：刹车灯光晕、画面边缘速度线（曲速在世界层，见 drawWarp）。
function drawVehicleOverlay(g, t, world, m) {
  const vis = S.vis, reduced = isReduced();
  if (vis.brakeGlow > .03) {
    const r = bike.point('rearAxle'), k = bike.point('tank'), x = r.x + (k.x - r.x) * .08, y = k.y + (r.y - k.y) * .12, R = m.ppu * (.28 + .5 * vis.brakeGlow);
    const grad = g.createRadialGradient(x, y, 0, x, y, R);
    grad.addColorStop(0, `rgba(255,60,60,${(.85 * vis.brakeGlow).toFixed(2)})`); grad.addColorStop(.35, `rgba(255,40,40,${(.45 * vis.brakeGlow).toFixed(2)})`); grad.addColorStop(1, 'rgba(255,0,0,0)');
    g.save(); g.fillStyle = grad; g.fillRect(x - R, y - R, R * 2, R * 2); g.fillStyle = '#ff2a3d'; g.strokeStyle = world.ink; g.lineWidth = 2;
    g.beginPath(); g.ellipse(x, y, m.ppu * .05, m.ppu * .03, 0, 0, Math.PI * 2); g.fill(); g.stroke(); g.restore();
  }
  if (reduced) return;
  const frame = Math.floor(t / 42);
  let seed = frame * 9301 + 49297; const rnd = () => ((seed = (seed * 233280 + 49297) % 233280) / 233280);
  if (vis.accel > .05) {
    // 加速“隧道视野”：四周压暗，强度随加速强度（全油门一眼可见）。
    const R = Math.hypot(S.W, S.H) * .62, grad = g.createRadialGradient(S.W * .45, S.H * .55, R * (.55 - .2 * vis.accel), S.W * .45, S.H * .55, R);
    grad.addColorStop(0, 'rgba(5,4,10,0)'); grad.addColorStop(1, `rgba(5,4,10,${(.55 * vis.accel).toFixed(2)})`);
    g.save(); g.fillStyle = grad; g.fillRect(0, 0, S.W, S.H); g.restore();
  }
  if (vis.edgeLines > .05) {
    // 画面上下边缘的速度线：密度随加速强度。
    const n = Math.round(6 + 34 * vis.edgeLines), band = S.H * .14;
    g.save(); g.fillStyle = '#ffffff'; g.globalAlpha = .6 * Math.min(1, vis.edgeLines * 1.4);
    for (let i = 0; i < n; i++) {
      const top = rnd() < .5, y = top ? rnd() * band : S.H - rnd() * band, len = S.W * (.08 + .3 * vis.edgeLines * rnd()), x = rnd() * S.W, h = 1.5 + rnd() * 3;
      g.fillRect(x, y, len, h);
    }
    g.restore();
  }
}

// 世界层上的曲速（在车之下）：缩放模糊——把世界按前方消失点放大叠两层半透明，背景被“拉成线”；再画发散的曲速线。
function drawWarp(g, t, world, warp) {
  const vx = S.W * 1.02, vy = S.L.horizon ?? S.H * .45;
  let seed = Math.floor(t / 42) * 9301 + 49297; const rnd = () => ((seed = (seed * 233280 + 49297) % 233280) / 233280);
  if (tier().particles >= .6) {
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    for (const [z, a] of [[1 + .05 * warp, .3], [1 + .11 * warp, .16]]) {
      const dx = vx * S.dpr * (1 - z), dy = vy * S.dpr * (1 - z);
      g.globalAlpha = a * warp; g.drawImage(sceneCanvas, dx, dy, sceneCanvas.width * z, sceneCanvas.height * z);
    }
    g.restore();
  }
  const n = Math.round(14 + 70 * warp), R = Math.hypot(S.W, S.H);
  g.save(); g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (rnd() - .5) * 1.7, r0 = R * (.14 + rnd() * .3), r1 = r0 + R * (.14 + .6 * warp) * (.5 + rnd());
    g.strokeStyle = i % 4 === 0 ? world.y : '#ffffff'; g.globalAlpha = (.25 + .55 * warp) * (.6 + .4 * rnd());
    g.lineWidth = 1.2 + rnd() * 3.6 * warp;
    g.beginPath(); g.moveTo(vx + Math.cos(a) * r0, vy + Math.sin(a) * r0); g.lineTo(vx + Math.cos(a) * r1, vy + Math.sin(a) * r1); g.stroke();
  }
  g.restore();
}

/* ---------- 回放（浏览器预览）：合成回放或用户选择的本机文件 ---------- */
let replay = null;
function startReplay(data, opts = {}) {
  if (S.phase !== 'idle') return false;
  sfx.unlock(); closeSheets();
  const {label = '合成回放 · 非真实数据', startAt = 0, speedup = 1, endAt = null} = opts;
  S.lastReplay = {data, opts};
  S.mode = 'replay'; S.replayLabel = label;
  replay = {player: createReplayPlayer(data, {simulated: true, speedup, startAt}), startAt, endAt, lastGps: null, t: startAt};
  S.replayCountdown = {t0: now()}; setPhase('countdown'); S.burn = {t0: now(), auto: true};
  $('replay-note') && ($('replay-note').textContent = label);
  return true;
}
const MOTION_WORD = {stopped: 'stop', launching: 'launch', accelerating: 'accelerate', cruising: 'cruise', coasting: 'cruise', braking: 'brake', hardBraking: 'brake'};
function replayFrame(t, dt) {
  if (!replay) return;
  if (S.phase === 'countdown' && S.replayCountdown) {
    if ((t - S.replayCountdown.t0) / 1000 >= 4) { S.replayCountdown = null; goRide({t: 0, source: 'demo'}); }
    return;
  }
  if (S.phase !== 'riding') return;
  const out = replay.player.step(dt);
  replay.t = out.t;
  setVehicle(out.snapshot);
  const rideT = Math.max(0, out.t - replay.startAt);
  if (out.gps && out.gps !== replay.lastGps) {
    replay.lastGps = out.gps;
    const v = Number.isFinite(out.gps.v) ? out.gps.v * 3.6 : null;
    const frame = {t: rideT, speedKmh: v, source: v === null ? 'unavailable' : 'demo', simulated: true, motion: S.vs?.turn !== 'none' && S.vs ? 'turn' : MOTION_WORD[S.vs?.motion] || 'cruise'};
    ride.ingest(frame); milestoneReading(frame);
    if (sound.mode === 'demo' && v !== null) sound.setDemoLevel(clamp(.12 + v / 120, 0, 1));
  } else if (replay.lastGps && out.t - replay.lastGps.t > 2.5 && ride.reading?.source !== 'unavailable') {
    // 回放文件里的 GPS 缺口照实显示为 “—”。
    const frame = {t: rideT, speedKmh: null, source: 'unavailable', simulated: true}; ride.ingest(frame);
  }
  if (replay.player.done || (replay.endAt && out.t >= replay.endAt)) doFinish();
}

/* ---------- 每帧 ---------- */
function paintWorld(dt) {
  const g = sceneCanvas.getContext('2d');
  g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  const t = tier(), reduced = isReduced();
  st.dt = dt; st.t += dt; st.speed = S.speedVis; st.accel = S.phase === 'riding' ? ride.accel : null;
  st.misprint = t.misprint; st.particles = reduced ? 0 : t.particles;
  st.eq = S.sound.valid ? S.sound.bands : null;
  st.focus = S.focus; st.focusX = bike.point('tank').x; st.focusY = bike.point('tank').y + 20; st.focusJitter = Math.floor(st.t * 12);
  const vis = S.phase === 'riding' && S.vis ? S.vis : VIS_REST;
  st.bend = reduced ? 0 : vis.bend; st.innerSide = reduced ? null : vis.innerSide; st.innerFocus = reduced ? 0 : vis.innerFocus;
  st.boost = vis.accel; st.reverse = vis.reverseLines; st.calm = vis.calm;
  painter.paint(g, S.W, S.H, S.L, S.world, st);
  if (!reduced && vis.warp > .04) drawWarp(g, st.t * 1000, WORLDS[S.world], vis.warp);
  drawContactShadow(g, bike.point('rearContact'), bike.point('frontContact'), S.L.bike.ground, bikeMapping(S.L).ppu, WORLDS[S.world].ink);
}
function updatePose(t, dt) {
  const reduced = isReduced(), riding = S.phase === 'riding';
  const accel = riding ? (ride.accel ?? 0) : 0;
  let pitch = riding ? clamp(-accel * .022, -.07, .045) : 0;
  if (t < S.wheelieUntil) pitch = S.wheeliePitch;
  if (t < S.brakeUntil) pitch = .06;
  let yaw = 0;
  if (S.drag) yaw = S.drag.yaw;
  else if (S.drift && t < S.drift.until) yaw = S.drift.dir * .78;
  else if (t < S.cornerUntil) yaw = .3;
  let squash = 1 + clamp(accel * .012, -.03, .05);
  if (S.burn) squash = .965;
  // 车辆状态：刹车点头（前叉压缩）、强加速抬头、过弯偏航；换挡顿挫一拍。
  const vis = S.vis;
  if (vis && riding) {
    pitch += vis.dive * .085 - vis.wheelie * .2 + (t < S.joltUntil ? .035 : 0);
    yaw += vis.bikeYaw;
    squash *= 1 - vis.dive * .03 + vis.accel * .02;
  }
  if (reduced) { pitch = 0; yaw = S.drag ? S.drag.yaw : 0; squash = 1; }
  spring(springs.pitch, pitch, dt); spring(springs.yaw, yaw, dt, 90, 14); spring(springs.squash, squash, dt, 200, 16);
  // 冲刺：先冲出画面右侧，再从左侧追回原位。
  let dz = 0;
  if (S.dash && !reduced) {
    // 冲刺：向前猛冲但车头不出画面（竖屏余量小），再弹簧回位。
    const e = (t - S.dash.t0) / 1000, out = Math.min(S.dash.go ? .9 : 1.6 * (.5 + S.dash.power), maxDash(S.L, S.W));
    if (e < .22) dz = out * (e / .22) ** 2;
    else if (e < 1) { const k = (e - .22) / .78; dz = out * (1 - k) ** 3 * Math.cos(k * 5); }
    else S.dash = null;
  }
  const p = bike.pose;
  p.pitch = springs.pitch.x; p.yaw = springs.yaw.x; p.squash = springs.squash.x; p.dz = dz;
  const snd = S.sound.valid ? S.sound.level : 0;
  p.shake = reduced ? 0 : (S.burn ? .9 : t < S.revUntil ? .7 : 0) + snd * .5 + (riding ? S.speedVis / 260 : 0) + (vis ? vis.idleJitter * .55 + vis.accel * .25 : 0);
  p.impact = 0;
  // 突破剧场：车按剧目动作（前冲/后退、抬头、压低、甩尾、震动），仍按 12fps 步进渲染
  const mb = S.mcam?.bike;
  if (mb && !reduced) { p.dz += mb.dz; p.dy = mb.dy; p.pitch += mb.pitch; p.yaw += mb.yaw; p.squash *= mb.squash; p.shake += mb.shake; } else p.dy = 0;
  // 骑行中（剧目、GO 冲刺）车出画不超过 ≈12% 车长；镜头平移已在剧场里夹过，这里按总位移再夹一次。
  if (S.phase === 'riding' || S.phase === 'gallery') {
    const ppu = mapBike(S.L).ppu, pan = (S.mcam?.panX || 0) * S.W;
    p.dz = (clampBikeShift(S.L, p.dz * ppu + pan) - pan) / ppu;
  }
}
function logic(t, dt) {
  const reduced = isReduced();
  if (player && (S.phase === 'countdown' || S.phase === 'riding' || S.phase === 'paused')) player.advance(dt);
  if (S.phase === 'countdown' && (player || S.nativeCountdown || S.replayCountdown)) {
    // 原生出发：倒计时在记录开始之前播放，走完（或“跳过”）才把动作交给原生；记录时钟不受动画影响。
    const c = S.nativeCountdown, w = c ? (t - c.t0) / 1000 : S.replayCountdown ? (t - S.replayCountdown.t0) / 1000 : player.wallSeconds, label = w < 1 ? 'READY' : w < 2 ? '3' : w < 3 ? '2' : '1';
    if (label !== S.countdownLabel && !(c && c.sent)) { S.countdownLabel = label; showCountdown(label, label === 'READY' ? 'ready' : ''); sfx.play('beep'); }
    if (c && !c.sent && w >= 4) commitNativeCountdown();
    if (c && c.sent && t - c.sentAt > 4000) cancelNativeCountdown('timeout');
  } else S.countdownLabel = '';
  if (S.goUntil && t > S.goUntil) { S.goUntil = 0; if (S.phase === 'riding') clearCountdown(); }
  if (S.phase === 'riding') {
    const evs = ride.tick(ride.rideT);
    void evs;
    director.update(t);
    if (!reduced) drawCutin(t); else hideCutin();
  }
  if (S.mode === 'replay') replayFrame(t, dt);
  vehicleFrame(t, dt);
  // 突破剧场
  if (S.phase === 'riding' || S.phase === 'gallery') {
    const next = S.phase === 'riding' ? mdir.update(t) : null;
    if (next) startMilestone(next);
    S.mcam = reduced ? IDLE_CAM : mplayer.frame(t);
    if (S.phase === 'gallery' && S.gallery.playing && !mplayer.active) { S.gallery.playing = false; S.gallery.nextAt = t + 450; }
    if (S.phase === 'gallery' && S.gallery.auto && !S.gallery.playing && t > S.gallery.nextAt) galleryNext();
  } else S.mcam = IDLE_CAM;
  applySceneCamera(S.mcam);
  S.timeScale = S.mcam.timeScale;
  // 视觉速度：只决定滚动快慢，不显示。
  const target = (S.phase === 'riding' && currentSpeed().known ? ride.reading.speedKmh : 0) + (S.phase === 'gallery' ? S.galleryReading || 0 : 0);
  S.idleBoost *= Math.exp(-dt * 1.6);
  S.speedVis += (target + S.idleBoost - S.speedVis) * (1 - Math.exp(-dt * 2.4));
  if (S.phase !== 'paused' && !reduced) st.x += S.speedVis * 15 * S.L.scrollScale * dt * S.timeScale * (S.vis?.parallax ?? 1);
  // 声浪
  // 原生：麦克风声浪来自原生快照；没有时只有显式（或演示骑行自动）的声浪 DEMO。
  S.sound = S.mode === 'native' ? (S.nativeSound?.valid ? S.nativeSound : sound.mode === 'demo' ? sound.sample(dt, S.phase === 'paused') : {valid: false}) : sound.sample(dt, S.phase === 'paused');
  // 集中线：倒计时与烧胎蓄力
  const charge = S.burn ? clamp((t - S.burn.t0) / 1400, 0, 1) : 0;
  const focusT = reduced ? 0 : S.phase === 'countdown' ? .9 : S.burn ? .2 + charge * .7 : 0;
  S.focusKick = (S.focusKick || 0) * Math.exp(-dt * 5);
  S.focus += (Math.max(focusT, S.focusKick) - S.focus) * (1 - Math.exp(-dt * 14));
  // 烟：烧胎与倒计时
  if (S.burn && !reduced && t - S.lastSmoke > 85) { S.lastSmoke = t; const rc = bike.point('rearContact'); fx.emit('smoke', rc.x, rc.y - 6, {count: 2, vx: -190, particles: tier().particles, scale: .9 + charge * .6}); if (S.burn.auto ? false : Math.random() < .08) sfx.play('burnout'); }
  if (S.phase !== 'paused') updatePose(t, dt);
  // 画面倾斜 + 震动（只作用于场景与车，不作用于速度与页角）
  if (S.phase !== 'paused') {
    const accel = S.phase === 'riding' ? (ride.accel ?? 0) : 0;
    const vis = S.vis || VIS_REST;
    const tiltT = reduced ? 0 : (vsLive() ? 0 : clamp(-accel * 1.1, -4, 4) + (t < S.cornerUntil ? -2.4 : 0)) + vis.tiltDeg;
    S.tilt += (tiltT - S.tilt) * (1 - Math.exp(-dt * 4));
    S.shake *= Math.exp(-dt * 9);
    // 急刹：镜头前冲后弹簧急停；其余时刻按强度连续轻震。都只作用于场景层（速度巨字不在 #camera 里）。
    S.lungeKick *= Math.exp(-dt * 6);
    const lunge = reduced ? 0 : -(S.lungeKick * Math.cos(Math.min(1, 1 - S.lungeKick) * 5) + vis.lunge * .25) * S.W * .028;
    const j = reduced ? 0 : S.shake * 7 + vis.shakePx;
    const pan = (S.mcam?.panX || 0) * S.W;
    camera.style.transform = `translate(${((Math.random() - .5) * j + pan + lunge).toFixed(1)}px,${((Math.random() - .5) * j).toFixed(1)}px) rotate(${S.tilt.toFixed(2)}deg) scale(${(reduced ? 1.06 : vis.zoom).toFixed(3)})`;
  }
  renderSpeed(); renderHud();
}
function bikeTask(t, dt) {
  if (S.phase === 'paused' || S.phase === 'comic') return;
  const w = S.burn ? 9 : Math.min(6.5, S.speedVis / 3.6 / .32);
  if (!isReduced()) bike.spin(w * dt * (S.timeScale ?? 1));
  const t0 = performance.now(); bike.render();
  S.bikeMs = (S.bikeMs ?? 0) * .9 + (performance.now() - t0) * .1; // CPU 提交耗时（不含 GPU 异步）
}
function fxTask(t, dt) {
  if (S.phase === 'paused' || S.phase === 'comic') return;
  const g = fxCanvas.getContext('2d');
  g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); g.clearRect(0, 0, S.W, S.H);
  fx.update(dt * (S.timeScale ?? 1));
  const world = WORLDS[S.world], m = bikeMapping(S.L);
  const arcs = S.burn ? .8 : clamp((S.speedVis - 8) / 60, 0, 1);
  if (!isReduced() && arcs > 0) {
    const r = bike.point('rearAxle'); drawWheelArcs(g, r.x, r.y, m.ppu * .34, arcs, world.line);
    if (!S.burn) { const f = bike.point('frontAxle'); drawWheelArcs(g, f.x, f.y, m.ppu * .31, arcs, world.line); }
  }
  if (S.burn && !isReduced()) {
    // 蓄力环
    const charge = clamp((t - S.burn.t0) / 1400, 0, 1), r = bike.point('rearAxle');
    g.save(); g.lineWidth = 7; g.strokeStyle = world.ink; g.beginPath(); g.arc(r.x, r.y, m.ppu * .5, -Math.PI / 2, -Math.PI / 2 + charge * Math.PI * 2); g.stroke();
    g.lineWidth = 4; g.strokeStyle = charge >= 1 ? world.m : world.y; g.stroke(); g.restore();
  }
  if (S.phase === 'riding' && S.vis) drawVehicleOverlay(g, t, world, m);
  fx.draw(g, world);
}

/* ---------- 车的手势（仅待机） ---------- */
const hit = $('bike-hit');
let press = null;
hit.addEventListener('pointerdown', e => {
  if (S.phase !== 'idle') return;
  sfx.unlock();
  hit.setPointerCapture(e.pointerId);
  press = {x: e.clientX, y: e.clientY, t: now(), moved: false, mode: null, lastX: e.clientX, lastT: now(), vx: 0};
  press.timer = setTimeout(() => { if (press && !press.mode) { press.mode = 'burn'; S.burn = {t0: now()}; sfx.play('burnout'); const rc = bike.point('rearContact'); word('SKRRR', rc.x, rc.y - S.L.bike.lengthPx * .35, S.L.bike.lengthPx * .12, {rot: -6}); } }, 380);
});
hit.addEventListener('pointermove', e => {
  if (!press) return;
  const dx = e.clientX - press.x, dy = e.clientY - press.y, tt = now();
  press.vx = (e.clientX - press.lastX) / Math.max(1, tt - press.lastT); press.lastX = e.clientX; press.lastT = tt;
  if (!press.mode && Math.hypot(dx, dy) > 14) {
    clearTimeout(press.timer);
    if (dy < -30 && Math.abs(dy) > Math.abs(dx)) { press.mode = 'wheelie'; wheelie(); }
    else if (Math.abs(dx) > Math.abs(dy)) press.mode = 'drag';
    else press.mode = 'none';
  }
  if (press.mode === 'drag') { S.drag = {yaw: clamp(dx / (S.W * .35), -1, 1) * .9}; }
});
const release = () => {
  if (!press) return;
  clearTimeout(press.timer);
  const p = press; press = null;
  if (p.mode === 'burn') dashRelease();
  else if (p.mode === 'drag') {
    S.drag = null;
    if (Math.abs(p.vx) > .8) drift(Math.sign(p.vx));
  } else if (!p.mode) rev();
};
hit.addEventListener('pointerup', release); hit.addEventListener('pointercancel', release);
hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rev(); } if (e.key === 'ArrowUp') wheelie(); if (e.key === 'ArrowLeft') drift(-1); if (e.key === 'ArrowRight') drift(1); });

function rev() {
  if (S.phase !== 'idle') return;
  S.revUntil = now() + 380; S.idleBoost += 6;
  sfx.play('rev');
  if (isReduced()) return;
  const ex = () => bike.point('exhaust');
  fx.emit('flame', ex().x, ex().y, {len: 64, follow: ex}); fx.emit('smoke', ex().x, ex().y, {count: 3, particles: tier().particles});
  word('轰！', ex().x - S.L.bike.lengthPx * .06, ex().y - S.L.bike.lengthPx * .32, S.L.bike.lengthPx * .16, {rot: -12});
}
function wheelie() {
  if (S.phase !== 'idle') return;
  S.wheelieUntil = now() + 950; S.wheeliePitch = -.32; sfx.play('rev');
  const h = bike.point('headlight');
  word('WHEELIE!', h.x, h.y - S.L.bike.lengthPx * .38, S.L.bike.lengthPx * .1, {rot: -14});
}
function dashRelease() {
  const power = S.burn ? clamp((now() - S.burn.t0) / 1400, 0, 1) : 0;
  S.burn = null;
  S.dash = {t0: now(), power};
  S.idleBoost += 30 + power * 60;
  sfx.play('whoosh');
  word('ZOOM!', S.W * .5, S.H * .36, Math.min(S.W, S.H) * .16, {rot: -8});
  if (power >= 1) flash('dash', .35);
}
function drift(dir) {
  if (S.phase !== 'idle') return;
  S.drift = {dir, until: now() + 700}; sfx.play('screech');
  if (isReduced()) return;
  const rc = bike.point('rearContact');
  fx.emit('skid', rc.x, rc.y, {vx: -dir * 160}); fx.emit('smoke', rc.x, rc.y, {count: 4, vx: dir * 120, particles: tier().particles});
  word('SKRRT!', rc.x, rc.y - S.L.bike.lengthPx * .3, S.L.bike.lengthPx * .12, {rot: dir * 8});
}

/* ---------- 面板 ---------- */
function closeSheets() { document.querySelectorAll('.sheet').forEach(s => { s.hidden = true; }); }
function openSheet(id) { const s = $(id), open = s.hidden; closeSheets(); s.hidden = !open; sfx.play('tap'); }
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
$('btn-demo').addEventListener('click', () => (S.mode === 'native' ? startNativeCountdown('primary') : startDemo()));
$('btn-native-demo').addEventListener('click', () => startNativeCountdown('demoStart'));
$('btn-vehicle').addEventListener('click', () => { closeSheets(); native.send('garage'); });
$('btn-world').addEventListener('click', () => { buildWorldCards(); openSheet('sheet-world'); });
$('btn-garage').addEventListener('click', () => openSheet('sheet-garage'));
$('btn-sound').addEventListener('click', () => openSheet('sheet-sound'));
$('btn-settings').addEventListener('click', () => openSheet('sheet-settings'));
$('btn-gallery').addEventListener('click', openGallery);
$('g-prev').addEventListener('click', () => galleryPlay(S.gallery.i - 1));
$('g-next').addEventListener('click', () => galleryPlay(S.gallery.i + 1));
$('g-replay').addEventListener('click', () => galleryPlay(S.gallery.i));
$('g-auto').addEventListener('click', () => { S.gallery.auto = !S.gallery.auto; renderGallery(); if (S.gallery.auto && !S.gallery.playing) galleryNext(); });
$('g-exit').addEventListener('click', closeGallery);
$('g-more').addEventListener('click', () => { const g = $('gallery'), open = g.dataset.open !== 'true'; g.dataset.open = String(open); $('g-more').textContent = open ? '收起' : '更多'; });
// GLB 超过 8s 仍未就绪：收起 LOADING，改显示矢量漫画车（bike.js 同时显示矢量画布）
setTimeout(() => { if (app.dataset.bike === 'loading') app.dataset.bike = 'slow'; }, 8000);
$('btn-skip').addEventListener('click', () => (S.nativeCountdown ? commitNativeCountdown() : player?.skipCountdown()));
$('btn-pause').addEventListener('click', () => {
  if (S.mode === 'native') return native.send('primary');
  if (S.mode === 'replay') return S.phase === 'riding' ? doPause() : doResume();
  if (S.phase === 'riding') player?.hold(); else if (S.phase === 'paused') player?.release();
});
$('btn-finish').addEventListener('click', () => (S.mode === 'native' ? native.send('finish') : doFinish()));
$('btn-world-ride').addEventListener('click', () => { switchWorld(nextWorld(S.world)); sendAppearance(); });
$('btn-save').addEventListener('click', async () => {
  sfx.play('shutter');
  if (S.mode === 'native') {
    // 原生：把 PNG 交给系统分享面板（可存到相册、文件或发送），网页不申请相册权限。
    try { const out = await exportComic(comicView.page('portrait').canvas, {toBlob: false}); $('comic-note').textContent = native.send('share', {png: out.dataURL}) ? '已打开系统分享面板' : '分享暂不可用'; } catch { $('comic-note').textContent = '图片生成失败，请重试'; }
    return;
  }
  const out = await downloadComic(comicView.page('portrait').canvas); $('comic-note').textContent = `已保存 ${out.filename}`;
});
$('btn-again').addEventListener('click', () => { const again = S.lastReplay; backToIdle(); if (again) startReplay(again.data, again.opts); else startDemo(); });
$('btn-detail').addEventListener('click', () => { native.send('rideDetail'); backToIdle(); });
$('btn-close').addEventListener('click', () => { if (S.mode === 'native') native.send('wrappedDone'); backToIdle(); });

function buildWorldCards() {
  const grid = $('world-grid');
  if (grid.childElementCount) { applyWorldLabels(); return; }
  for (const key of WORLD_ORDER) {
    const w = WORLDS[key], b = document.createElement('button');
    b.className = 'world-card'; b.dataset.world = key;
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const L = stageLayout(320, 180);
    painter.paint(c.getContext('2d'), 320, 180, L, key, {x: 400, t: 0, speed: 40, accel: 0, eq: null, misprint: true, particles: 0});
    const label = document.createElement('span'); label.innerHTML = `${w.chapter} ${w.name}<i>${w.en}</i>`;
    b.append(c, label);
    b.addEventListener('click', () => { closeSheets(); switchWorld(key); sendAppearance(); });
    grid.append(b);
  }
  applyWorldLabels();
}
function buildSwatches() {
  const box = $('swatches');
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button'); b.className = 'swatch'; b.dataset.paint = key;
    const i = document.createElement('i'); i.style.setProperty('--a', p.bodyColor); i.style.setProperty('--b', p.accentColor);
    b.append(i, document.createTextNode(p.name));
    b.addEventListener('click', () => setPaint(key));
    box.append(b);
  }
}
function setPaint(key, {silent = false} = {}) {
  if (!PRESETS[key]) return;
  prefs.paint = key; savePrefs();
  bike.setPaint({...PRESETS[key], finish: prefs.finish});
  ride.setPaint(key);
  document.querySelectorAll('.swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.paint === key)));
  document.querySelectorAll('[data-finish]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.finish === prefs.finish)));
  if (!silent) sendAppearance();
  if (!silent) { sfx.play('tap'); bike.render(); if (!isReduced()) { const t = bike.point('tank'); word(PRESETS[key].name, t.x, t.y - S.L.bike.lengthPx * .2, S.L.bike.lengthPx * .1, {rot: -6, han: true}); } }
}
document.querySelectorAll('[data-finish]').forEach(b => b.addEventListener('click', () => { prefs.finish = b.dataset.finish; setPaint(prefs.paint); }));
document.querySelectorAll('[data-sound]').forEach(b => b.addEventListener('click', async () => {
  sfx.unlock();
  // 原生：麦克风由原生采集（确认弹窗、不保存不上传）；网页只保留合成的声浪 DEMO。
  if (S.mode === 'native' && b.dataset.sound !== 'demo') {
    if (sound.mode === 'demo') sound.setMode('off');
    if (b.dataset.sound === 'mic') native.send('microphone'); else native.send('stopMicrophone');
    S.demoSoundRestore = null;
    document.querySelectorAll('[data-sound]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.sound === b.dataset.sound)));
    $('sound-note').textContent = b.dataset.sound === 'mic' ? '已请求原生麦克风（需确认）' : '声浪关闭';
    return;
  }
  await sound.setMode(b.dataset.sound);
  S.demoSoundRestore = null;
  document.querySelectorAll('[data-sound]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.sound === sound.mode)));
  $('sound-note').textContent = sound.status;
}));
document.querySelectorAll('[data-tier]').forEach(b => b.addEventListener('click', () => { prefs.tier = b.dataset.tier; savePrefs(); governor.setMode(prefs.tier); renderSettings(); }));
document.querySelectorAll('[data-sfx]').forEach(b => b.addEventListener('click', () => { prefs.sfx = b.dataset.sfx === 'on'; savePrefs(); sfx.setEnabled(prefs.sfx); renderSettings(); }));
document.querySelectorAll('[data-reduce]').forEach(b => b.addEventListener('click', () => { prefs.reduce = b.dataset.reduce; savePrefs(); applyReduced(); renderSettings(); }));
document.querySelectorAll('[data-fx]').forEach(b => b.addEventListener('click', () => { prefs.fx = b.dataset.fx; savePrefs(); renderSettings(); }));
$('btn-replay-synth')?.addEventListener('click', () => startReplay(generateSynthetic(), {label: '合成回放 · 非真实数据'}));
$('replay-file')?.addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return;
  try { startReplay(JSON.parse(await f.text()), {label: '回放 · 本机骑行文件'}); } catch (err) { $('replay-note').textContent = '回放文件读不了：' + String(err?.message || err).slice(0, 60); }
  e.target.value = '';
});
function renderSettings() {
  document.querySelectorAll('[data-tier]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tier === prefs.tier)));
  document.querySelectorAll('[data-sfx]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.sfx === 'on') === prefs.sfx)));
  document.querySelectorAll('[data-reduce]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.reduce === prefs.reduce)));
  document.querySelectorAll('[data-fx]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fx === prefs.fx)));
  setText('tier-now', `性能：${prefs.tier === 'auto' ? '自动' : '固定'} · ${tier().label}`);
}
function applyReduced() { app.classList.toggle('reduced', isReduced()); if (isReduced()) { director.cancel(); hideCutin(); fx.clear(); camera.style.transform = ''; } }
sysReduced.addEventListener?.('change', applyReduced);

governor.onChange(next => {
  for (const k of ['high', 'mid', 'low']) app.classList.toggle('tier-' + k, k === next);
  app.dataset.tier = next; S.tierChanges = (S.tierChanges || 0) + 1;
  painter.clear(); resize(); renderSettings();
});

/* ---------- 纸纹 ---------- */
function makeGrain() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) { const v = 200 + Math.random() * 55; img.data[i] = v; img.data[i + 1] = v * .96; img.data[i + 2] = v * .88; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  $('grain').style.backgroundImage = `url(${c.toDataURL()})`;
}

/* ---------- 原生 ---------- */
// 原生座舱（WKWebView）：记录、速度、阶段、弹窗、发热、外观持久化、分享都由原生决定；这里只渲染。
function sendAppearance() { if (S.mode === 'native') native.send('appearance', {paint: prefs.paint, finish: prefs.finish, world: S.world}); }
function updateNativeControls() {
  if (S.mode !== 'native') return;
  const demo = !!S.nativeDemoMode;
  setText('btn-demo-label', demo ? '进入演示骑行' : '开始骑行');
  $('btn-demo').setAttribute('aria-label', demo ? '进入演示骑行' : '开始骑行');
  setText('btn-demo-sub', demo ? 'DEMO · 原生演示骑行' : '倒计时后开始记录');
  $('btn-native-demo').hidden = demo;
  if (S.phase === 'riding') $('btn-pause').textContent = '暂停';
}
function startNativeCountdown(action) {
  if (S.phase !== 'idle' || S.nativeModal) return;
  sfx.unlock(); closeSheets();
  // 减少动态：不播倒计时，直接交给原生开始记录。
  if (isReduced()) { native.send(action); return; }
  S.nativeCountdown = {action, t0: now(), sent: false, sentAt: 0};
  setPhase('countdown'); S.burn = {t0: now(), auto: true}; $('btn-skip').hidden = false;
  native.send('countdown');
}
function commitNativeCountdown() {
  const c = S.nativeCountdown; if (!c || c.sent) return;
  c.sent = true; c.sentAt = now(); $('btn-skip').hidden = true;
  native.send(c.action);
}
function cancelNativeCountdown(reason = 'cancel') {
  if (!S.nativeCountdown) return;
  S.nativeCountdown = null; S.burn = null; $('btn-skip').hidden = true; clearCountdown();
  if (S.phase === 'countdown') setPhase('idle');
  S.eventsLog.push({kind: 'countdown-cancel', reason, t: now()});
  native.send('countdownCancel');
}
// 页面不可见（切后台或切到其他 tab）：rAF 停、音效静音、正在播的剧目与分镜收尾，回来不补播。
function suspendFx() { mplayer.cancel(); mdir.cancel(); director.cancel(); hideCutin(); resetSceneCamera(); if (S.gallery) S.gallery.playing = false; }
function beginNativeFinish() {
  player?.stop(); $('tbc').hidden = true;
  S.liveRecord = ride.record ? ride.finish(ride.rideT, {}) : null;
  setPhase('finishing'); showCountdown('FIN.', 'ready'); sfx.play('stamp');
  restoreDemoSound();
  // 原生没有送来复盘（例如网页层出错、原生已直接打开复盘）：5 秒后回待机。
  clearTimeout(S.finishWait);
  S.finishWait = setTimeout(() => { if (S.phase === 'finishing') backToIdle(); }, 5000);
}
const native = installNativeAdapter({
  nativeActive(on) {
    S.nativeInactive = !on;
    if (!on) { suspendFx(); cancelNativeCountdown('inactive'); }
    sfx.visibility(!on); loop.visibilityChanged();
  },
  nativeFlags(m) {
    S.mode = 'native';
    if (m.reduced !== S.nativeReduced) { S.nativeReduced = m.reduced; applyReduced(); }
    governor.setCap(m.cap); S.nativeCap = m.cap;
    if (m.modal && !ride.modal) { director.cancel(); hideCutin(); if (S.phase === 'countdown') cancelNativeCountdown('modal'); }
    ride.setModal(m.modal); S.nativeModal = m.modal;
    S.nativeSound = m.sound; S.nativeSoundStatus = m.sound.status; S.nativeElapsed = m.elapsedS; S.nativeDistance = m.distanceM;
    S.nativeSimulated = m.simulated; S.nativeTitle = m.title;
    if (m.demoMode !== S.nativeDemoMode) { S.nativeDemoMode = m.demoMode; updateNativeControls(); }
    if (!m.appearance && !S.appearanceSeeded) { S.appearanceSeeded = true; sendAppearance(); }
    if (!app.classList.contains('ready')) { updateNativeControls(); app.classList.add('ready'); }
  },
  nativeAppearance(a) {
    S.appearanceSeeded = true;
    if (a.world && a.world !== S.world) switchWorld(a.world, {flip: false});
    if (a.finish) prefs.finish = a.finish;
    if (a.paint || a.finish) setPaint(a.paint || prefs.paint, {silent: true});
  },
  nativePanel(name) { if (S.phase === 'idle') { if (name === 'world') buildWorldCards(); openSheet('sheet-' + name); } },
  nativePhase(phase, old, m) {
    S.mode = 'native';
    if (phase === 'riding') {
      if (S.phase === 'paused') { doResume(); return; }
      if (S.phase !== 'riding') { if (S.phase === 'comic' || S.phase === 'finishing') backToIdle(); closeSheets(); goRide({t: m.elapsedS, source: 'native', fanfare: old === 'idle'}); }
    } else if (phase === 'paused') {
      // 强杀恢复后直接进入暂停：静默建立骑行状态再定格，不放出发动画。
      if (S.phase !== 'riding' && S.phase !== 'paused') { if (S.phase === 'comic' || S.phase === 'finishing') backToIdle(); closeSheets(); goRide({t: m.elapsedS, source: 'native', fanfare: false}); }
      doPause();
    } else if (S.phase === 'riding' || S.phase === 'paused') beginNativeFinish();
    else if (S.phase === 'countdown' && !S.nativeCountdown) setPhase('idle');
  },
  nativeReading(frame) {
    ride.ingest(frame); milestoneReading(frame);
    if (sound.mode === 'demo' && Number.isFinite(frame.speedKmh)) sound.setDemoLevel(clamp(.12 + frame.speedKmh / 120, 0, 1));
  },
  nativeFinished(fr) {
    clearTimeout(S.finishWait);
    if (S.phase === 'riding' || S.phase === 'paused') beginNativeFinish();
    else if (S.phase !== 'finishing') { S.liveRecord = null; closeSheets(); setPhase('finishing'); showCountdown('FIN.', 'ready'); }
    clearTimeout(S.finishWait);
    S.nativeRecapId = fr.id;
    const record = buildComicRecord({finished: fr, live: S.liveRecord, makeModel: () => createRideModel({signals: Signals, game: Game}), world: S.world});
    setTimeout(() => { if (S.nativeRecapId === fr.id && S.phase === 'finishing') buildComic(record); }, isReduced() ? 100 : 900);
  },
  // 原生不再等待网页复盘（用户完成、打开了详细复盘或原生兜底）：漫画收起，回到待机。
  nativeRecapReleased() { if (S.phase === 'comic' || S.phase === 'finishing') backToIdle(); },
  nativeStale() { ride.ingest({t: ride.rideT + .001, speedKmh: null, source: 'unavailable', simulated: false}); },
  nativeVehicle(v) { setVehicle(v); },
});
if (native.native) {
  S.mode = 'native';
  document.documentElement.classList.add('native-host');
  // 原生 TabBar 已有“车库”（车辆档案 / 手册 / 保养）；场景里的小控件只管漫画车外观，改叫“配色”。
  setText('btn-garage', '配色'); $('btn-garage').setAttribute('aria-label', '外观与配色');
  document.querySelector('#sheet-garage header b').textContent = '外观与配色';
  setText('btn-close', '完成');
  updateNativeControls();
}
// 文案就绪后才显示按钮：浏览器立即；原生等第一份快照（演示开关决定主按钮文案），首帧不闪错误文字。
if (!native.native) app.classList.add('ready');

/* ---------- 启动 ---------- */
ride.onEvent(reactTo);
document.addEventListener('visibilitychange', () => {
  loop.visibilityChanged();
  sfx.visibility(document.hidden);
  // 隐藏时取消剧场与排队项，返回时不补播
  if (document.hidden) { suspendFx(); cancelNativeCountdown('hidden'); }
  if (document.hidden && sound.mode === 'mic') { sound.stop(); $('sound-note').textContent = '页面隐藏，麦克风已停止；需要时请重新开启'; }
  S.hiddenEvents = (S.hiddenEvents || 0) + (document.hidden ? 1 : 0);
});
// 旋转 / 改尺寸：合并到帧、稳定后才重建缓冲（core/resize.js）。
addEventListener('resize', () => resizer.request());
addEventListener('orientationchange', () => resizer.request());
for (const k of ['high', 'mid', 'low']) app.classList.toggle('tier-' + k, k === governor.tier);
governor.setMode(prefs.tier);
buildSwatches(); setPaint(prefs.paint, {silent: true}); applyWorldLabels(); applyReduced(); renderSettings(); makeGrain();
document.querySelectorAll('[data-sound]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.sound === sound.mode)));
resize();
loop.add(logic, {name: 'logic'});
loop.add((t, dt) => { if (S.phase !== 'paused' && S.phase !== 'comic') paintWorld(dt * (S.timeScale ?? 1)); }, {name: 'world'});
loop.add(bikeTask, {fps: () => tier().bikeFps, name: 'bike'});
loop.add(fxTask, {fps: () => tier().fxFps, name: 'fx'});
document.fonts.ready.then(() => { painter.clear(); S.fontsReady = true; });
// 字体自检（原生 UI 测试读这条文字确认三款内置字体在 App 内实际加载，而不是回退系统字体）。
const FACES = ['MotuoNum', 'MotuoDisplay', 'MotuoHan'];
Promise.all(FACES.map(f => document.fonts?.load?.(`20px "${f}"`, f === 'MotuoHan' ? '骑行' : '08') || null)).catch(() => {}).then(() => {
  const ok = FACES.filter(f => [...(document.fonts || [])].some(face => face.family.replace(/["']/g, '') === f && face.status === 'loaded'));
  setText('font-status', ok.length === FACES.length ? '座舱字体已加载 3/3' : `座舱字体回退 ${ok.length}/3`);
  document.documentElement.dataset.fonts = ok.join(',') || 'fallback';
});
native.ready();
bike.ready.then(() => { resize(); bike.setPaint({...PRESETS[prefs.paint], finish: prefs.finish}); });
if (!native.native && new URLSearchParams(location.search).get('gallery') === 'milestones') Promise.all([document.fonts.ready, bike.ready]).then(openGallery);
// ?replay=synthetic 或 ?replay=<本机 URL>（如 http://127.0.0.1:8767/ride.json）：读取后回放；文件不进 App 包、不进仓库。
const replayParam = !native.native && new URLSearchParams(location.search).get('replay');
if (replayParam) Promise.all([document.fonts.ready, bike.ready]).then(async () => {
  const q = new URLSearchParams(location.search), opts = {startAt: Number(q.get('from')) || 0, speedup: Number(q.get('speed')) || 1, endAt: Number(q.get('to')) || null};
  if (replayParam === 'synthetic') return startReplay(generateSynthetic(), {...opts, label: '合成回放 · 非真实数据'});
  try { startReplay(await (await fetch(replayParam)).json(), {...opts, label: '回放 · 本机骑行文件'}); } catch (e) { noteError(e); }
});

// 测试 / 录制钩子（只读状态 + 少量驱动）。
globalThis.__motuoV3 = {
  get layout() { return {W: S.W, H: S.H, dpr: S.dpr, landscape: !!S.L?.landscape, relayouts: S.relayouts || 0, live: S.layoutLive || 0, canvases: [sceneCanvas, fxCanvas, cutCanvas, flipCanvas, $('milestone'), $('bike-gl'), $('bike-vec')].map(c => ({id: c.id, w: c.width, h: c.height, hidden: c.hidden}))}; },
  get state() { return {phase: S.phase, mode: S.mode, nativeCountdown: !!S.nativeCountdown, cap: S.nativeCap || null, inactive: !!S.nativeInactive, world: S.world, speedText: speedValue.textContent, tier: governor.tier, tierMode: governor.mode, reduced: isReduced(), bike: bike.mode, rideT: ride.rideT, score: ride.score, loopRunning: loop.running, cutin: S.cut?.plan.kind || null, countdown: $('countdown').textContent, bikeRenderMs: +(S.bikeMs ?? 0).toFixed(2), tierChanges: S.tierChanges || 0, fontsReady: !!S.fontsReady, sfx: sfx.state}; },
  get flashLog() { return limiter.log.slice(); },
  get events() { return S.eventsLog.slice(); },
  get director() { return director.history.map(p => ({type: p.type, kind: p.kind, at: p.at, until: p.until, impact: p.impact})); },
  get comic() { return S.comic ? {moments: S.comic.moments, captions: S.comic.panels.map(p => p.caption), summary: S.comic.summary, record: {readings: S.comic.record.readings, events: S.comic.record.events, summary: S.comic.record.summary}, renderMs: S.comic.renderMs, revealedAt: S.comic.revealedAt} : null; },
  async exportComicDataURL() { const out = await exportComic(comicView.page('portrait').canvas, {toBlob: false}); return out.dataURL; },
  get comicView() { return comicView ? {current: comicView.current, revealing: comicView.revealing, cachedPortrait: comicView.cached('portrait'), cachedLandscape: comicView.cached('landscape'), panels: comicView.page(comicView.current).panels.map(p => p.poly)} : null; },
  startDemo, skip: () => player?.skipCountdown(), switchWorld, setPaint, setTier: v => { governor.setMode(v); renderSettings(); },
  bikePoint: name => bike.point(name), speedRect,
  get milestones() { return {plans: mdir.plans.map(({layers, compare, ...p}) => ({...p, compare: compare?.id || null})), counters: mdir.counters, active: mplayer.active ? {main: mplayer.active.main, threshold: mplayer.active.threshold, tier: mplayer.active.tier, item: mplayer.active.item || null, startedAt: mplayer.active.startedAt, ms: mplayer.active.ms, now: performance.now()} : null, todayBestAtStart: mdir.todayBestAtStart}; },
  gallery: {open: openGallery, close: closeGallery, play: (i, opts = {}) => { Object.assign(S.gallery, opts); galleryPlay(i); }, items: GALLERY_ITEMS, get state() { return {...S.gallery}; }},
  startReplay, replaySynthetic: (opts = {}) => startReplay(generateSynthetic(), {label: '合成回放 · 非真实数据', ...opts}), setFx: v => { prefs.fx = v; renderSettings(); },
  get vehicle() { return {vs: S.vs, live: vsLive(), vis: S.vis && {...S.vis}, words: S.vsWords.slice(-40), replayT: replay?.t ?? null, tilt: S.tilt, roll: S.roll}; },
};
