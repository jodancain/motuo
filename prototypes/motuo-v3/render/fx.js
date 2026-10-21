/* 特效粒子（30fps 步进）：漫画烟团、排气火焰、火花、胎痕、轮速圈、蓄力环、冲击环。
 * 静态绘制函数同时供 cut-in 与漫画页使用。全部是装饰，不读写数据。 */
import {rng} from '../core/geometry.js';
const TAU = Math.PI * 2;

export function drawSmoke(ctx, x, y, r, {ink = '#0b0a12', fill = '#f4efe6', shade = '#b9b2c8', alpha = 1, seed = 1} = {}) {
  const rand = rng(seed);
  ctx.save(); ctx.globalAlpha = alpha;
  const blobs = Array.from({length: 6}, (_, i) => { const a = i / 6 * TAU + rand() * .6; return [x + Math.cos(a) * r * .55, y + Math.sin(a) * r * .4, r * (.42 + rand() * .3)]; });
  ctx.beginPath(); for (const [bx, by, br] of blobs) { ctx.moveTo(bx + br, by); ctx.arc(bx, by, br, 0, TAU); }
  ctx.lineWidth = Math.max(2, r * .09); ctx.strokeStyle = ink; ctx.stroke();
  ctx.fillStyle = fill; ctx.fill();
  ctx.beginPath(); for (const [bx, by, br] of blobs) { ctx.moveTo(bx + br * .6, by + br * .25); ctx.arc(bx + br * .1, by + br * .25, br * .55, 0, TAU); }
  ctx.fillStyle = shade; ctx.globalAlpha = alpha * .55; ctx.fill();
  ctx.restore();
}

export function drawFlame(ctx, x, y, len, {angle = Math.PI, ink = '#0b0a12', seed = 1, alpha = 1} = {}) {
  const rand = rng(seed);
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.globalAlpha = alpha;
  for (const [k, col] of [[1, '#ff3b2f'], [.72, '#ff9a1f'], [.42, '#fff27a']]) {
    ctx.beginPath(); ctx.moveTo(0, -len * .16 * k);
    const n = 5;
    for (let i = 1; i <= n; i++) { const t = i / n; ctx.lineTo(len * k * t, (i % 2 ? -1 : 1) * len * .2 * k * (1 - t) * (.6 + rand() * .7)); }
    ctx.lineTo(0, len * .16 * k); ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    if (k === 1) { ctx.lineWidth = Math.max(2, len * .04); ctx.strokeStyle = ink; ctx.stroke(); }
  }
  ctx.restore();
}

export function drawSparks(ctx, x, y, len, {angle = Math.PI * .9, spread = .9, count = 12, seed = 1, color = '#ffe45c', ink = '#0b0a12'} = {}) {
  const rand = rng(seed);
  ctx.save(); ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const a = angle + (rand() - .5) * spread, l = len * (.4 + rand() * .6), w = 1.5 + rand() * 2.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.lineWidth = w + 2; ctx.strokeStyle = ink; ctx.stroke(); ctx.lineWidth = w; ctx.strokeStyle = color; ctx.stroke();
  }
  ctx.restore();
}

// 轮速圈：漫画里的“转动模糊”弧线，弧数随速度增加（装饰，速度数字另行显示）。
export function drawWheelArcs(ctx, x, y, r, intensity, color = '#ffffff') {
  if (intensity <= .02) return;
  ctx.save(); ctx.strokeStyle = color; ctx.lineCap = 'round';
  const n = 2 + Math.round(intensity * 3);
  for (let i = 0; i < n; i++) {
    const rr = r * (.45 + i * .14), a0 = -Math.PI * .85 + i * .5;
    ctx.globalAlpha = .7 * intensity; ctx.lineWidth = Math.max(1.5, r * .05);
    ctx.beginPath(); ctx.arc(x, y, rr, a0, a0 + Math.PI * (.5 + intensity * .6)); ctx.stroke();
  }
  ctx.restore();
}

export function drawTextStamp(ctx, text, x, y, size, {fill = '#ffe45c', ink = '#0b0a12', shadow = '#ff3da6', rotate = -.12, font = 'MotuoDisplay, MotuoHan, sans-serif', align = 'center', maxWidth, stroke = .16, shadowOffset = .065} = {}) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rotate);
  // 中文拟声字略压扁加宽：得意黑是窄长字形，上下结构字（轰）压扁后更像一个整字。
  if (/[一-鿿]/.test(text)) ctx.scale(1.12, .92);
  ctx.font = `${Math.round(size)}px ${font}`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  // 放不下时缩小字号，而不是用 fillText 的 maxWidth 横向压扁（压扁会让“轰”这类上下结构字看起来裂成两个字）。
  if (maxWidth) { const w = ctx.measureText(text).width; if (w > maxWidth) { size = size * maxWidth / w; ctx.font = `${Math.round(size)}px ${font}`; } }
  ctx.fillStyle = shadow; ctx.fillText(text, size * shadowOffset, size * shadowOffset * 1.15);
  ctx.lineWidth = Math.max(3, size * stroke); ctx.strokeStyle = ink; ctx.strokeText(text, 0, 0);
  ctx.fillStyle = fill; ctx.fillText(text, 0, 0);
  ctx.restore();
}

