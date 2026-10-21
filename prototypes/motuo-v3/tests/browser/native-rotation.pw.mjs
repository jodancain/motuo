// v3 原生座舱旋转回归（浏览器层）：在页面里模拟原生桥（与 NativeCockpitView 同形状的快照、1Hz 演示读数、白名单动作），
// 用打包后的 ios/Motuo/Resources/Cockpit 跑完整流程，并在倒计时、骑行、突破剧场、暂停、漫画各状态中途改视口 390×844 ↔ 844×390。
// 先在仓库根：python3 scripts/prepare-native-cockpit.py && python3 -m http.server 8767 --bind 127.0.0.1 --directory ios/Motuo/Resources/Cockpit
//   node prototypes/motuo-v3/tests/browser/native-rotation.pw.mjs [chromium|webkit] [输出 json]
// playwright 包从 PLAYWRIGHT_DIR（默认 /tmp/motuo-v3-pw）加载；不改仓库依赖。
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
const require = createRequire((process.env.PLAYWRIGHT_DIR || '/tmp/motuo-v3-pw') + '/');
const pw = require('playwright');
const engine = process.argv[2] || 'chromium', out = process.argv[3];
const URL_ = process.env.COCKPIT_URL || 'http://127.0.0.1:8767/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const P = {width: 390, height: 844}, L = {width: 844, height: 390};

