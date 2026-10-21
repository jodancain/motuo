/* 世界画师（Canvas 2D）：天空 → 远景 → 中景楼群（声浪均衡器）→ 近景护栏/隧道 → 路面 → 天气 → 速度线/集中线。
 * 远景与楼群做成带青/品红套印残影的精灵图，按世界 + 尺寸缓存；每帧只做 drawImage 与少量几何。
 * 同一个 paintWorld() 既画实时场景，也给漫画页每一格重绘当时的场景。
 */
import {WORLDS} from './worlds.js';
import {rng} from '../core/geometry.js';

const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
const mod = (a, n) => ((a % n) + n) % n;
const luminance = hex => { const n = parseInt(hex.slice(1), 16); return (.2126 * (n >> 16 & 255) + .7152 * (n >> 8 & 255) + .0722 * (n & 255)) / 255; };
export const isDark = world => luminance(world.sky[1]) < .35;

function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h))) : Object.assign(document.createElement('canvas'), {width: Math.max(1, Math.ceil(w)), height: Math.max(1, Math.ceil(h))});
  return c;
}

// 网点：在 (x,y,w,h) 区域内按 strength(px,py)∈[0,1] 画 45° 网格圆点。
export function halftone(ctx, x, y, w, h, color, cell, strength) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let j = -1, row = 0; j * cell < h + cell; j++, row++) {
    const off = row % 2 ? cell / 2 : 0;
    for (let i = -1; i * cell < w + cell; i++) {
      const px = x + i * cell + off, py = y + j * cell;
      const s = strength(px, py);
      if (s <= .02) continue;
      const r = cell * .5 * Math.min(1.05, s);
      ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, TAU);
    }
  }
  ctx.fill();
}

/* ---------- 缓存层 ---------- */
function buildSky(world, W, H, L) {
  const c = makeCanvas(W, L.roadTop + 2), g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, L.roadTop);
  // 分段平涂 + 网点过渡，不是写实渐变。
  grad.addColorStop(0, world.sky[0]); grad.addColorStop(.42, world.sky[0]);
  grad.addColorStop(.42, world.sky[1]); grad.addColorStop(.72, world.sky[1]);
  grad.addColorStop(.72, world.sky[2]); grad.addColorStop(1, world.sky[2]);
  g.fillStyle = grad; g.fillRect(0, 0, W, L.roadTop + 2);
  const cell = Math.max(6, Math.round(Math.min(W, H) * .022));
  const b1 = L.roadTop * .42, b2 = L.roadTop * .72;
  g.globalAlpha = .55;
  halftone(g, 0, b1 - cell * 4, W, cell * 8, world.sky[1], cell, (x, y) => clamp((b1 - y) / (cell * 4) * .5 + .5) * clamp(1 - (b1 - y) / (cell * 4)));
  halftone(g, 0, b2 - cell * 4, W, cell * 8, world.sky[2], cell, (x, y) => clamp(1 - Math.abs(y - b2) / (cell * 4)));
  g.globalAlpha = .38;
  halftone(g, 0, L.horizon - cell * 10, W, cell * 12, world.band, cell, (x, y) => clamp((y - (L.horizon - cell * 10)) / (cell * 12)));
  g.globalAlpha = 1;
  // 星星
  if (world.stars) {
    const r = rng(7);
    g.fillStyle = '#fff';
    for (let i = 0; i < 90 * world.stars; i++) {
      const x = r() * W, y = r() * L.horizon * .9, s = r() < .1 ? 2.2 : r() * 1.2 + .4;
      if (s > 2) { g.save(); g.translate(x, y); g.fillRect(-s * 2, -.6, s * 4, 1.2); g.fillRect(-.6, -s * 2, 1.2, s * 4); g.restore(); }
      else g.fillRect(x, y, s, s);
    }
  }
  drawCelestial(g, world, W, H, L);
  return c;
}