export function drawContactShadow(g, rc, fc, ground, ppu, ink) {
  // 接地阴影：抬头时只剩后轮下的一小块。
  g.save(); g.fillStyle = ink; g.globalAlpha = .55;
  g.beginPath(); g.ellipse((rc.x + fc.x) / 2, ground + 3, Math.abs(fc.x - rc.x) * .62 + ppu * .2, ppu * .055, 0, 0, Math.PI * 2); g.fill();
  g.globalAlpha = .8;
  for (const p of [rc, fc]) { const k = Math.max(.25, 1 - (ground - p.y) / (ppu * .5)); g.beginPath(); g.ellipse(p.x, ground + 2, ppu * .2 * k, ppu * .035 * k, 0, 0, Math.PI * 2); g.fill(); }
  g.restore();
}

export function createFx() {
  let parts = [];
  const rand = Math.random;
  return {
    emit(kind, x, y, o = {}) {
      const scale = o.scale ?? 1, budget = o.particles ?? 1;
      if (kind === 'smoke') for (let i = 0; i < Math.max(1, Math.round((o.count ?? 3) * budget)); i++) parts.push({kind, x: x + (rand() - .5) * 20 * scale, y: y - rand() * 10 * scale, vx: (o.vx ?? -120) * (.6 + rand() * .8), vy: -20 - rand() * 50, r: (14 + rand() * 16) * scale, grow: 40 * scale, life: .9 + rand() * .5, age: 0, seed: (rand() * 1e6) | 0});
      else if (kind === 'flame') parts.push({kind, x, y, len: (o.len ?? 60) * scale, life: o.life ?? .28, age: 0, seed: (rand() * 1e6) | 0, angle: o.angle ?? Math.PI * .97, follow: o.follow});
      else if (kind === 'sparks') parts.push({kind, x, y, len: (o.len ?? 70) * scale, life: .3, age: 0, seed: (rand() * 1e6) | 0, angle: o.angle ?? Math.PI * .92, follow: o.follow});
      else if (kind === 'ring') parts.push({kind, x, y, r: 10 * scale, vr: (o.vr ?? 520) * scale, life: o.life ?? .4, age: 0, color: o.color || '#fff'});
      else if (kind === 'skid') parts.push({kind, x, y, w: 0, vx: o.vx ?? -260, life: 1.2, age: 0});
    },
    update(dt) {
      for (const p of parts) {
        p.age += dt;
        if (p.follow) { const q = p.follow(); p.x = q.x; p.y = q.y; }
        if (p.kind === 'smoke') { p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.grow * dt; }
        else if (p.kind === 'ring') p.r += p.vr * dt;
        else if (p.kind === 'skid') { p.w += 200 * dt; p.x += p.vx * dt; }
      }
      parts = parts.filter(p => p.age < p.life);
    },
    draw(ctx, world) {
      for (const p of parts) {
        const k = 1 - p.age / p.life;
        if (p.kind === 'smoke') drawSmoke(ctx, p.x, p.y, p.r, {alpha: Math.min(1, k * 1.6), seed: p.seed, ink: world.ink});
        else if (p.kind === 'flame') drawFlame(ctx, p.x, p.y, p.len * (.7 + .3 * k), {angle: p.angle, seed: p.seed + ((p.age * 30) | 0), ink: world.ink});
        else if (p.kind === 'sparks') drawSparks(ctx, p.x, p.y, p.len, {angle: p.angle, seed: p.seed + ((p.age * 30) | 0), ink: world.ink, color: world.y});
        else if (p.kind === 'ring') { ctx.save(); ctx.globalAlpha = k; ctx.lineWidth = 6 * k + 1; ctx.strokeStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke(); ctx.restore(); }
        else if (p.kind === 'skid') { ctx.save(); ctx.globalAlpha = .7 * k; ctx.fillStyle = world.ink; ctx.fillRect(p.x, p.y - 3, p.w, 5); ctx.restore(); }
      }
    },
    clear() { parts = []; },
    get count() { return parts.length; },
  };
}
