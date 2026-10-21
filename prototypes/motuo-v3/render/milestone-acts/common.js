/* 速度突破剧场 · 公共绘制件。所有剧目都是“进度 p → 画面”的纯函数（粒子位置由种子 + p 解析算出），
 * 所以同一段代码能实时播放、在漫画页定格、在减少动态时只画一帧。
 * 四拍：BEAT.setup 起（看清道具）→ conflict 冲突 → climax 爆点（冲击帧 + 拟声）→ after 余韵（碎片/彩纸飘落）。 */
import {rng} from '../../core/geometry.js';
import {halftone} from '../scene.js';
export {rng, halftone};

export const BEAT = Object.freeze({setup: [0, .26], conflict: [.26, .46], climax: [.46, .6], after: [.6, 1]});
export const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
export const seg = (p, a, b) => clamp01((p - a) / (b - a));
export const beat = (p, name) => seg(p, BEAT[name][0], BEAT[name][1]);
export const easeOut = x => 1 - (1 - clamp01(x)) ** 3;
export const easeIn = x => clamp01(x) ** 3;
export const easeInOut = x => { x = clamp01(x); return x < .5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
export const back = x => { x = clamp01(x); const c = 1.9; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
export const lerp = (a, b, t) => a + (b - a) * t;
// 12fps 步进（一拍二）：漫画角色动作的节奏。
export const onTwos = (p, ms = 1600) => Math.floor(p * ms / 83) * 83 / ms;
export const frame3 = (p, rate = 8) => Math.floor(p * rate * 3) % 3; // 2–3 帧循环步进
export const TAU = Math.PI * 2;
export const hasHan = s => /[一-鿿]/.test(s);

/* 漫画字：墨线描边 + 套印残影；放不下时缩字号（不横向压扁）。 */
export function text(ctx, s, x, y, size, {font = null, fill = '#ffe45c', ink = '#0b0a12', ghost = null, rot = 0, align = 'center', stroke = .14, maxWidth = 0, alpha = 1, base = 'middle'} = {}) {
  if (!s || size < 2) return size;
  const f = font || (hasHan(s) ? 'MotuoHan, MotuoDisplay, sans-serif' : 'MotuoDisplay, MotuoHan, sans-serif');
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); ctx.rotate(rot);
  if (hasHan(s)) ctx.scale(1.08, .94);
  ctx.font = `${Math.round(size)}px ${f}`;
  if (maxWidth) { const w = ctx.measureText(s).width; if (w > maxWidth) { size *= maxWidth / w; ctx.font = `${Math.round(size)}px ${f}`; } }
  ctx.textAlign = align; ctx.textBaseline = base; ctx.lineJoin = 'round';
  if (ghost) { ctx.fillStyle = ghost[0]; ctx.fillText(s, -size * .045, size * .02); ctx.fillStyle = ghost[1]; ctx.fillText(s, size * .05, size * .06); }
  if (stroke > 0) { ctx.lineWidth = Math.max(2, size * stroke); ctx.strokeStyle = ink; ctx.strokeText(s, 0, 0); }
  ctx.fillStyle = fill; ctx.fillText(s, 0, 0);
  ctx.restore();
  return size;
}
export const num = (ctx, s, x, y, size, o = {}) => text(ctx, s, x, y, size, {font: 'MotuoNum, MotuoDisplay, sans-serif', ...o});

// 漫画纸片：纸色 + 墨框 + 角落网点
export function paper(ctx, x, y, w, h, world, {fill = world.paper, dots = world.m, lw = 4} = {}) {
  ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.globalAlpha = .35;
  halftone(ctx, x, y, w, h, dots, Math.max(5, w * .03), (px, py) => clamp01(((px - x) / w + (py - y) / h) - 1.1));
  ctx.restore();
  ctx.lineWidth = lw; ctx.strokeStyle = world.ink; ctx.strokeRect(x, y, w, h);
}

// 星形爆炸框（拟声字底）
export function burst(ctx, x, y, r, spikes, fill, ink, seed = 1, rot = 0) {
  const rnd = rng(seed);
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = rot + i / (spikes * 2) * TAU, rr = i % 2 ? r * (.55 + rnd() * .12) : r * (.92 + rnd() * .16);
    i ? ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = Math.max(3, r * .05); ctx.strokeStyle = ink; ctx.stroke();
}

// 粒子数受性能档与等级控制
export const count = (e, base) => Math.max(3, Math.round(base * e.particles * (.75 + e.tier * .12)));

/* 彩纸：从 (x,y) 抛出（或 rain:true 时从顶部飘落），按 p 解析计算位置。 */
export function confetti(ctx, e, x, y, p, {n = 60, spread = 1, colors = null, seed = 7, up = 1, size = 1, rain = false} = {}) {
  const rnd = rng(seed), cols = colors || [e.world.y, e.world.c, e.world.m, '#ffffff'];
  const g = e.H * 1.6, t = p * 1.4;
  for (let i = 0; i < count(e, n); i++) {
    let px, py;
    if (rain) { px = rnd() * e.W + Math.sin(p * 6 + i) * 20; py = -20 + (rnd() * .6 + p * 1.1) * e.H * (.7 + rnd() * .5); }
    else { const a = -Math.PI / 2 + (rnd() - .5) * Math.PI * spread, v = (.35 + rnd() * .65) * e.H * 1.1 * up; px = x + Math.cos(a) * v * t + (rnd() - .5) * 30; py = y + Math.sin(a) * v * t + g * t * t * .5; }
    const s = (5 + rnd() * 8) * size * Math.max(1, e.unit), spin = rnd() * 10;
    ctx.save(); ctx.translate(px, py); ctx.rotate(spin + t * 8 * (rnd() - .5)); ctx.scale(1, Math.abs(Math.cos(t * 9 + spin)) + .1);
    ctx.globalAlpha = 1 - seg(p, .82, 1); ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(-s / 2, -s / 3, s, s * .66);
    ctx.lineWidth = 1; ctx.strokeStyle = e.world.ink; ctx.strokeRect(-s / 2, -s / 3, s, s * .66);
    ctx.restore();
  }
}

export function rings(ctx, x, y, p, {n = 3, maxR = 300, color = '#fff', ink = '#0b0a12', lw = 10, squash = .55} = {}) {
  for (let i = 0; i < n; i++) {
    const q = seg(p, i * .14, .62 + i * .14); if (q <= 0 || q >= 1) continue;
    const r = maxR * easeOut(q);
    ctx.save(); ctx.globalAlpha = 1 - q * .8;
    ctx.lineWidth = lw * (1 - q) + 3; ctx.strokeStyle = ink; ctx.beginPath(); ctx.ellipse(x, y, r, r * squash, 0, 0, TAU); ctx.stroke();
    ctx.lineWidth = lw * (1 - q) * .55 + 1.5; ctx.strokeStyle = color; ctx.stroke();
    ctx.restore();
  }
}

export function speedLinesLocal(ctx, rect, p, {n = 14, color = '#fff', seed = 3, dir = -1, alpha = .7} = {}) {
  const rnd = rng(seed);
  ctx.save(); ctx.fillStyle = color; ctx.globalAlpha = alpha; ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const y = rect.y + rnd() * rect.h, len = rect.w * (.2 + rnd() * .4), x = rect.x + ((rnd() + p * (1.5 + rnd())) % 1.4 - .2) * rect.w * (dir < 0 ? -1 : 1) + (dir < 0 ? rect.w : 0), w = 1.5 + rnd() * 3;
    ctx.moveTo(x, y); ctx.lineTo(x + len, y - w); ctx.lineTo(x + len, y + w * .6); ctx.closePath();
  }
  ctx.fill(); ctx.restore();
}