function drawCelestial(g, world, W, H) {
  const k = world.celestial, R = k.r * Math.min(W, H) * (W < H ? 1.1 : 1);
  const x = k.x * W, y = k.y * H;
  g.save();
  if (k.kind === 'planet') {
    // 环：先画后半环
    g.strokeStyle = world.ink; g.lineWidth = Math.max(3, R * .09);
    g.beginPath(); g.ellipse(x, y, R * 1.7, R * .42, -.32, Math.PI, TAU); g.stroke();
    g.strokeStyle = world.c; g.lineWidth = Math.max(2, R * .05);
    g.beginPath(); g.ellipse(x, y, R * 1.7, R * .42, -.32, Math.PI, TAU); g.stroke();
  }
  g.beginPath(); g.arc(x, y, R, 0, TAU); g.fillStyle = k.fill; g.fill();
  g.save(); g.clip();
  const cell = Math.max(5, R * .14);
  halftone(g, x - R, y - R, R * 2, R * 2, k.shade, cell, (px, py) => clamp(((px - x) * .7 + (py - y) * .7) / R * .9 + .15));
  if (k.kind === 'sun' && world.key === 'sunset') {
    // 复古落日条纹
    g.fillStyle = world.sky[2];
    for (let i = 0; i < 6; i++) { const yy = y + R * (.12 + i * .15), hh = R * (.03 + i * .018); g.fillRect(x - R, yy, R * 2, hh); }
  }
  g.restore();
  g.lineWidth = Math.max(2.5, R * .05); g.strokeStyle = world.ink; g.beginPath(); g.arc(x, y, R, 0, TAU); g.stroke();
  if (k.kind === 'planet') {
    g.strokeStyle = world.ink; g.lineWidth = Math.max(3, R * .09);
    g.beginPath(); g.ellipse(x, y, R * 1.7, R * .42, -.32, 0, Math.PI); g.stroke();
    g.strokeStyle = world.c; g.lineWidth = Math.max(2, R * .05);
    g.beginPath(); g.ellipse(x, y, R * 1.7, R * .42, -.32, 0, Math.PI); g.stroke();
  }
  if (k.kind === 'moon') { g.fillStyle = k.shade; g.globalAlpha = .5; for (const [dx, dy, rr] of [[-.3, -.2, .16], [.25, .3, .12], [.1, -.45, .08]]) { g.beginPath(); g.arc(x + dx * R, y + dy * R, rr * R, 0, TAU); g.fill(); } }
  g.restore();
}

// 带套印残影的剪影：先画青、品红偏移，再画墨色主体。
function misprinted(g, draw, world, misprint, off) {
  if (misprint) {
    g.save(); g.globalAlpha = .55; g.translate(-off, 0); draw(world.c); g.restore();
    g.save(); g.globalAlpha = .45; g.translate(off, off * .5); draw(world.m); g.restore();
  }
  draw(null);
}

