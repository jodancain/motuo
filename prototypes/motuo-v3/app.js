/* Motuo v3 · 骑行即漫画 MV —— 主程序。
 * 状态：idle → countdown → riding ⇄ paused → finishing → comic → idle
 * 一个 rAF（core/loop.js）驱动：world 60fps · bike 12fps · fx 30fps · logic 每帧。
 */
import {createLoop, createPerfGovernor, TIER_CONFIG} from './core/loop.js';
import {buildDemoScript, createDemoPlayer} from './core/demo-script.js';
import {createRideModel, speedText, sourceLabel, formatClock, formatKm} from './core/ride-model.js';
import {createDirector, createFlashLimiter, cutinLayout, IMPACT_MS} from './core/director.js';
import {selectMoments, PAGE} from './core/comic-layout.js';
import {stageLayout, speedFit, countdownFit, maxDash} from './core/layout.js';
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
import {createMilestoneDirector, ACTS as MILESTONE_ACTS} from './core/milestone-director.js';
import {createMilestonePlayer} from './render/milestone-player.js';
import {GALLERY_ITEMS, GALLERY_TIERS, galleryPlan} from './core/milestone-gallery.js';

const $ = id => document.getElementById(id);
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
let prefs = {world: 'neon', paint: 'ember', finish: 'gloss', tier: 'auto', sfx: true, reduce: 'system'};
try { prefs = {...prefs, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}')}; } catch { /* 默认值 */ }
prefs.world = normalizeWorld(prefs.world);
if (!PRESETS[prefs.paint]) prefs.paint = 'ember';
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 预览不保存 */ } };

/* ---------- 子系统 ---------- */
const governor = createPerfGovernor();
const loop = createLoop({raf: f => requestAnimationFrame(f), caf: h => cancelAnimationFrame(h), now, hidden: () => document.hidden, governor});
const limiter = createFlashLimiter({maxPerSecond: 2});
const sysReduced = matchMedia('(prefers-reduced-motion: reduce)');
const isReduced = () => prefs.reduce === 'on' || sysReduced.matches || S.nativeReduced;
const director = createDirector({limiter, reduced: isReduced});
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
};
const st = {x: 0, t: 0, speed: 0, accel: null, eq: null, misprint: true, particles: 1, weather: [], lines: [], focus: 0, focusX: 0, focusY: 0, dt: 0};
const springs = {pitch: {x: 0, v: 0}, yaw: {x: 0, v: 0}, squash: {x: 1, v: 0}};
const spring = (s, target, dt, k = 140, c = 17) => { s.v += (k * (target - s.x) - c * s.v) * dt; s.x += s.v * dt; };