// 集中线（局部）：从画外向 (cx,cy) 汇聚
export function focus(ctx, e, cx, cy, {color = e.world.ink, alpha = .8, inner = .25, n = 56, seed = 1} = {}) {
  const r = rng(seed), R = Math.hypot(e.W, e.H), r0 = Math.min(e.W, e.H) * inner;
  ctx.save(); ctx.fillStyle = color; ctx.globalAlpha = alpha; ctx.beginPath();
  for (let i = 0; i < n; i++) { const a = (i + r() * .6) / n * TAU, w = (.004 + r() * .014) * TAU, s = r0 * (1 + r() * .5); ctx.moveTo(cx + Math.cos(a) * s, cy + Math.sin(a) * s); ctx.lineTo(cx + Math.cos(a - w) * R, cy + Math.sin(a - w) * R); ctx.lineTo(cx + Math.cos(a + w) * R, cy + Math.sin(a + w) * R); ctx.closePath(); }
  ctx.fill(); ctx.restore();
}

/* 冲击帧：爆点开头约 2 拍画墨/纸反相的集中线（走统一闪光限流，被拒就不画）。q 为爆点内进度。 */
export function impactFrame(ctx, e, q, key, cx, cy) {
  if (q <= 0 || q > .16 || !e.impact(key)) return false;
  ctx.save(); ctx.fillStyle = e.world.paper; ctx.globalAlpha = .92; ctx.fillRect(0, 0, e.W, e.H); ctx.restore();
  focus(ctx, e, cx, cy, {color: e.world.ink, alpha: .95, inner: .18, n: 72, seed: 9});
  return true;
}

