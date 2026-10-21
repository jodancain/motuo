// 竖屏 390×844 突破画廊：每个剧目（17 种 + 回归 / 今日新高 / 100 大事件）全程采样，
// 测量车出画比例（含镜头平移与 1.06 缩放）与剧场画布对车身包围盒的真实像素覆盖率；爆点前（P≈.40）后（P≈.64）各截一张。
// 先：python3 -m http.server 8766 --bind 127.0.0.1 --directory prototypes/motuo-v3
//   node prototypes/motuo-v3/tests/browser/gallery-portrait.pw.mjs <输出目录> [chromium|webkit] [WxH]
import {createRequire} from 'node:module';
import {writeFileSync, mkdirSync, existsSync} from 'node:fs';
const require = createRequire((process.env.PLAYWRIGHT_DIR || '/tmp/motuo-v3-pw') + '/');
const pw = require('playwright');
const OUT = process.argv[2] || '/tmp/motuo-gallery-portrait', engine = process.argv[3] || 'chromium';
const [W, H] = (process.argv[4] || '390x844').split('x').map(Number);
// 约定：车出画 ≤15% 车长；剧场像素覆盖车身包围盒 单帧 ≤25%、全程平均 ≤15%（包围盒含车轮上方的空角，实际压到车身更少）。
const MAX_OUT = .15, MAX_COVER = .25, MAX_COVER_MEAN = .15;
mkdirSync(OUT, {recursive: true});
const CHROME = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await pw[engine].launch({headless: true, ...(engine === 'chromium' && existsSync(CHROME) ? {executablePath: CHROME, args: ['--use-angle=metal', '--ignore-gpu-blocklist']} : {})});
const page = await (await browser.newContext({viewport: {width: W, height: H}, deviceScaleFactor: 2})).newPage();
const logs = [];
// 测量自身的 getImageData 回读会触发 Chrome 的 willReadFrequently 提示，不计入页面告警。
page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/willReadFrequently/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push('pageerror: ' + e.message));
await page.goto(process.env.V3_URL || 'http://127.0.0.1:8766/');
await page.waitForFunction(() => window.__motuoV3?.state.fontsReady && window.__motuoV3.state.bike !== 'loading', null, {timeout: 30000});
await page.evaluate(() => window.__motuoV3.gallery.open());
await new Promise(r => setTimeout(r, 600));
const items = await page.evaluate(() => window.__motuoV3.gallery.items);
// 采样：车身包围盒（与 render/milestone-player.js bikeBody 同一定义）经 camera 变换后的屏幕位置；剧场画布在盒内的不透明像素占比。
const measure = () => page.evaluate(() => {
  const V = window.__motuoV3, q = n => V.bikePoint(n), a = V.milestones.active;
  if (!a) return null;
  const ra = q('rearAxle'), fa = q('frontAxle'), ys = ['tank', 'seat', 'headlight', 'exhaust'].map(n => q(n).y);
  const ppu = Math.abs(fa.x - ra.x) / (.749 + .669) || 1;
  let x0 = Math.min(ra.x, fa.x) - .335 * ppu, x1 = Math.max(ra.x, fa.x) + .301 * ppu, y0 = Math.min(...ys) - .16 * ppu, y1 = Math.max(q('rearContact').y, q('frontContact').y);
  const cam = document.getElementById('camera'), panel = document.getElementById('panel'), cs = getComputedStyle(cam);
  const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform), [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
  const tp = (x, y) => ({x: ox + m.a * (x - ox) + m.c * (y - oy) + m.e, y: oy + m.b * (x - ox) + m.d * (y - oy) + m.f});
  const p0 = tp(x0, y1), p1 = tp(x1, y1), p2 = tp(x0, y0), p3 = tp(x1, y0);
  x0 = Math.min(p0.x, p2.x); x1 = Math.max(p1.x, p3.x); y0 = Math.min(p2.y, p3.y); y1 = Math.max(p0.y, p1.y);
  const PW = panel.clientWidth, len = x1 - x0, out = (Math.max(0, -x0) + Math.max(0, x1 - PW)) / len;
  const c = document.getElementById('milestone'), k = c.width / PW, g = c.getContext('2d');
  const bx = Math.max(0, Math.round(x0 * k)), by = Math.max(0, Math.round(y0 * k)), bw = Math.min(c.width, Math.round(x1 * k)) - bx, bh = Math.min(c.height, Math.round(y1 * k)) - by;
  let cover = 0;
  if (bw > 0 && bh > 0 && !c.hidden) { const d = g.getImageData(bx, by, bw, bh).data; let n = 0; for (let i = 3; i < d.length; i += 16) { n++; if (d[i] > 128) cover++; } cover /= n; }
  return {P: (performance.now() - a.startedAt) / a.ms, out, cover, box: {x0, x1, y0, y1}};
});
const results = [];
for (let i = 0; i < items.length; i++) {
  await page.evaluate(i => window.__motuoV3.gallery.play(i, {world: ['neon', 'sunset', 'snow', 'cosmic'][i % 4], tier: 2, auto: false}), i);
  const samples = [], shots = {};
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const s = await measure(); if (!s) break;
    samples.push(s);
    for (const [name, at] of [['before', .40], ['after', .64]]) if (!shots[name] && s.P >= at) { const f = `${OUT}/p-${String(i + 1).padStart(2, '0')}-${items[i]}-${name}.png`; await page.screenshot({path: f}); shots[name] = f; }
    await new Promise(r => setTimeout(r, 30));
  }
  const maxOut = Math.max(0, ...samples.map(s => s.out)), maxCover = Math.max(0, ...samples.map(s => s.cover)), meanCover = samples.reduce((a, s) => a + s.cover, 0) / Math.max(1, samples.length);
  results.push({i: i + 1, item: items[i], samples: samples.length, maxOut: +maxOut.toFixed(3), maxCover: +maxCover.toFixed(3), meanCover: +meanCover.toFixed(3), ok: maxOut <= MAX_OUT && maxCover <= MAX_COVER && meanCover <= MAX_COVER_MEAN, shots: Object.values(shots).map(f => f.split('/').pop())});
  await new Promise(r => setTimeout(r, 300));
}
const report = {engine, viewport: `${W}x${H}`, limits: {maxOut: MAX_OUT, maxCover: MAX_COVER, meanCover: MAX_COVER_MEAN}, logs, results, passed: results.filter(r => r.ok).length, total: results.length};
writeFileSync(`${OUT}/gallery-portrait-report.json`, JSON.stringify(report, null, 2));
for (const r of results) console.log(`${r.ok ? 'ok ' : 'BAD'} ${String(r.i).padStart(2)} ${r.item.padEnd(14)} out ${r.maxOut} cover max ${r.maxCover} mean ${r.meanCover} (${r.samples})`);
console.log(`${report.passed}/${report.total} acts within limits; console ${logs.length}`);
await browser.close();
process.exit(report.passed === report.total && !logs.length ? 0 : 1);
