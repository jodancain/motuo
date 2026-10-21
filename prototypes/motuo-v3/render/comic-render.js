/* 「今日骑行漫画」页面渲染与导出。
 * 每格：当时世界的场景重绘（同一个 paintWorld）+ 当时姿态的车 + 烟/火/火花 + 拟声字 + 旁白框（记录值）。
 * 导出：canvas.toBlob('image/png')；没有 toBlob 时退回 toDataURL。 */
import {PAGE, pageLayout, captionFor, pageSummary, comicFilename, MOMENT_COPY} from '../core/comic-layout.js';
import {tracePath, bounds, rng} from '../core/geometry.js';
import {stageLayout, bikeMapping} from '../core/layout.js';
import {WORLDS} from './worlds.js';
import {halftone} from './scene.js';
import {drawSmoke, drawFlame, drawSparks, drawTextStamp, drawWheelArcs, drawContactShadow} from './fx.js';
import {buildEnv, drawPlan} from './milestone-player.js';
import {BIKE_POINTS} from './bike-vector.js';

const POSE = {
  launch: {pitch: -.2, yaw: 0, dz: 0, dy: 0, squash: 1, shake: 0, impact: 0},
  top: {pitch: 0, yaw: 0, dz: 0, dy: 0, squash: 1.07, shake: 0, impact: 0},
  accel: {pitch: -.09, yaw: 0, dz: 0, dy: 0, squash: 1.03, shake: 0, impact: 0},
  corner: {pitch: 0, yaw: .42, dz: 0, dy: 0, squash: 1, shake: 0, impact: 0},
  brake: {pitch: .07, yaw: 0, dz: 0, dy: 0, squash: .97, shake: 0, impact: 0},
  cruise: {pitch: 0, yaw: -.2, dz: 0, dy: 0, squash: 1, shake: 0, impact: 0},
  milestone: {pitch: -.08, yaw: 0, dz: 0, dy: 0, squash: 1.05, shake: 0, impact: 0},
  finish: {pitch: 0, yaw: -.55, dz: 0, dy: 0, squash: 1, shake: 0, impact: 0},
};

function staticLines(W, H, top, bottom, speed, seed) {
  const r = rng(seed), n = Math.round(Math.min(1, speed / 80) * 22) + 4, out = [];
  for (let i = 0; i < n; i++) out.push({x: r() * W, y: top + r() * (bottom - top), len: (40 + speed * 4) * (W / 844) * (.6 + r() * .8), w: 1 + r() * 3.5});
  return out;
}

function panelLayout(pw, ph, kind) {
  // 格内版式：车更大、更靠中；竖长格用竖屏规则。
  const L = stageLayout(pw, ph);
  const len = Math.min(pw * (kind === 'finish' ? .62 : .78), ph * 1.35);
  L.bike = {...L.bike, lengthPx: Math.round(len), rearX: Math.round(pw / 2 - len / 2 + (kind === 'launch' ? -pw * .05 : 0)), ground: Math.round(L.roadTop + (ph - L.roadTop) * .5)};
  return L;
}