/* 车的残影：把车画布按左移副本叠画（透明度递减）。 */
export function ghosts(ctx, e, n = 3, dx = 26, alpha = .32) {
  if (!e.bikeImage) return;
  ctx.save();
  for (let i = n; i >= 1; i--) { ctx.globalAlpha = alpha * (1 - (i - 1) / n); ctx.drawImage(e.bikeImage, -i * dx * e.unit, 0, e.W, e.H); }
  ctx.restore();
}

// 对白框（带尖角）
export function bubble(ctx, x, y, w, h, tx, ty, world, {fill = '#fff', lw = 4} = {}) {
  ctx.save(); ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.roundRect?.(x, y, w, h, Math.min(18, h / 3)); if (!ctx.roundRect) ctx.rect(x, y, w, h);
  ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = world.ink; ctx.stroke();
  const bx = Math.max(x + 18, Math.min(x + w - 30, tx)), by = ty < y ? y : y + h;
  ctx.beginPath(); ctx.moveTo(bx - 12, by); ctx.lineTo(tx, ty); ctx.lineTo(bx + 14, by); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillRect(bx - 10, by - (ty < y ? -3 : 3), 22, 5 * (ty < y ? 1 : -1));
  ctx.restore();
}

// 方格旗纹
export function checker(ctx, x, y, w, h, cell, a = '#0b0a12', b = '#ffffff') {
  for (let j = 0; j * cell < h; j++) for (let i = 0; i * cell < w; i++) { ctx.fillStyle = (i + j) % 2 ? a : b; ctx.fillRect(x + i * cell, y + j * cell, Math.min(cell, w - i * cell), Math.min(cell, h - j * cell)); }
}