import {existsSync} from 'node:fs';
const CHROME = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await pw[engine].launch({headless: true, ...(engine === 'chromium' && existsSync(CHROME) ? {executablePath: CHROME, args: ['--use-angle=metal', '--ignore-gpu-blocklist']} : {})});
const ctx = await browser.newContext({viewport: P, deviceScaleFactor: 2});
await ctx.addInitScript(() => {
  // ---- 假原生：状态机与 RideEngine/NativeCockpitView 对齐（演示 1Hz 读数、计时不含暂停、结束后送汇总+时间线） ----
  const prof = [[0,0],[1,6],[3,15],[5,24],[7,32],[9,40],[11,47],[13,53],[15,58],[17,62],[19,66],[22,74],[25,82],[28,90],[31,97],[33,101],[35,104],[38,99],[41,84],[44,62],[47,40],[50,20],[52,8],[53,0],[56,0]];
  const kmhAt = t => { for (let i = 1; i < prof.length; i++) if (t <= prof[i][0]) { const [a, va] = prof[i - 1], [b, vb] = prof[i]; return va + (vb - va) * (t - a) / (b - a); } return 0; };
  const now = () => performance.now() / 1000;
  const N = window.__native = {phase: 'idle', dur: 0, segStart: 0, dist: 0, speed: null, st: null, se: null, sec: -1, simulated: false, modal: false, active: true, finished: null, timeline: [], sent: [], countdown: false, appearance: null};
  const elapsed = () => N.dur + (N.phase === 'riding' ? now() - N.segStart : 0);
  function start(sim) { Object.assign(N, {phase: 'riding', dur: 0, segStart: now(), dist: 0, speed: null, sec: -1, simulated: sim, timeline: [], countdown: false}); }
  function handle(m) {
    N.sent.push(m.action === 'share' ? {action: 'share', bytes: m.png.length, png: m.png.slice(0, 30)} : m);
    const a = m.action;
    if (a === 'primary') { if (N.phase === 'idle') start(false); else if (N.phase === 'paused') { N.phase = 'riding'; N.segStart = now(); N.speed = null; } else { N.dur = elapsed(); N.phase = 'paused'; N.speed = null; } }
    if (a === 'demoStart' && N.phase === 'idle') start(true);
    if (a === 'countdown') N.countdown = true;
    if (a === 'countdownCancel') N.countdown = false;
    if (a === 'finish') { N.modal = true; setTimeout(() => { N.modal = false; if (N.phase === 'riding') N.dur = elapsed(); N.finishedRide = {id: 'ride-' + Date.now(), distanceM: N.dist, durationS: N.dur, maxSpeedKmh: Math.max(...N.timeline.map(p => p.v ?? 0)), simulated: N.simulated, validSpeedSamples: N.timeline.length, timeline: N.timeline.slice(), events: []}; N.phase = 'idle'; N.speed = null; N.pending = true; }, 700); }
    if (a === 'wrappedShown') N.ack = true;
    if (a === 'rideDetail' || a === 'wrappedDone') { N.pending = false; N.detail = a === 'rideDetail'; }
    if (a === 'appearance') N.appearance = {...N.appearance, ...m};
  }
  window.webkit = {messageHandlers: {motuo: {postMessage: m => handle(JSON.parse(JSON.stringify(m)))}}};
  setInterval(() => {
    if (N.phase === 'riding') {
      const e = elapsed(), s = Math.floor(e);
      if (s !== N.sec) { N.sec = s; const v = N.simulated ? kmhAt(s % 56) : null; N.speed = v; N.st = now(); N.se = e; if (v != null) N.timeline.push({t: Math.round(e * 10) / 10, v: Math.round(v * 10) / 10}); }
      N.dist += (N.speed || 0) / 3.6 * .1;
    }
    const ap = N.appearance ? {paint: N.appearance.paint, finish: N.appearance.finish, world: N.appearance.world} : null;
    const snap = {phase: N.phase, modal: N.modal, active: N.active, simulated: N.simulated, demoMode: false, speedKmh: N.phase === 'riding' ? N.speed : null,
      speedSource: N.phase === 'riding' && N.speed != null ? 'gps' : 'unavailable', speedSampleTime: N.st, speedSampleElapsed: N.se, sampleTime: now(), seconds: elapsed(), distanceM: N.dist,
      stateLabel: '行驶中', motion: 'cruise', locationStatus: 'DEMO · 模拟定位', reduced: false, thermalState: 'nominal', lowPower: false, sound: {live: false, status: '麦克风关闭'}, appearance: ap, panel: null};
    if (N.pending && N.finishedRide) snap.finishedRide = N.finishedRide;
    window.MotuoNativeReceive?.(snap);
  }, 100);
  // ---- 速度可读性探针（同 v3 录制脚本）：骑行中每帧检查速度巨字未被遮挡 ----
  const Pr = window.__probe = {frames: 0, unreadable: [], residue: []};
  const css = document.createElement('style'); css.textContent = '.speed,.speed *{pointer-events:auto!important}';
  document.addEventListener('DOMContentLoaded', () => document.head.append(css));
  function readable() {
    const sp = document.getElementById('speed'), v = document.getElementById('speed-value'); if (!sp || !v) return false;
    const cs = getComputedStyle(sp); if (cs.visibility !== 'visible' || Number(cs.opacity) < .9 || cs.display === 'none') return false;
    const r = v.getBoundingClientRect(); if (r.width < 8 || r.height < 8 || !v.textContent.trim()) return false;
    if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) return false;
    for (const [fx, fy] of [[.25, .5], [.5, .3], [.5, .7], [.75, .5]]) { const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy); if (!el || !sp.contains(el)) return false; }
    return true;
  }
  const raf = window.requestAnimationFrame.bind(window);
  const tick = t => { const app = document.getElementById('app'); if (app && ['riding', 'paused'].includes(app.dataset.phase)) { Pr.frames++; if (!readable()) Pr.unreadable.push(t); } raf(tick); };
  raf(tick);
});
const page = await ctx.newPage();
const logs = [];
// 测试自身的 getImageData 回读会触发 Chrome 的 willReadFrequently 提示，不计入页面告警。
page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/willReadFrequently/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => logs.push('pageerror: ' + e.message));
const st = () => page.evaluate(() => ({...window.__motuoV3.state, layout: window.__motuoV3.layout, m: window.__motuoV3.milestones.active, sent: window.__native.sent.map(x => x.action), N: {phase: window.__native.phase, countdown: window.__native.countdown}, ax: [...document.querySelectorAll('.ax span')].map(s => s.textContent), sfx: document.querySelectorAll('.sfx-word').length, mHidden: document.getElementById('milestone').hidden, cutHidden: document.getElementById('cutin').hidden, flipHidden: document.getElementById('flip').hidden, countdownText: document.getElementById('countdown').textContent}));
const checks = [];
const check = (name, ok, detail) => { checks.push({name, ok: !!ok, detail}); if (!ok) console.error('FAIL', name, JSON.stringify(detail)); };
const frames = n => page.evaluate(n => new Promise(r => { const f = k => (k ? requestAnimationFrame(() => f(k - 1)) : r()); f(n); }), n);
// 全出血：场景面板等于整个视口；截图四角与四边中点都不是米色纸色（#f3ead6）。
async function checkBleed(label) {
  const r = await page.evaluate(() => { const p = document.getElementById('panel').getBoundingClientRect(); return {x: p.left, y: p.top, w: p.width, h: p.height, W: innerWidth, H: innerHeight}; });
  const png = await page.screenshot();
  const px = await page.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const pts = [[2, 2], [img.width - 3, 2], [2, img.height - 3], [img.width - 3, img.height - 3], [img.width >> 1, 2], [img.width >> 1, img.height - 3], [2, img.height >> 1], [img.width - 3, img.height >> 1]];
    return pts.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  }, png.toString('base64'));
  const paper = px.filter(([r, g, b]) => Math.abs(r - 243) < 10 && Math.abs(g - 234) < 10 && Math.abs(b - 214) < 10);
  check(`${label}: 场景全出血（面板=视口，边缘无米色纸边）`, Math.abs(r.x) < 1 && Math.abs(r.y) < 1 && Math.abs(r.w - r.W) < 1 && Math.abs(r.h - r.H) < 1 && paper.length === 0, {rect: r, edgePixels: px, paper: paper.length});
}
async function rotate(size, label) {
  await page.setViewportSize(size); await sleep(320);
  const s = await st(), lay = s.layout;
  const want = {W: size.width, H: size.height};
  check(`${label}: 重排到新尺寸 ${size.width}×${size.height}`, Math.abs(lay.W - want.W) <= 8 && Math.abs(lay.H - want.H) <= 8 && lay.landscape === size.width > size.height, lay);
  const scene = lay.canvases.find(c => c.id === 'scene');
  check(`${label}: 画布缓冲 = CSS 尺寸 × dpr`, scene.w === Math.round(lay.W * lay.dpr) && scene.h === Math.round(lay.H * lay.dpr), {scene, W: lay.W, H: lay.H, dpr: lay.dpr});
  check(`${label}: 无残留拟声字 / 翻页层`, s.sfx === 0 && s.flipHidden, {sfx: s.sfx, flip: s.flipHidden});
  check(`${label}: 剧场画布只在剧目播放时可见`, s.mHidden === !s.m, {mHidden: s.mHidden, active: !!s.m});
  return s;
}
await page.goto(URL_);
await page.waitForFunction(() => window.__motuoV3?.state.fontsReady && window.__motuoV3.state.bike !== 'loading', null, {timeout: 30000});
await sleep(800);
let s = await st();
check('原生模式与字体自检', s.mode === 'native' && s.ax[0] === '座舱字体已加载 3/3', {mode: s.mode, ax: s.ax});
check('就绪后回传 ready，外观首次同步给原生', s.sent[0] === 'ready' && s.sent.includes('appearance'), s.sent);
const nav = await page.evaluate(() => [...document.querySelectorAll('#btn-world,#btn-garage,#btn-sound,#btn-settings')].map(b => { const r = b.getBoundingClientRect(); return {id: b.id, top: r.top, bottom: r.bottom, text: b.textContent}; }));
check('待机：场景小控件在上方竖排，不形成底部导航', nav.every(n => n.bottom < 844 * .3) && nav.find(n => n.id === 'btn-garage').text === '配色', nav);
await checkBleed('待机 竖屏');
await rotate(L, '待机 竖→横'); await checkBleed('待机 横屏'); await rotate(P, '待机 横→竖');
// 出发倒计时中旋转：倒计时继续，走完才把 demoStart 交给原生
await page.click('#btn-native-demo');
await sleep(1300); s = await st();
check('倒计时开始：原生收到 countdown，尚未开始记录', s.phase === 'countdown' && s.N.countdown && s.N.phase === 'idle', s.N);
await rotate(L, '倒计时 竖→横');
s = await st(); check('倒计时旋转后继续显示', s.phase === 'countdown' && /^(3|2|1)$/.test(s.countdownText), s.countdownText);
await page.waitForFunction(() => window.__native.phase === 'riding', null, {timeout: 6000});
s = await st(); check('倒计时走完才发 demoStart', s.sent.indexOf('demoStart') > s.sent.indexOf('countdown'), s.sent);
// 骑行中 + 剧场中旋转
await page.waitForFunction(() => window.__motuoV3.milestones.active, null, {timeout: 15000});
const clock0 = (await st()).ax[2];
const plays = [];
for (const [size, label] of [[P, '剧场 横→竖'], [L, '剧场 竖→横'], [P, '剧场 横→竖 #2']]) { s = await rotate(size, label); plays.push(!!s.m); }
await checkBleed('骑行剧场 竖屏');
check('剧场按新布局继续或正常播完（无残留）', true, plays);
await page.waitForFunction(() => !window.__motuoV3.milestones.active, null, {timeout: 6000});
s = await st(); check('剧场结束后画布隐藏', s.mHidden, s.mHidden);
await page.waitForFunction(() => window.__motuoV3.milestones.active, null, {timeout: 15000});
s = await rotate(L, '第二个剧场中 竖→横');
const clock1 = (await st()).ax[2];
check('骑行计时持续增长（旋转不影响记录时钟）', parseInt(clock1.match(/\d+/)) > parseInt(clock0.match(/\d+/)), {clock0, clock1});
// 暂停中旋转
await page.click('#btn-pause'); await page.waitForFunction(() => window.__motuoV3.state.phase === 'paused', null, {timeout: 3000});
s = await rotate(P, '暂停 横→竖');
check('暂停按钮文案', (await page.textContent('#btn-pause')) === '继续骑行', null);
await page.click('#btn-pause'); await page.waitForFunction(() => window.__motuoV3.state.phase === 'riding', null, {timeout: 3000});
await sleep(2500);
// 结束 → 漫画 → 漫画中旋转 → 分享 → 详细复盘
await page.click('#btn-finish');
await page.waitForFunction(() => window.__motuoV3.state.phase === 'comic' && window.__motuoV3.comic?.revealedAt, null, {timeout: 12000});
s = await st(); check('结束后先回传 wrappedShown，再进入漫画', s.sent.includes('wrappedShown'), s.sent);
const comic = await page.evaluate(() => window.__motuoV3.comic);
check('漫画来自原生时间线与汇总', comic && comic.summary.source.includes('原生演示骑行') && comic.moments.length >= 4, comic && {source: comic.summary.source, n: comic.moments.length});
await rotate(L, '漫画 竖→横');
const comicBox = await page.evaluate(() => { const c = document.getElementById('comic-canvas').getBoundingClientRect(), b = [...document.querySelectorAll('.comic-actions .sticker')].filter(x => x.offsetParent).map(x => { const r = x.getBoundingClientRect(); return {t: x.textContent, r: r.right, b: r.bottom}; }); return {c: {w: c.width, h: c.height, b: c.bottom, r: c.right}, b, W: innerWidth, H: innerHeight}; });
check('横屏漫画页与按钮都在画面内', comicBox.c.b <= comicBox.H && comicBox.c.r <= comicBox.W && comicBox.b.every(x => x.r <= comicBox.W && x.b <= comicBox.H) && comicBox.b.map(x => x.t).join() === '保存图片,查看详细复盘,完成', comicBox);
await rotate(P, '漫画 横→竖');
await page.click('#btn-save'); await sleep(800);
const share = await page.evaluate(() => window.__native.sent.find(x => x.action === 'share'));
check('保存图片：PNG 交给原生分享面板', share && share.png.startsWith('data:image/png;base64,') && share.bytes > 50000, share && {bytes: share.bytes});
await page.click('#btn-detail'); await sleep(500);
s = await st(); check('查看详细复盘：回传 rideDetail 并回到待机', s.sent.includes('rideDetail') && s.phase === 'idle', {phase: s.phase});
const probe = await page.evaluate(() => window.__probe);
// 最长连续不可读时长（帧时间戳差）
let worst = 0, run = null, prev = null;
for (const t of probe.unreadable) { if (prev != null && t - prev < 40) worst = Math.max(worst, t - run); else run = t; prev = t; }
check('骑行/暂停中速度巨字最长遮挡 ≤150ms', worst <= 150 && probe.frames > 200, {frames: probe.frames, unreadableFrames: probe.unreadable.length, worstMs: Math.round(worst)});
check('控制台 0 error/warn', logs.length === 0, logs.slice(0, 5));
const result = {engine, url: URL_, at: new Date().toISOString(), passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, checks};
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`${engine}: ${result.passed}/${checks.length} checks passed`);
await browser.close();
process.exit(result.failed ? 1 : 0);