export function drawPanel(ctx, panel, moment, {painter, bike, seed = 1}) {
  const b = bounds(panel.poly), pw = Math.ceil(b.w), ph = Math.ceil(b.h);
  const world = WORLDS[moment.world] || WORLDS.neon, kind = moment.kind;
  const L = panelLayout(pw, ph, kind);
  const off = document.createElement('canvas'); off.width = pw; off.height = ph;
  const g = off.getContext('2d');
  painter.paint(g, pw, ph, L, world.key, {x: (moment.distanceM || 0) * 9 + seed * 137, t: moment.t, speed: moment.speedKmh, accel: moment.accelMs2, eq: null, misprint: true, particles: .8,
    focus: kind === 'launch' || kind === 'finish' ? .9 : 0, focusX: pw * .5, focusY: L.bike.ground - L.bike.lengthPx * .25});
  if (kind !== 'launch' && kind !== 'finish') {
    const lines = staticLines(pw, ph, ph * .05, L.roadTop + (ph - L.roadTop) * .6, moment.speedKmh, seed);
    g.save(); g.fillStyle = world.line; g.globalAlpha = .6; g.beginPath();
    for (const l of lines) { g.moveTo(l.x, l.y); g.lineTo(l.x + l.len, l.y - l.w); g.lineTo(l.x + l.len, l.y + l.w * .6); g.closePath(); }
    g.fill(); g.restore();
  }
  const pose = POSE[kind] || POSE.cruise;
  const m = bikeMapping(L);
  const sprite = bike.snapshot(pw, ph, L, pose);
  // 轮速圈与特效需要锚点：按同一映射计算（GLB 与矢量车坐标一致）。
  const anchor = name => {
    const p = {rearAxle: [.335, -.669], frontAxle: [.301, .749], exhaust: [.6, -.98], rearContact: [0, -.669], frontContact: [0, .749]}[name];
    const c = Math.cos(pose.pitch), s = Math.sin(pose.pitch), pz = pose.pitch < 0 ? -.669 : .749;
    const y = p[0] * c - p[1] * s + pz * s, z = (p[0] * s + p[1] * c + pz - pz * c) * Math.cos(pose.yaw);
    return {x: m.sx(z), y: m.sy(y)};
  };
  drawContactShadow(g, anchor('rearContact'), anchor('frontContact'), L.bike.ground, m.ppu, world.ink);
  if (kind === 'launch') for (let i = 0; i < 5; i++) { const p = anchor('rearContact'); drawSmoke(g, p.x - i * m.ppu * .32, p.y - m.ppu * (.12 + i * .05), m.ppu * (.22 + i * .06), {seed: seed + i, ink: world.ink}); }
  g.drawImage(sprite, 0, 0);
  if (kind === 'top' || kind === 'accel' || kind === 'cruise') for (const n of ['rearAxle', 'frontAxle']) { const p = anchor(n); drawWheelArcs(g, p.x, p.y, m.ppu * .33, Math.min(1, moment.speedKmh / 70), '#ffffff'); }
  if (kind === 'accel') { const p = anchor('exhaust'); drawFlame(g, p.x, p.y, m.ppu * .55, {angle: Math.PI * .97, seed, ink: world.ink}); }
  if (kind === 'brake') { const p = anchor('frontContact'); drawSparks(g, p.x, p.y, m.ppu * .6, {angle: Math.PI * .92, spread: 1, count: 18, seed, color: world.y, ink: world.ink}); }
  if (kind === 'corner') { g.save(); g.globalAlpha = .75; g.fillStyle = world.ink; const p = anchor('rearContact'); g.fillRect(0, p.y - 3, p.x, 6); g.restore(); }
  // 速度突破：把当时那一幕剧场定格画进这一格（剧目与阈值来自骑行记录）
  if (kind === 'milestone' && moment.plan) {
    const pointAt = name => {
      const q = BIKE_POINTS[name] || BIKE_POINTS.tank, c = Math.cos(pose.pitch), s = Math.sin(pose.pitch), pz = pose.pitch < 0 ? -.669 : .749;
      const y = q[1] * c - q[2] * s + pz * s, z = (q[1] * s + q[2] * c + pz - pz * c) * Math.cos(pose.yaw);
      return {x: m.sx(z), y: m.sy(y)};
    };
    const plan = {...moment.plan, world: moment.world || moment.plan.world, preview: false};
    const env = buildEnv(plan, {W: pw, H: ph, L, point: pointAt, speedRect: {x: pw + 80, y: -400, w: 1, h: 1}, particles: .8, seed: 7});
    drawPlan(g, plan, plan.tier >= 4 ? .5 : .56, env, {skip: ['label'], camera: false});
  }
  // 贴进格子
  ctx.save();
  tracePath(ctx, panel.poly); ctx.clip();
  if (kind === 'corner') { ctx.translate(b.x + b.w / 2, b.y + b.h / 2); ctx.rotate(-.08); ctx.scale(1.12, 1.12); ctx.translate(-(b.x + b.w / 2), -(b.y + b.h / 2)); }
  ctx.drawImage(off, b.x, b.y);
  ctx.restore();
  return {b, world};
}