function buildFar(world, W, H, L, misprint) {
  const tileW = Math.ceil(Math.max(W, H) * 1.6), top = L.roadTop * world.far.top, base = L.roadTop;
  const c = makeCanvas(tileW, base + 4), g = c.getContext('2d');
  const r = rng(world.key.length * 97 + 3), f = world.far, off = Math.max(2, Math.round(Math.min(W, H) * .006));
  const path = [];
  if (f.kind === 'city') {
    let x = 0; path.push([0, base]);
    while (x < tileW) {
      const w = 18 + r() * 46, h = top + r() * (L.horizon - top) * .9;
      path.push([x, h]); path.push([x + w, h]);
      if (r() < .25) { path.push([x + w * .5 - 1, h]); path.push([x + w * .5 - 1, h - 22 - r() * 30]); path.push([x + w * .5 + 1, h - 22 - r() * 30]); path.push([x + w * .5 + 1, h]); }
      x += w;
    }
    path.push([tileW, path[path.length - 1][1]]); path.push([tileW, base]);
  } else if (f.kind === 'mountain') {
    path.push([0, base]);
    const peaks = 5; let x = 0;
    path.push([0, L.horizon * .9]);
    for (let i = 0; i < peaks; i++) {
      const w = tileW / peaks, ph = top + r() * (L.horizon - top) * .5;
      path.push([x + w * .5, ph]); path.push([x + w * .72, ph + (L.horizon - ph) * .35]); path.push([x + w, L.horizon * .9]);
      x += w;
    }
    path.push([tileW, base]);
  } else if (f.kind === 'sea') {
    path.push([0, base]); path.push([0, L.horizon - 30]);
    for (let x = 0; x <= tileW; x += tileW / 3) { path.push([x + tileW / 9, L.horizon - 52 - r() * 30]); path.push([x + tileW / 5, L.horizon - 8]); }
    path.push([tileW, L.horizon - 30]); path.push([tileW, base]);
  } else {
    // 小行星带：零散岩块
    for (let i = 0; i < 9; i++) {
      const cx = r() * tileW, cy = top + r() * (L.horizon - top), rr = 10 + r() * 26;
      path.push(null, ...Array.from({length: 7}, (_, k) => [cx + Math.cos(k / 7 * TAU) * rr * (.7 + r() * .5), cy + Math.sin(k / 7 * TAU) * rr * (.6 + r() * .4)]));
    }
  }
  const draw = color => {
    g.beginPath();
    let move = true;
    for (const p of path) { if (!p) { move = true; continue; } if (move) { g.moveTo(p[0], p[1]); move = false; } else g.lineTo(p[0], p[1]); }
    g.closePath();
    g.fillStyle = color || f.fill; g.fill();
    if (!color) { g.lineWidth = 2.5; g.strokeStyle = world.ink; g.stroke(); }
  };
  misprinted(g, draw, world, misprint, off);
  if (f.kind === 'mountain') {
    // 雪冠
    g.fillStyle = f.cap;
    const r2 = rng(11);
    for (let i = 0; i < 5; i++) { const w = tileW / 5, x = i * w + w * .5, ph = path[2 + i * 3]?.[1] ?? top; g.beginPath(); g.moveTo(x, ph); g.lineTo(x + w * .12, ph + 26 + r2() * 10); g.lineTo(x + w * .02, ph + 20); g.lineTo(x - w * .1, ph + 30); g.closePath(); g.fill(); g.lineWidth = 2; g.strokeStyle = world.ink; g.stroke(); }
  }
  if (f.kind === 'sea') {
    g.fillStyle = f.fill; g.fillRect(0, L.horizon - 8, tileW, base - L.horizon + 12);
    g.fillStyle = world.ink; g.fillRect(0, L.horizon - 9, tileW, 2.5);
    const r3 = rng(5); g.fillStyle = '#fff3b0';
    for (let i = 0; i < 70; i++) g.fillRect(r3() * tileW, L.horizon + r3() * (base - L.horizon - 10), 6 + r3() * 18, 2);
  }
  return {canvas: c, w: tileW};
}