/* 碎片：从 (x,y) 区域飞散、余韵阶段缓慢旋转飘落。shapes 为多边形碎片。 */
export function debris(ctx, e, x, y, w, h, q, {n = 24, seed = 5, fill = e.world.paper, ink = e.world.ink, accent = e.world.m, spread = 1, dir = 1} = {}) {
  const rnd = rng(seed), N = count(e, n);
  for (let i = 0; i < N; i++) {
    const ox = x + rnd() * w, oy = y + rnd() * h, vx = (rnd() - .25) * e.W * .7 * spread * dir, vy = -(rnd() * .8 + .15) * e.H * .9 * spread;
    const t = q, px = ox + vx * easeOut(t) * .9, py = oy + vy * easeOut(Math.min(1, t * 1.6)) * .55 + e.H * 1.1 * Math.max(0, t - .3) ** 2;
    const s = (10 + rnd() * 26) * Math.max(1, e.unit);
    ctx.save(); ctx.translate(px, py); ctx.rotate((rnd() - .5) * 8 * t + Math.sin(t * 6 + i) * .4); ctx.globalAlpha = 1 - seg(t, .8, 1);
    ctx.beginPath(); ctx.moveTo(-s / 2, -s / 2 + rnd() * 6); ctx.lineTo(s / 2 - rnd() * 8, -s / 2); ctx.lineTo(s / 2, s / 2 - rnd() * 8); ctx.lineTo(-s / 2 + rnd() * 6, s / 2); ctx.closePath();
    ctx.fillStyle = i % 4 === 0 ? accent : fill; ctx.fill(); ctx.lineWidth = 2.2; ctx.strokeStyle = ink; ctx.stroke();
    ctx.restore();
  }
}

/* 墨线漫画手：袖口 + 手掌 + 握住的印章柄 + 印章底（朝下）。(x,y) 为印章底面中心。 */
export function inkHand(ctx, x, y, s, world, {sleeve = '#38f0ff'} = {}) {
  const ink = world.ink, skin = '#f6c99a', skinD = '#d99b6c';
  ctx.save(); ctx.translate(x, y); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const st = (fill, lw = Math.max(3, s * .025)) => { ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = ink; ctx.stroke(); };
  // 印章底（红色橡胶面朝下）+ 木柄
  ctx.beginPath(); ctx.rect(-s * .34, -s * .16, s * .68, s * .16); st('#b81f24');
  ctx.beginPath(); ctx.rect(-s * .3, -s * .24, s * .6, s * .09); st('#5b3a22');
  ctx.beginPath(); ctx.moveTo(-s * .1, -s * .24); ctx.lineTo(-s * .13, -s * .62); ctx.lineTo(s * .13, -s * .62); ctx.lineTo(s * .1, -s * .24); ctx.closePath(); st('#8a5a33');
  ctx.beginPath(); ctx.ellipse(0, -s * .66, s * .2, s * .1, 0, 0, TAU); st('#8a5a33');
  // 手掌包住柄
  ctx.beginPath(); ctx.moveTo(-s * .28, -s * .5); ctx.quadraticCurveTo(-s * .34, -s * .86, -s * .1, -s * .95); ctx.quadraticCurveTo(s * .3, -s * 1.0, s * .33, -s * .7); ctx.quadraticCurveTo(s * .34, -s * .5, s * .2, -s * .44); ctx.lineTo(-s * .22, -s * .42); ctx.closePath(); st(skin);
  // 手指（四根横握）
  for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse(-s * .02 + i * s * .085, -s * .47 - i * s * .005, s * .06, s * .085, .2, 0, TAU); st(skin, Math.max(2.5, s * .02)); }
  // 拇指
  ctx.beginPath(); ctx.ellipse(-s * .24, -s * .62, s * .07, s * .14, -.5, 0, TAU); st(skin, Math.max(2.5, s * .02));
  // 暗部网点
  ctx.save(); ctx.globalAlpha = .45; halftone(ctx, s * .05, -s * .95, s * .3, s * .45, skinD, Math.max(4, s * .03), px => clamp01((px - s * .05) / (s * .3))); ctx.restore();
  // 袖子 + 袖口白边
  ctx.beginPath(); ctx.moveTo(-s * .26, -s * .9); ctx.lineTo(-s * .34, -s * 1.9); ctx.lineTo(s * .4, -s * 1.9); ctx.lineTo(s * .3, -s * .86); ctx.closePath(); st(sleeve);
  ctx.beginPath(); ctx.moveTo(-s * .28, -s * .86); ctx.lineTo(-s * .3, -s * 1.02); ctx.lineTo(s * .34, -s * 1.02); ctx.lineTo(s * .32, -s * .84); ctx.closePath(); st('#ffffff');
  ctx.restore();
}