// 多边形在某一水平线上的左右边界（斜切格里的文字要躲开斜边）。
export function polyRange(poly, y) {
  let l = Infinity, r = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    if ((y1 <= y && y2 >= y) || (y2 <= y && y1 >= y)) { const x = y1 === y2 ? Math.min(x1, x2) : x1 + (x2 - x1) * (y - y1) / (y2 - y1); const xx = y1 === y2 ? Math.max(x1, x2) : x; l = Math.min(l, x); r = Math.max(r, xx); }
  }
  return {l, r};
}
function caption(ctx, b, cap, world, scale = 1, poly = null) {
  // 旁白框：黄底墨框，左上角；DEMO 角标。
  const pad = 12 * scale, fs = 26 * scale, small = 22 * scale;
  ctx.save();
  ctx.font = `${fs}px MotuoHan, sans-serif`;
  const head = `${cap.time} · ${cap.title}`;
  ctx.font = `${small}px MotuoNum, MotuoHan, sans-serif`;
  const widths = cap.lines.map(l => ctx.measureText(l).width);
  ctx.font = `${fs}px MotuoHan, sans-serif`;
  const w = Math.min(b.w * .62, Math.max(ctx.measureText(head).width, ...widths) + pad * 2), h = pad * 2 + fs + cap.lines.length * (small + 6);
  let y = b.y + 18 * scale;
  if (poly) { const top = Math.max(...poly.map(p => p[1]).filter(v => v < b.y + b.h / 2)); y = Math.max(y, top + 16 * scale); }
  const x = poly ? Math.max(polyRange(poly, y).l, polyRange(poly, y + h + 30 * scale).l) + 16 * scale : b.x + 18 * scale;
  ctx.fillStyle = world.ink; ctx.fillRect(x + 6, y + 6, w, h);
  ctx.fillStyle = '#ffe45c'; ctx.fillRect(x, y, w, h);
  ctx.lineWidth = 4; ctx.strokeStyle = world.ink; ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = world.ink; ctx.textBaseline = 'top';
  ctx.fillText(head, x + pad, y + pad, w - pad * 2);
  ctx.font = `${small}px MotuoNum, MotuoHan, sans-serif`;
  // “²” 不在字库子集内：手动画成上标 2。
  cap.lines.forEach((l, i) => {
    const ly = y + pad + fs + 6 + i * (small + 6), sup = l.endsWith('²'), body = sup ? l.slice(0, -1) : l;
    ctx.font = `${small}px MotuoNum, MotuoHan, sans-serif`; ctx.fillText(body, x + pad, ly, w - pad * 2);
    if (sup) { const bw = Math.min(ctx.measureText(body).width, w - pad * 2); ctx.font = `${Math.round(small * .6)}px MotuoNum, sans-serif`; ctx.fillText('2', x + pad + bw + 1, ly - small * .12); }
  });
  // 角标
  ctx.font = `${16 * scale}px MotuoHan, sans-serif`;
  const bw = ctx.measureText(cap.badge).width + 16;
  ctx.fillStyle = world.ink; ctx.fillRect(x, y + h + 6, bw, 24 * scale);
  ctx.fillStyle = '#fff'; ctx.fillText(cap.badge, x + 8, y + h + 10, bw);
  ctx.restore();
}