function buildMid(world, W, H, L, misprint) {
  const r = rng(world.key.length * 131 + 17), m = world.mid;
  const unit = Math.max(W, H) / 844, skyH = L.roadTop, base = L.roadTop - Math.round(10 * unit);
  const off = Math.max(2, Math.round(Math.min(W, H) * .006));
  const tileW = Math.ceil(Math.max(W * 2.2, 1400 * unit));
  const items = [];
  let x = 0, i = 0;
  while (x < tileW - 40 * unit) {
    const w = Math.round((38 + r() * 64) * unit), h = Math.round(skyH * (W < H ? .22 + r() * .32 : .24 + r() * .4));
    const pad = off * 2 + 6, c = makeCanvas(w + pad * 2, h + pad + 30 * unit), g = c.getContext('2d');
    const body = m.body[i % m.body.length], ox = pad, oy = pad + 30 * unit;
    const roofH = m.roof === 'peak' ? Math.min(w * .5, 26 * unit) : m.roof === 'spire' ? 30 * unit : 0;
    const shape = color => {
      g.beginPath();
      if (m.roof === 'peak') { g.moveTo(ox, oy + h); g.lineTo(ox, oy + roofH); g.lineTo(ox + w / 2, oy); g.lineTo(ox + w, oy + roofH); g.lineTo(ox + w, oy + h); }
      else if (m.roof === 'spire') { g.moveTo(ox, oy + h); g.lineTo(ox + w * .1, oy + roofH); g.lineTo(ox + w / 2, oy - 4 * unit); g.lineTo(ox + w * .9, oy + roofH); g.lineTo(ox + w, oy + h); }
      else { g.moveTo(ox, oy + h); g.lineTo(ox, oy); g.lineTo(ox + w, oy); g.lineTo(ox + w, oy + h); }
      g.closePath(); g.fillStyle = color || body; g.fill();
      if (!color) { g.lineWidth = 2.6; g.strokeStyle = world.ink; g.stroke(); }
    };
    misprinted(g, shape, world, misprint, off);
    // 暗面网点
    g.save(); shape('rgba(0,0,0,0)'); g.clip();
    g.globalAlpha = .5; halftone(g, ox + w * .62, oy, w * .4, h, world.ink, Math.max(4, 5 * unit), (px) => clamp((px - ox - w * .6) / (w * .4)));
    g.restore();
    // 窗：均衡器读数的“电平格”
    const cols = Math.max(2, Math.floor(w / (13 * unit))), rows = Math.max(3, Math.floor((h - roofH) / (15 * unit)));
    const cw = w / cols, ch = (h - roofH - 8 * unit) / rows;
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      if (r() < .42) continue;
      g.fillStyle = m.window[(cx + cy + i) % m.window.length];
      g.fillRect(ox + cx * cw + cw * .25, oy + roofH + 6 * unit + cy * ch + ch * .25, cw * .5, ch * .45);
    }
    // 招牌
    let sign = null;
    if (m.signs?.length && r() < .34 && w > 44 * unit) {
      sign = m.signs[Math.floor(r() * m.signs.length)];
      const sw = w * .78, sh = 22 * unit, sx = ox + (w - sw) / 2, sy = oy + roofH + h * .12;
      const glow = world.accent;
      g.save(); g.shadowColor = glow; g.shadowBlur = 12 * unit;
      g.fillStyle = world.ink; g.fillRect(sx, sy, sw, sh);
      g.strokeStyle = glow; g.lineWidth = 2.2; g.strokeRect(sx + 2, sy + 2, sw - 4, sh - 4);
      g.fillStyle = i % 2 ? world.c : world.y;
      g.font = `${Math.round(sh * .7)}px MotuoDisplay, MotuoHan, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(sign, sx + sw / 2, sy + sh / 2 + 1, sw - 6);
      g.restore();
    }
    items.push({canvas: c, x, w, h, pad, top: oy, band: i % 16});
    // 雪山世界：楼间插松树
    x += w + Math.round((m.kind === 'pines' || m.kind === 'coast' ? 14 + r() * 30 : 2 + r() * 10) * unit);
    i++;
  }
  // 树（松树 / 棕榈）作为装饰，不参与均衡器。
  const trees = [];
  if (m.kind === 'pines' || m.kind === 'coast') {
    for (let t = 0; t < 14; t++) trees.push({x: r() * tileW, s: (.7 + r() * .6) * unit});
  }
  return {items, tileW, base, trees};
}

/* ---------- 每帧绘制 ---------- */
function drawTree(ctx, world, kind, x, base, s) {
  ctx.save(); ctx.translate(x, base);
  ctx.lineWidth = 2.4; ctx.strokeStyle = world.ink;
  if (kind === 'pines') {
    ctx.fillStyle = '#1f3a4f';
    for (let k = 0; k < 3; k++) { const y = -18 * s - k * 22 * s, w = (34 - k * 8) * s; ctx.beginPath(); ctx.moveTo(-w, y + 16 * s); ctx.lineTo(0, y - 18 * s); ctx.lineTo(w, y + 16 * s); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(-w * .4, y - 4 * s); ctx.lineTo(0, y - 18 * s); ctx.lineTo(w * .4, y - 4 * s); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#1f3a4f'; }
  } else {
    ctx.fillStyle = '#5a1f45';
    ctx.beginPath(); ctx.moveTo(-3 * s, 0); ctx.quadraticCurveTo(4 * s, -50 * s, 10 * s, -96 * s); ctx.lineTo(16 * s, -96 * s); ctx.quadraticCurveTo(10 * s, -50 * s, 4 * s, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#3d1735';
    for (let k = 0; k < 6; k++) { const a = -Math.PI / 2 + (k - 2.5) * .55; ctx.beginPath(); ctx.moveTo(13 * s, -96 * s); ctx.quadraticCurveTo(13 * s + Math.cos(a) * 30 * s, -96 * s + Math.sin(a) * 30 * s - 12 * s, 13 * s + Math.cos(a) * 52 * s, -96 * s + Math.sin(a) * 40 * s + 10 * s); ctx.lineTo(13 * s + Math.cos(a) * 20 * s, -92 * s); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  }
  ctx.restore();
}

function drawNear(ctx, world, W, H, L, x, t) {
  const n = world.near, unit = Math.max(W, H) / 844, top = L.roadTop;
  if (n.kind === 'tunnel') {
    // 隧道：周期出现，内部遮住天空与楼群，顶灯掠过。
    const P = W * 2.8, T = W * 1.25;
    for (let k = Math.floor((x - T) / P); k <= Math.floor((x + W) / P); k++) {
      const sx = k * P + W * .9 - x;
      if (sx > W || sx + T < 0) continue;
      ctx.fillStyle = '#121828'; ctx.fillRect(sx, 0, T, top);
      ctx.fillStyle = '#1b2338'; ctx.fillRect(sx, top * .55, T, top * .45);
      // 顶灯
      ctx.fillStyle = n.lamp;
      for (let lx = mod(-x * 1.0, 90 * unit); lx < T; lx += 90 * unit) { const px = sx + lx; if (px < sx || px > sx + T) continue; ctx.globalAlpha = .9; ctx.fillRect(px, top * .16, 30 * unit, 7 * unit); ctx.globalAlpha = .13; ctx.beginPath(); ctx.moveTo(px - 30 * unit, top); ctx.lineTo(px, top * .18); ctx.lineTo(px + 30 * unit, top * .18); ctx.lineTo(px + 60 * unit, top); ctx.fill(); }
      ctx.globalAlpha = 1;
      // 洞口
      for (const ex of [sx, sx + T]) {
        ctx.fillStyle = n.rail; ctx.strokeStyle = world.ink; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.rect(ex - 22 * unit, 0, 44 * unit, top); ctx.fill(); ctx.stroke();
        ctx.globalAlpha = .4; halftone(ctx, ex - 22 * unit, 0, 44 * unit, top, world.ink, 6 * unit, () => .55); ctx.globalAlpha = 1;
      }
    }
  }
  if (n.kind === 'rail' || n.kind === 'tunnel') {
    // 路灯
    const lampGap = 560 * unit;
    for (let lx = mod(-x, lampGap) - lampGap; lx < W + lampGap; lx += lampGap) {
      const h = top * .55;
      ctx.fillStyle = world.ink; ctx.fillRect(lx, top - h, 5 * unit, h);
      ctx.fillRect(lx, top - h, 44 * unit, 5 * unit);
      ctx.fillStyle = n.lamp; ctx.fillRect(lx + 30 * unit, top - h + 4 * unit, 16 * unit, 6 * unit);
      ctx.globalAlpha = .12; ctx.beginPath(); ctx.moveTo(lx + 30 * unit, top - h + 10 * unit); ctx.lineTo(lx - 30 * unit, top); ctx.lineTo(lx + 110 * unit, top); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
    }
    // 护栏
    const railY = top - 20 * unit, postGap = 120 * unit;
    ctx.fillStyle = n.post; ctx.strokeStyle = world.ink; ctx.lineWidth = 2.2;
    for (let px = mod(-x, postGap) - postGap; px < W + postGap; px += postGap) { ctx.fillRect(px, railY, 7 * unit, 22 * unit); ctx.strokeRect(px, railY, 7 * unit, 22 * unit); }
    ctx.fillStyle = n.rail; ctx.fillRect(0, railY + 2 * unit, W, 7 * unit);
    ctx.fillStyle = world.ink; ctx.fillRect(0, railY, W, 2.5); ctx.fillRect(0, railY + 9 * unit, W, 2.5);
  } else if (n.kind === 'pylon') {
    const gap = 230 * unit;
    for (let px = mod(-x, gap) - gap; px < W + gap; px += gap) {
      ctx.fillStyle = world.ink; ctx.fillRect(px, top - 60 * unit, 8 * unit, 60 * unit);
      ctx.fillStyle = n.post; ctx.fillRect(px + 2 * unit, top - 58 * unit, 4 * unit, 52 * unit);
      ctx.beginPath(); ctx.arc(px + 4 * unit, top - 64 * unit, 6 * unit, 0, TAU); ctx.fillStyle = n.lamp; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = world.ink; ctx.stroke();
    }
    ctx.fillStyle = n.rail; ctx.fillRect(0, top - 26 * unit, W, 4 * unit);
    ctx.fillStyle = n.post; ctx.fillRect(0, top - 14 * unit, W, 3 * unit);
  }
}

function drawRoad(ctx, world, W, H, L, x, cache) {
  const rd = world.road, top = L.roadTop, unit = Math.max(W, H) / 844;
  ctx.fillStyle = rd.fill; ctx.fillRect(0, top, W, H - top);
  if (cache.roadDots) ctx.drawImage(cache.roadDots, 0, top);
  ctx.fillStyle = world.ink; ctx.fillRect(0, top, W, 4);
  ctx.fillStyle = rd.edge; ctx.fillRect(0, top + 4, W, 3 * unit);
  if (rd.grid) {
    ctx.strokeStyle = rd.edge; ctx.globalAlpha = .45; ctx.lineWidth = 1.5;
    const g = 70 * unit; ctx.beginPath();
    for (let gx = mod(-x, g); gx < W; gx += g) { ctx.moveTo(gx, top + 8); ctx.lineTo(gx - 40 * unit, H); }
    for (let gy = top + 18 * unit; gy < H; gy += 18 * unit) { ctx.moveTo(0, gy); ctx.lineTo(W, gy); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (rd.wet) {
    ctx.globalAlpha = .1;
    for (let k = 0; k < 6; k++) { const px = mod(k * 190 * unit - x * .98, W + 200 * unit) - 100 * unit; ctx.fillStyle = k % 2 ? world.c : world.m; ctx.fillRect(px, top + 10, 16 * unit, (H - top) * .8); }
    ctx.globalAlpha = 1;
  }
  const ly = top + (H - top) * .84, dash = 64 * unit, gap = 54 * unit;
  ctx.fillStyle = rd.lane; ctx.strokeStyle = world.ink; ctx.lineWidth = 2;
  for (let px = mod(-x, dash + gap) - dash - gap; px < W; px += dash + gap) { ctx.beginPath(); ctx.moveTo(px + 8 * unit, ly); ctx.lineTo(px + dash + 8 * unit, ly); ctx.lineTo(px + dash, ly + 6 * unit); ctx.lineTo(px, ly + 6 * unit); ctx.closePath(); ctx.fill(); ctx.stroke(); }
}

function buildRoadDots(world, W, H, L) {
  const h = H - L.roadTop; if (h < 2) return null;
  const c = makeCanvas(W, h), g = c.getContext('2d');
  g.globalAlpha = .3;
  halftone(g, 0, 0, W, h, world.ink, Math.max(5, Math.round(Math.min(W, H) * .018)), (px, py) => clamp(py / h * .9));
  return c;
}

/* 速度线：手绘楔形，向左飞。lines 由调用方持有以保持连续。 */
export function updateSpeedLines(lines, {W, H, top, bottom, dt, speed, accel, particles, seed = Math.random}) {
  const target = Math.round(clamp(speed / 80) * 16 * particles + clamp(Math.abs(accel || 0) / 3) * 10 * particles);
  while (lines.length < target) lines.push({x: W + seed() * W * .5, y: top + seed() * (bottom - top), len: 0, w: 1 + seed() * 3.5, v: .8 + seed() * .9});
  if (lines.length > target) lines.length = target;
  const v = (300 + speed * 22) * (W / 844);
  for (const l of lines) {
    l.len = (40 + speed * 4.5) * (W / 844) * l.v;
    l.x -= v * l.v * dt;
    if (l.x + l.len < 0) { l.x = W + seed() * W * .3; l.y = top + seed() * (bottom - top); }
  }
}
export function drawSpeedLines(ctx, lines, color, alpha = .65) {
  ctx.save(); ctx.fillStyle = color; ctx.globalAlpha = alpha;
  ctx.beginPath();
  for (const l of lines) { ctx.moveTo(l.x, l.y); ctx.lineTo(l.x + l.len, l.y - l.w); ctx.lineTo(l.x + l.len * 1.04, l.y); ctx.lineTo(l.x + l.len, l.y + l.w * .6); ctx.closePath(); }
  ctx.fill(); ctx.restore();
}

/* 集中线：从画外向 (cx,cy) 汇聚的楔形，内圈留空。 */
export function drawFocusLines(ctx, W, H, cx, cy, {color = '#000', count = 64, inner = .3, alpha = .9, seed = 3, jitter = 0} = {}) {
  const r = rng(seed + jitter), R = Math.hypot(W, H), r0 = Math.min(W, H) * inner;
  ctx.save(); ctx.fillStyle = color; ctx.globalAlpha = alpha; ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const a = (i + r() * .6) / count * TAU, w = (.004 + r() * .016) * TAU, start = r0 * (1 + r() * .5);
    ctx.moveTo(cx + Math.cos(a) * start, cy + Math.sin(a) * start);
    ctx.lineTo(cx + Math.cos(a - w) * R, cy + Math.sin(a - w) * R);
    ctx.lineTo(cx + Math.cos(a + w) * R, cy + Math.sin(a + w) * R);
    ctx.closePath();
  }
  ctx.fill(); ctx.restore();
}

function updateWeather(ps, kind, {W, H, top, dt, speed, particles, r}) {
  const counts = {rain: 110, snow: 90, gulls: 5, stars: 50};
  const target = Math.round((counts[kind] || 0) * particles);
  while (ps.length < target) ps.push({x: r() * W, y: r() * H, s: .5 + r(), p: r() * TAU});
  if (ps.length > target) ps.length = target;
  const drift = (speed * 10 + 40) * (W / 844);
  for (const p of ps) {
    if (kind === 'rain') { p.y += (620 + p.s * 300) * dt; p.x -= (drift * 1.3 + 120) * dt; }
    else if (kind === 'snow') { p.y += (40 + p.s * 50) * dt; p.x -= (drift * .9 + Math.sin(p.p += dt * 2) * 30) * dt; }
    else if (kind === 'gulls') { p.x -= (30 + drift * .08) * dt * p.s; p.p += dt * 6; if (p.y > top * .6) p.y = top * (.1 + p.s * .3); }
    else { p.x -= (drift * 2 + 60) * dt * p.s; }
    if (p.y > H) { p.y = -10; p.x = r() * W * 1.3; }
    if (p.x < -60) { p.x = W + r() * 60; p.y = kind === 'gulls' ? top * (.08 + r() * .35) : r() * H; }
  }
}
function drawWeather(ctx, ps, kind, world, speed, W) {
  if (!ps.length) return;
  ctx.save();
  if (kind === 'rain') { ctx.strokeStyle = '#a9f3ff'; ctx.globalAlpha = .5; ctx.lineWidth = 1.3; ctx.beginPath(); for (const p of ps) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 6 + speed * .12, p.y - 16 * p.s); } ctx.stroke(); }
  else if (kind === 'snow') { ctx.fillStyle = '#fff'; ctx.strokeStyle = world.ink; ctx.lineWidth = 1; ctx.beginPath(); for (const p of ps) { const r = 1.6 + p.s * 2.2; ctx.moveTo(p.x + r, p.y); ctx.arc(p.x, p.y, r, 0, TAU); } ctx.fill(); ctx.globalAlpha = .5; ctx.stroke(); }
  else if (kind === 'gulls') { ctx.strokeStyle = world.ink; ctx.lineWidth = 2.4; ctx.beginPath(); for (const p of ps) { const w = 10 * p.s + 6, f = Math.sin(p.p) * 5; ctx.moveTo(p.x - w, p.y - f); ctx.quadraticCurveTo(p.x - w / 2, p.y - 6 - f, p.x, p.y); ctx.quadraticCurveTo(p.x + w / 2, p.y - 6 - f, p.x + w, p.y - f); } ctx.stroke(); }
  else { ctx.strokeStyle = '#fff'; ctx.globalAlpha = .8; ctx.lineWidth = 1.4; ctx.beginPath(); for (const p of ps) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 4 + speed * .9 * p.s * (W / 844), p.y); } ctx.stroke(); }
  ctx.restore();
}

/* ---------- 画师 ---------- */
export function createWorldPainter() {
  const caches = new Map();
  function cacheFor(world, W, H, L, misprint) {
    const key = `${world.key}:${W}x${H}:${misprint ? 1 : 0}`;
    let c = caches.get(key);
    if (!c) {
      if (caches.size > 6) caches.delete(caches.keys().next().value);
      c = {sky: buildSky(world, W, H, L), far: buildFar(world, W, H, L, misprint), mid: buildMid(world, W, H, L, misprint), roadDots: buildRoadDots(world, W, H, L)};
      caches.set(key, c);
    }
    return c;
  }
  /* st: {x 路面滚动像素, t 秒, speed 视觉速度, accel, eq(16)|null, misprint, particles, weather[], lines[], focus, focusX, focusY, dt} */
  function paint(ctx, W, H, L, worldKey, st) {
    const world = WORLDS[worldKey] || WORLDS.neon;
    const c = cacheFor(world, W, H, L, st.misprint);
    ctx.drawImage(c.sky, 0, 0);
    // 远景
    const fx = mod(st.x * .08, c.far.w);
    ctx.drawImage(c.far.canvas, -fx, 0); if (c.far.w - fx < W) ctx.drawImage(c.far.canvas, c.far.w - fx, 0);
    // 中景楼群：有声浪时按频段裁切楼高（像均衡器），无声浪时保持原高度。
    const mid = c.mid, mx = st.x * .32;
    for (const tr of mid.trees) { const px = mod(tr.x - mx * 1.1, mid.tileW) - 60; if (px > -80 && px < W + 80) drawTree(ctx, world, world.mid.kind, px, mid.base + 4, tr.s * (W < H ? 1.3 : 1)); }
    for (const it of mid.items) {
      let px = mod(it.x - mx, mid.tileW);
      if (px > W + 20) px -= mid.tileW;
      if (px + it.w < -20 || px > W + 20) continue;
      const level = st.eq ? clamp(.5 + .55 * st.eq[it.band]) : 1;
      const full = it.canvas.height, visible = it.top + it.h * level;
      const sy = full - visible;
      ctx.drawImage(it.canvas, 0, sy, it.canvas.width, visible, px - it.pad, mid.base - visible + it.pad * 0, it.canvas.width, visible);
    }
    drawNear(ctx, world, W, H, L, st.x, st.t);
    drawRoad(ctx, world, W, H, L, st.x, c);
    if (st.weather) { if (st.dt) updateWeather(st.weather, world.weather, {W, H, top: L.roadTop, dt: st.dt, speed: st.speed, particles: st.particles, r: Math.random}); drawWeather(ctx, st.weather, world.weather, world, st.speed, W); }
    if (st.lines) {
      if (st.dt) updateSpeedLines(st.lines, {W, H, top: H * .06, bottom: L.roadTop + (H - L.roadTop) * .7, dt: st.dt, speed: st.speed, accel: st.accel, particles: st.particles});
      drawSpeedLines(ctx, st.lines, world.line, .55);
    }
    if (st.focus > 0) drawFocusLines(ctx, W, H, st.focusX ?? W * .3, st.focusY ?? L.ground - 60, {color: isDark(world) ? world.paper : world.ink, alpha: .85 * st.focus, jitter: st.focusJitter || 0});
  }
  return {paint, clear() { caches.clear(); }};
}