/* ---------- 版式 ---------- */
function tier() { return TIER_CONFIG[governor.tier]; }
function resize() {
  S.W = Math.max(1, panel.clientWidth); S.H = Math.max(1, panel.clientHeight);
  S.L = stageLayout(S.W, S.H);
  app.classList.toggle('landscape', S.L.landscape); app.classList.toggle('portrait', !S.L.landscape);
  const t = tier();
  S.dpr = Math.min(devicePixelRatio || 1, t.dpr);
  for (const c of [sceneCanvas, fxCanvas, cutCanvas, flipCanvas, $('milestone')]) { c.width = Math.round(S.W * S.dpr); c.height = Math.round(S.H * S.dpr); }
  bike.layout(S.L, S.W, S.H, Math.min(devicePixelRatio || 1, t.bikeDpr));
  const m = bikeMapping(S.L), hit = $('bike-hit');
  Object.assign(hit.style, {left: m.sx(-1.05) + 'px', top: m.sy(1.2) + 'px', width: (m.sx(1.05) - m.sx(-1.05)) + 'px', height: (S.L.bike.ground - m.sy(1.2) + 10) + 'px'});
  app.style.setProperty('--cd-x', S.L.landscape ? '-16%' : '0%');
  fitSpeed(true);
  bike.render();
}
function fitSpeed(force) {
  const text = speedValue.textContent || '0';
  const digits = Math.max(2, text.replace(/[^0-9—]/g, '').length);
  if (!force && digits === S.fitDigits) return;
  S.fitDigits = digits;
  const f = speedFit(S.L, digits);
  app.style.setProperty('--speed-size', f.fontSize + 'px');
  app.style.setProperty('--speed-sx', String(f.scaleX));
  app.style.setProperty('--speed-right', S.L.speed.right + 'px');
  app.style.setProperty('--speed-top', S.L.speed.top + 'px');
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
  const stampText = S.phase === 'gallery' ? '预览 · 非骑行数据' : 'DEMO';
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
  setText('source', S.phase === 'countdown' ? '倒计时 · DEMO' : riding ? sourceLabel(ride.reading, S.phase) : S.mode === 'native' ? '原生待机' : '待机 · 未在记录');
  setText('sound-status', S.sound.valid ? (S.sound.demo ? '声浪 DEMO' : '麦克风声浪') : sound.status);
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
function goRide({t = 0, source}) {
  $('btn-skip').hidden = true;
  setText('countdown', ''); $('countdown').replaceChildren();
  S.burn = null;
  ride.begin({t, source, world: S.world, paint: prefs.paint});
  mdir = createMilestoneDirector({seed: source === 'demo' ? 20261021 : (Date.now() & 0xffffff), storage: globalThis.localStorage});
  mdir.begin({simulated: source === 'demo'});
  setPhase('riding');
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
function showCountdown(text, cls = '') {
  const b = document.createElement('b'); b.className = cls;
  const f = countdownFit(S.W, S.H, text);
  f.lines.forEach((l, i) => { if (i) b.append(document.createElement('br')); b.append(l); });
  b.setAttribute('aria-label', text);
  Object.assign(b.style, {left: f.x + 'px', top: f.y + 'px', fontSize: f.fontSize + 'px'});
  b.style.setProperty('--sx', f.sx); b.style.setProperty('--sy', f.sy);
  $('countdown').replaceChildren(b);
  if (isReduced()) return;
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
  $('btn-pause').textContent = '继续';
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
const pageCanvas = document.createElement('canvas');
async function buildComic(record) {
  $('countdown').replaceChildren();
  await document.fonts.ready;
  const moments = selectMoments(record);
  const view = $('comic-canvas');
  view.width = PAGE.W; view.height = PAGE.H;
  if (moments.length < 2) {
    $('comic-note').textContent = '本次记录的有效读数太少，未生成漫画。';
    setPhase('comic'); $('comic').hidden = false; return;
  }
  const t0 = now();
  const result = renderComicPage(pageCanvas, {record, moments, painter, bike});
  S.comic = {record, moments, panels: result.panels, summary: result.summary, renderMs: Math.round(now() - t0), revealedAt: null};
  $('comic-note').textContent = `${moments.length} 格 · ${result.summary.source}。游戏分为游戏，非驾驶评价。`;
  setPhase('comic'); $('comic').hidden = false;
  sfx.play('shutter');
  revealComic(view, result);
  restoreDemoSound();
}
function revealComic(view, result) {
  const g = view.getContext('2d');
  // 第一拍：纸 + 页眉页脚，格子空白；之后逐格砸入。
  g.drawImage(pageCanvas, 0, 0);
  for (const p of result.panels) { tracePath(g, p.poly); g.fillStyle = '#f3ead6'; g.fill(); g.lineWidth = 7; g.strokeStyle = '#0b0a12'; g.stroke(); }
  if (isReduced()) { g.drawImage(pageCanvas, 0, 0); S.comic.revealedAt = now(); return; }
  const t0 = now(), each = 420;
  let shown = -1;
  loop.add(t => {
    if (S.phase !== 'comic') return false;
    const i = Math.min(result.panels.length - 1, Math.floor((t - t0) / each));
    const k = clamp(((t - t0) - i * each) / 160, 0, 1);
    for (let j = 0; j <= i; j++) {
      const p = result.panels[j], scale = j === i ? 1 + .14 * (1 - k) * (1 - k) : 1;
      g.save(); tracePath(g, p.poly); g.clip();
      g.fillStyle = '#f3ead6'; g.fill();
      const b = p.poly.reduce((a, [x, y]) => ({x: a.x + x / p.poly.length, y: a.y + y / p.poly.length}), {x: 0, y: 0});
      g.translate(b.x, b.y); g.scale(scale, scale); g.translate(-b.x, -b.y);
      g.drawImage(pageCanvas, 0, 0); g.restore();
      tracePath(g, p.poly); g.lineWidth = 7; g.strokeStyle = '#0b0a12'; g.stroke();
    }
    if (i !== shown) { shown = i; sfx.play('stamp'); }
    if (t - t0 > each * result.panels.length + 200) { g.drawImage(pageCanvas, 0, 0); S.comic.revealedAt = now(); return false; }
  }, {fps: 30, name: 'comic-reveal'});
}
function restoreDemoSound() { if (S.demoSoundRestore !== null) { sound.setMode(S.demoSoundRestore); S.demoSoundRestore = null; } }
function backToIdle() {
  $('comic').hidden = true;
  ride.reset(); player = null; S.mode = native.native ? 'native' : null;
  restoreDemoSound();
  setPhase('idle');
  $('countdown').replaceChildren();
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
  if (S.phase !== 'riding') return;
  const plan = mdir.reading({...frame, world: S.world}, now());
  if (plan) startMilestone(plan);
}
function startMilestone(plan) {
  mplayer.play(plan, {W: S.W, H: S.H, L: S.L, point: n => bike.point(n), speedRect: speedRect(), particles: isReduced() ? 0 : tier().particles, dpr: S.dpr, seed: 7, bikeImage: bike.mode === 'glb' ? $('bike-gl') : $('bike-vec')}, plan.startedAt);
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

/* ---------- 每帧 ---------- */
function paintWorld(dt) {
  const g = sceneCanvas.getContext('2d');
  g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  const t = tier(), reduced = isReduced();
  st.dt = dt; st.t += dt; st.speed = S.speedVis; st.accel = S.phase === 'riding' ? ride.accel : null;
  st.misprint = t.misprint; st.particles = reduced ? 0 : t.particles;
  st.eq = S.sound.valid ? S.sound.bands : null;
  st.focus = S.focus; st.focusX = bike.point('tank').x; st.focusY = bike.point('tank').y + 20; st.focusJitter = Math.floor(st.t * 12);
  painter.paint(g, S.W, S.H, S.L, S.world, st);
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
  p.shake = reduced ? 0 : (S.burn ? .9 : t < S.revUntil ? .7 : 0) + snd * .5 + (riding ? S.speedVis / 260 : 0);
  p.impact = 0;
  // 突破剧场：车按剧目动作（前冲/后退、抬头、压低、甩尾、震动），仍按 12fps 步进渲染
  const mb = S.mcam?.bike;
  if (mb && !reduced) { p.dz += mb.dz; p.dy = mb.dy; p.pitch += mb.pitch; p.yaw += mb.yaw; p.squash *= mb.squash; p.shake += mb.shake; } else p.dy = 0;
}
function logic(t, dt) {
  const reduced = isReduced();
  if (player && (S.phase === 'countdown' || S.phase === 'riding' || S.phase === 'paused')) player.advance(dt);
  if (S.phase === 'countdown' && player) {
    const w = player.wallSeconds, label = w < 1 ? 'READY' : w < 2 ? '3' : w < 3 ? '2' : '1';
    if (label !== S.countdownLabel) { S.countdownLabel = label; showCountdown(label, label === 'READY' ? 'ready' : ''); sfx.play('beep'); }
  } else S.countdownLabel = '';
  if (S.goUntil && t > S.goUntil) { S.goUntil = 0; if (S.phase === 'riding') $('countdown').replaceChildren(); }
  if (S.phase === 'riding') {
    const evs = ride.tick(ride.rideT);
    void evs;
    director.update(t);
    if (!reduced) drawCutin(t); else hideCutin();
  }
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
  if (S.phase !== 'paused' && !reduced) st.x += S.speedVis * 15 * S.L.scrollScale * dt * S.timeScale;
  // 声浪
  S.sound = S.mode === 'native' ? (S.nativeSound || {valid: false}) : sound.sample(dt, S.phase === 'paused');
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
    const tiltT = reduced ? 0 : clamp(-accel * 1.1, -4, 4) + (t < S.cornerUntil ? -2.4 : 0);
    S.tilt += (tiltT - S.tilt) * (1 - Math.exp(-dt * 4));
    S.shake *= Math.exp(-dt * 9);
    const j = reduced ? 0 : S.shake * 7;
    const pan = (S.mcam?.panX || 0) * S.W;
    camera.style.transform = `translate(${((Math.random() - .5) * j + pan).toFixed(1)}px,${((Math.random() - .5) * j).toFixed(1)}px) rotate(${S.tilt.toFixed(2)}deg) scale(1.06)`;
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
$('btn-demo').addEventListener('click', startDemo);
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
$('btn-skip').addEventListener('click', () => player?.skipCountdown());
$('btn-pause').addEventListener('click', () => {
  if (S.mode === 'native') return native.send('primary');
  if (S.phase === 'riding') player?.hold(); else if (S.phase === 'paused') player?.release();
});
$('btn-finish').addEventListener('click', () => (S.mode === 'native' ? native.send('finish') : doFinish()));
$('btn-world-ride').addEventListener('click', () => switchWorld(nextWorld(S.world)));
$('btn-save').addEventListener('click', async () => { sfx.play('shutter'); const out = await downloadComic(pageCanvas); $('comic-note').textContent = `已保存 ${out.filename}`; });
$('btn-again').addEventListener('click', () => { backToIdle(); startDemo(); });
$('btn-close').addEventListener('click', backToIdle);

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
    b.addEventListener('click', () => { closeSheets(); switchWorld(key); });
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
  if (!silent) { sfx.play('tap'); bike.render(); if (!isReduced()) { const t = bike.point('tank'); word(PRESETS[key].name, t.x, t.y - S.L.bike.lengthPx * .2, S.L.bike.lengthPx * .1, {rot: -6, han: true}); } }
}
document.querySelectorAll('[data-finish]').forEach(b => b.addEventListener('click', () => { prefs.finish = b.dataset.finish; setPaint(prefs.paint); }));
document.querySelectorAll('[data-sound]').forEach(b => b.addEventListener('click', async () => {
  sfx.unlock();
  await sound.setMode(b.dataset.sound);
  S.demoSoundRestore = null;
  document.querySelectorAll('[data-sound]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.sound === sound.mode)));
  $('sound-note').textContent = sound.status;
}));
document.querySelectorAll('[data-tier]').forEach(b => b.addEventListener('click', () => { prefs.tier = b.dataset.tier; savePrefs(); governor.setMode(prefs.tier); renderSettings(); }));
document.querySelectorAll('[data-sfx]').forEach(b => b.addEventListener('click', () => { prefs.sfx = b.dataset.sfx === 'on'; savePrefs(); sfx.setEnabled(prefs.sfx); renderSettings(); }));
document.querySelectorAll('[data-reduce]').forEach(b => b.addEventListener('click', () => { prefs.reduce = b.dataset.reduce; savePrefs(); applyReduced(); renderSettings(); }));
function renderSettings() {
  document.querySelectorAll('[data-tier]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tier === prefs.tier)));
  document.querySelectorAll('[data-sfx]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.sfx === 'on') === prefs.sfx)));
  document.querySelectorAll('[data-reduce]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.reduce === prefs.reduce)));
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
const native = installNativeAdapter({
  nativePhase(phase, old) {
    S.mode = 'native';
    if (phase === 'riding' && old === 'idle') goRide({t: 0, source: 'native'});
    else if (phase === 'paused') doPause();
    else if (phase === 'riding' && old === 'paused') doResume();
    else if (phase === 'idle' && (old === 'riding' || old === 'paused')) { S.nativeSummary = null; /* 等 finishedRide 生成漫画 */ }
  },
  nativeFlags(m) { S.nativeReduced = m.reduced; applyReduced(); governor.setCap(m.thermal ? 'mid' : null); ride.setModal(m.modal); S.nativeSound = m.sound; S.nativeElapsed = m.elapsedS; S.nativeDistance = m.distanceM; },
  nativeReading(frame) { ride.ingest(frame); milestoneReading(frame); },
  nativeFinished(fr) { S.nativeSummary = {distanceM: fr.distanceM, durationS: fr.durationS, maxSpeedKmh: fr.maxSpeedKmh}; if (ride.record) { S.phase = 'riding'; doFinish(); } },
  nativeStale() { ride.ingest({t: ride.rideT + .001, speedKmh: null, source: 'unavailable', simulated: false}); },
});

/* ---------- 启动 ---------- */
ride.onEvent(reactTo);
document.addEventListener('visibilitychange', () => {
  loop.visibilityChanged();
  sfx.visibility(document.hidden);
  // 隐藏时取消剧场与排队项，返回时不补播
  if (document.hidden) { mplayer.cancel(); mdir.cancel(); director.cancel(); hideCutin(); resetSceneCamera(); if (S.gallery) S.gallery.playing = false; }
  if (document.hidden && sound.mode === 'mic') { sound.stop(); $('sound-note').textContent = '页面隐藏，麦克风已停止；需要时请重新开启'; }
  S.hiddenEvents = (S.hiddenEvents || 0) + (document.hidden ? 1 : 0);
});
addEventListener('resize', resize);
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
bike.ready.then(() => { resize(); bike.setPaint({...PRESETS[prefs.paint], finish: prefs.finish}); });
if (new URLSearchParams(location.search).get('gallery') === 'milestones') Promise.all([document.fonts.ready, bike.ready]).then(openGallery);

// 测试 / 录制钩子（只读状态 + 少量驱动）。
globalThis.__motuoV3 = {
  get state() { return {phase: S.phase, mode: S.mode, world: S.world, speedText: speedValue.textContent, tier: governor.tier, tierMode: governor.mode, reduced: isReduced(), bike: bike.mode, rideT: ride.rideT, score: ride.score, loopRunning: loop.running, cutin: S.cut?.plan.kind || null, countdown: $('countdown').textContent, bikeRenderMs: +(S.bikeMs ?? 0).toFixed(2), tierChanges: S.tierChanges || 0, fontsReady: !!S.fontsReady, sfx: sfx.state}; },
  get flashLog() { return limiter.log.slice(); },
  get events() { return S.eventsLog.slice(); },
  get director() { return director.history.map(p => ({type: p.type, kind: p.kind, at: p.at, until: p.until, impact: p.impact})); },
  get comic() { return S.comic ? {moments: S.comic.moments, captions: S.comic.panels.map(p => p.caption), summary: S.comic.summary, record: {readings: S.comic.record.readings, events: S.comic.record.events, summary: S.comic.record.summary}, renderMs: S.comic.renderMs, revealedAt: S.comic.revealedAt} : null; },
  async exportComicDataURL() { const out = await exportComic(pageCanvas, {toBlob: false}); return out.dataURL; },
  startDemo, skip: () => player?.skipCountdown(), switchWorld, setPaint, setTier: v => { governor.setMode(v); renderSettings(); },
  bikePoint: name => bike.point(name), speedRect,
  get milestones() { return {plans: mdir.plans.map(({layers, compare, ...p}) => ({...p, compare: compare?.id || null})), counters: mdir.counters, active: mplayer.active ? {main: mplayer.active.main, threshold: mplayer.active.threshold, tier: mplayer.active.tier, item: mplayer.active.item || null, startedAt: mplayer.active.startedAt, ms: mplayer.active.ms, now: performance.now()} : null, todayBestAtStart: mdir.todayBestAtStart}; },
  gallery: {open: openGallery, close: closeGallery, play: (i, opts = {}) => { Object.assign(S.gallery, opts); galleryPlay(i); }, items: GALLERY_ITEMS, get state() { return {...S.gallery}; }},
};