/* 画整页到 canvas（默认竖版 PAGE；横屏屏显传 PAGE_LANDSCAPE）。返回各格多边形，供逐格揭示动画使用。 */
export function renderComicPage(canvas, {record, moments, painter, bike, date = new Date(), page = PAGE}) {
  const PAGE_ = page, hk = page.header / PAGE.header; // 页眉按页眉高度等比缩放
  const layout = pageLayout(moments.length, page);
  canvas.width = PAGE_.W; canvas.height = PAGE_.H;
  const ctx = canvas.getContext('2d');
  // 纸
  ctx.fillStyle = '#f3ead6'; ctx.fillRect(0, 0, PAGE_.W, PAGE_.H);
  const r = rng(42); ctx.fillStyle = 'rgba(80,60,30,.06)';
  for (let i = 0; i < 2400; i++) ctx.fillRect(r() * PAGE_.W, r() * PAGE_.H, 1 + r() * 2, 1 + r() * 2);
  // 页眉
  const ink = '#0b0a12';
  ctx.fillStyle = ink; ctx.fillRect(PAGE_.margin, 40 * hk, PAGE_.W - PAGE_.margin * 2, 118 * hk);
  ctx.globalAlpha = .35; halftone(ctx, PAGE_.margin, 40 * hk, PAGE_.W - PAGE_.margin * 2, 118 * hk, '#ff3da6', 9, x => Math.min(1, (x - PAGE_.margin) / (PAGE_.W * 1.1))); ctx.globalAlpha = 1;
  drawTextStamp(ctx, 'MOTUO', PAGE_.margin + 134 * hk, 98 * hk, 70 * hk, {fill: '#ffe45c', shadow: '#38f0ff', ink, rotate: -.05});
  ctx.save(); ctx.fillStyle = '#ffffff'; ctx.font = `${Math.round(50 * hk)}px MotuoHan, sans-serif`; ctx.textBaseline = 'middle'; ctx.fillText('今日骑行漫画', PAGE_.margin + 290 * hk, 86 * hk); ctx.restore();
  const worldsUsed = [...new Set(moments.map(m => m.world))].map(k => (WORLDS[k] || WORLDS.neon));
  ctx.save(); ctx.fillStyle = '#ffe45c'; ctx.font = `${Math.round(22 * Math.max(hk, .8))}px MotuoHan, sans-serif`; ctx.textBaseline = 'middle';
  const p = v => String(v).padStart(2, '0');
  ctx.fillText(`${date.getFullYear()}.${p(date.getMonth() + 1)}.${p(date.getDate())} · ${worldsUsed.map(w => `${w.chapter} ${w.name}`).join(' → ')}`, PAGE_.margin + 292 * hk, 132 * hk, PAGE_.W - PAGE_.margin * 2 - 310 * hk);
  ctx.restore();
  // 各格
  const panels = [];
  moments.forEach((m, i) => {
    const panel = layout.panels[i]; if (!panel) return;
    const {b, world} = drawPanel(ctx, panel, m, {painter, bike, seed: i * 31 + 7});
    const cap = captionFor(m);
    const rowAt = fy => { const r = polyRange(panel.poly, b.y + b.h * fy); return {l: r.l + 20, r: r.r - 20, w: r.r - r.l - 40}; };
    if (cap.big) {
      ctx.save(); tracePath(ctx, panel.poly); ctx.clip();
      const rr = rowAt(.34), size = Math.min(b.h * .44, rr.w * .3);
      drawTextStamp(ctx, cap.big, rr.r - size * .75, b.y + b.h * .34, size, {font: 'MotuoNum, sans-serif', fill: '#ff4840', shadow: '#38f0ff', ink: world.ink, rotate: -.1});
      drawTextStamp(ctx, 'KM/H', rr.r - size * .7, b.y + b.h * .34 + size * .58, Math.min(b.h * .1, 30), {fill: '#ffffff', shadow: world.m, ink: world.ink, rotate: -.1});
      ctx.restore();
    }
    ctx.save(); tracePath(ctx, panel.poly); ctx.clip();
    const fyS = cap.big ? .84 : .26, rs = rowAt(fyS), sfxSize = Math.min(b.h * .24, rs.w * .19, 92);
    const sfxX = cap.big ? rs.l + rs.w * .32 : rs.r - rs.w * .3;
    drawTextStamp(ctx, cap.sfx, sfxX, b.y + b.h * fyS, sfxSize, {fill: world.y, shadow: world.m, ink: world.ink, rotate: i % 2 ? .1 : -.12, maxWidth: rs.w * .56, font: /[一-鿿]/.test(cap.sfx) ? 'MotuoHan, sans-serif' : 'MotuoDisplay, sans-serif'});
    caption(ctx, b, cap, world, b.w < 500 ? .85 : 1, panel.poly);
    ctx.restore();
    tracePath(ctx, panel.poly); ctx.lineWidth = 7; ctx.strokeStyle = ink; ctx.stroke();
    panels.push({poly: panel.poly, kind: m.kind, caption: cap});
  });
  // 读数太少、格数不足 4 时：空出的格画成“下回待续”，不留白框、不写任何数字。
  for (const panel of layout.panels.slice(moments.length)) {
    const b = bounds(panel.poly);
    ctx.save(); tracePath(ctx, panel.poly); ctx.clip();
    ctx.fillStyle = '#e8dcc0'; ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = 'rgba(11,10,18,.18)'; ctx.lineWidth = 3;
    for (let x = b.x - b.h; x < b.x + b.w; x += 22) { ctx.beginPath(); ctx.moveTo(x, b.y + b.h); ctx.lineTo(x + b.h, b.y); ctx.stroke(); }
    ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(Math.min(b.h * .22, 56))}px MotuoHan, sans-serif`; ctx.fillText('下回待续…', b.x + b.w / 2, b.y + b.h / 2);
    ctx.restore();
    tracePath(ctx, panel.poly); ctx.lineWidth = 7; ctx.strokeStyle = ink; ctx.stroke();
  }
  // 页脚
  const sum = pageSummary(record);
  const landscapePage = !!page.landscape, fk = landscapePage ? .78 : 1;
  const fy = PAGE_.H - PAGE_.footer + (landscapePage ? 14 : 30), textW = PAGE_.W - PAGE_.margin * 2 - 230 * fk;
  ctx.save(); ctx.fillStyle = ink; ctx.textBaseline = 'top';
  if (landscapePage) {
    // 横版：时长/里程/最高速与游戏分同一行，来源一行
    ctx.font = '26px MotuoHan, sans-serif'; ctx.fillText(`${sum.line} · ${sum.score}`, PAGE_.margin, fy, textW);
    ctx.fillStyle = '#6a5a44'; ctx.font = '17px MotuoHan, sans-serif'; ctx.fillText(`${sum.source} · 本页数值均来自本次记录`, PAGE_.margin, fy + 38, textW);
  } else {
    ctx.font = '30px MotuoHan, sans-serif'; ctx.fillText(sum.line, PAGE_.margin, fy, textW);
    ctx.font = '22px MotuoHan, sans-serif'; ctx.fillText(sum.score, PAGE_.margin, fy + 44, textW);
    ctx.fillStyle = '#6a5a44'; ctx.font = '18px MotuoHan, sans-serif'; ctx.fillText(`${sum.source} · 本页数值均来自本次记录`, PAGE_.margin, fy + 80, textW);
  }
  ctx.restore();
  // 结尾箭头
  ctx.save(); ctx.translate(PAGE_.W - PAGE_.margin - 200 * fk, fy + 18 * fk); ctx.scale(fk, fk);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(160, 0); ctx.lineTo(160, -16); ctx.lineTo(200, 26); ctx.lineTo(160, 68); ctx.lineTo(160, 52); ctx.lineTo(0, 52); ctx.closePath();
  ctx.fillStyle = '#7a5c2e'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = ink; ctx.stroke();
  ctx.fillStyle = '#fff3d0'; ctx.font = '24px MotuoDisplay, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText('FIN.', 22, 27); ctx.font = '20px MotuoHan, sans-serif'; ctx.fillText('下一话', 80, 27);
  ctx.restore();
  return {layout, panels, summary: sum};
}

export function exportComic(canvas, {date = new Date(), toBlob = true} = {}) {
  const filename = comicFilename(date);
  return new Promise((resolve, reject) => {
    if (toBlob && typeof canvas.toBlob === 'function') {
      canvas.toBlob(blob => (blob ? resolve({blob, filename, type: blob.type || 'image/png'}) : reject(new Error('PNG 编码失败'))), 'image/png');
    } else {
      const url = canvas.toDataURL('image/png');
      if (!url.startsWith('data:image/png')) reject(new Error('PNG 编码失败')); else resolve({dataURL: url, filename, type: 'image/png'});
    }
  });
}

// 触发下载（浏览器）。保留在这里以便 node 测试注入 doc。
export async function downloadComic(canvas, doc = document, opts) {
  const out = await exportComic(canvas, opts);
  const url = out.blob ? URL.createObjectURL(out.blob) : out.dataURL;
  const a = doc.createElement('a'); a.href = url; a.download = out.filename; a.rel = 'noopener';
  doc.body.appendChild(a); a.click(); a.remove();
  if (out.blob) setTimeout(() => URL.revokeObjectURL(url), 4000);
  return out;
}

export {MOMENT_COPY};
