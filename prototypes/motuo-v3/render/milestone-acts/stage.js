/* 舞台类剧目：破纸墙、冲线横幅、音障锥、数字赛跑、速度对比（代码绘制的平涂墨线动物）。
 * 共同套路：道具立在车头前方 → 车先后退让观众看清道具（起）→ 冲刺（冲突）→ 撞穿/冲线/超越（爆点）→ 余韵。 */
import {rng, clamp01, seg, beat, easeOut, easeIn, easeInOut, back, lerp, frame3, TAU, text, num, paper, burst, confetti, rings, count, speedLinesLocal, impactFrame, ghosts, debris, checker, bubble, halftone} from './common.js';
import {drawSmoke} from '../fx.js';
import {approxLabel} from '../../data/speed-comparisons.js';

/* 道具几何：道具中心 x、宽高，以及车需要后退/冲刺的距离（模型单位）。 */
export function propGeom(e, {hRatio = 1, wRatio = .72, maxW = .4} = {}) {
  const front = e.base('headlight').x, st = e.stage;
  const h = (e.landscape ? e.H * .62 : Math.min(e.H * .34, e.ground - st.y - 10)) * hRatio, w = Math.min(h * wRatio, st.w * (e.landscape ? maxW : Math.max(.62, maxW + .2)));
  const cx = e.landscape ? Math.min(st.x + st.w - w / 2 - 6, st.x + st.w * .74) : st.x + st.w * .6;
  const left = cx - w / 2;
  const backup = Math.max(-1.25, Math.min(0, (left - 18 - front) / e.ppu));
  const hit = Math.min((cx + w * .2 - front) / e.ppu, (e.W * .98 - front) / e.ppu);
  return {front, cx, w, h, left, top: e.ground - h, backup, hit};
}
// 起：后退；冲突：冲刺到道具；爆点：冲过；余韵：弹簧回位
export function chargePose(p, g, {wheelie = 0} = {}) {
  const s = beat(p, 'setup'), c = beat(p, 'conflict'), k = beat(p, 'climax'), a = beat(p, 'after');
  let dz;
  if (p < .26) dz = g.backup * easeOut(s);
  else if (p < .46) dz = lerp(g.backup, g.hit, easeIn(c));
  else if (p < .6) dz = g.hit + .12 * Math.sin(k * Math.PI);
  else dz = g.hit * (1 - easeOut(a)) * Math.cos(a * 4);
  const shake = p >= .46 && p < .56 ? 1.6 : p >= .26 && p < .46 ? .5 : 0;
  return {dz, pitch: p < .26 ? .04 * s : p >= .6 ? -wheelie * Math.sin(a * Math.PI) : 0, squash: p < .26 ? 1 - .05 * s : p < .6 && p >= .4 ? 1.1 : 1, shake};
}
const charging = p => p >= .26 && p < .6;

/* ---------------- 破纸墙 ---------------- */
export const paperWall = {
  bike: (p, e) => chargePose(p, propGeom(e), {wheelie: .12}),
  draw(ctx, p, e) {
    const W = e.world, g = propGeom(e), {cx, w, h} = g, base = e.ground + 6, top = base - h;
    const drop = back(seg(p, 0, .2)), y0 = lerp(-h - 40, top, drop);
    const k = beat(p, 'climax'), a = beat(p, 'after');
    const holeC = {x: cx - w * .05, y: base - h * .42}, holeR = p < .46 ? 0 : Math.min(w * .48, w * .55 * easeOut(k * 1.8));
    if (charging(p)) { speedLinesLocal(ctx, {x: 0, y: e.bikeTop - 20, w: g.left, h: e.ground - e.bikeTop}, p, {n: 16, color: W.line, seed: e.seed}); ghosts(ctx, e, 3, 28, .28); }
    if (impactFrame(ctx, e, k, 'paper', holeC.x, holeC.y)) return;
    // 墙体：余韵阶段整块向后倒下并淡出
    const fall = easeIn(a), alpha = 1 - seg(a, .55, 1);
    if (alpha > 0) {
      ctx.save(); ctx.globalAlpha = alpha; ctx.translate(cx, base); ctx.rotate(fall * .5); ctx.scale(1, 1 - fall * .4); ctx.translate(-cx, -base);
      const wob = p >= .3 && p < .46 ? Math.sin(p * 120) * 2 : 0;
      ctx.translate(wob, y0 - top);
      // 支架
      ctx.fillStyle = W.ink; ctx.fillRect(cx - w * .38, base - 16, 10, 20); ctx.fillRect(cx + w * .3, base - 16, 10, 20);
      // 纸墙（带撕边）+ 破洞（evenodd）
      const rnd = rng(e.seed + 3);
      ctx.beginPath(); ctx.moveTo(cx - w / 2, top);
      for (let i = 1; i <= 10; i++) ctx.lineTo(cx - w / 2 + w * i / 10, top + (rnd() - .5) * 6);
      for (let i = 1; i <= 12; i++) ctx.lineTo(cx + w / 2 + (rnd() - .5) * 6, top + h * i / 12);
      for (let i = 9; i >= 0; i--) ctx.lineTo(cx - w / 2 + w * i / 10, base + (rnd() - .5) * 5);
      for (let i = 11; i >= 0; i--) ctx.lineTo(cx - w / 2 + (rnd() - .5) * 6, top + h * i / 12);
      ctx.closePath();
      if (holeR > 0) { const hr = rng(e.seed + 8); for (let i = 0; i < 14; i++) { const ang = i / 14 * TAU, r = holeR * (.65 + hr() * .5); i ? ctx.lineTo(holeC.x + Math.cos(ang) * r, holeC.y + Math.sin(ang) * r * 1.15) : ctx.moveTo(holeC.x + holeR, holeC.y); } ctx.closePath(); }
      ctx.fillStyle = W.paper; ctx.fill('evenodd'); ctx.lineWidth = 6; ctx.strokeStyle = W.ink; ctx.stroke();
      ctx.save(); ctx.clip('evenodd');
      ctx.globalAlpha = .5; halftone(ctx, cx - w / 2, top, w, h, W.m, Math.max(7, w * .045), (px, py) => clamp01(((px - cx + w / 2) / w + (py - top) / h) * .9 - .55)); ctx.globalAlpha = 1;
      // 分镜框线 + 巨型数字
      ctx.lineWidth = 4; ctx.strokeStyle = W.ink; ctx.strokeRect(cx - w / 2 + 12, top + 12, w - 24, h - 24);
      num(ctx, e.thText, cx, top + h * .44, h * .46, {fill: W.m, ghost: [W.c, W.y], maxWidth: w * .86});
      text(ctx, 'KM/H', cx, top + h * .78, h * .11, {fill: W.ink, ink: W.paper, stroke: .1});
      ctx.restore();
      ctx.restore();
    }
    // 爆点后：碎纸飞散，余韵飘落
    if (p >= .46) debris(ctx, e, holeC.x - w * .3, holeC.y - h * .3, w * .6, h * .6, seg(p, .46, 1), {n: 30, seed: e.seed + 11, dir: 1});
    if (p >= .46 && p < .8) e.say('RRRIP!', Math.min(holeC.x, e.stage.x + e.stage.w * .5), Math.max(e.zones.title.y + 40, top - 10), e.big * .42 * back(seg(k, 0, .6)), {prio: 2, fill: W.y});
    else if (p < .26 && p > .08) e.say(`${e.thText} 号纸墙！`, cx, Math.max(e.zones.title.y + 20, top - 24), e.big * .16, {prio: 1, fill: '#fff'});
  },
};

/* ---------------- 冲线横幅 ---------------- */
export const finishBanner = {
  bike: (p, e) => chargePose(p, propGeom(e, {wRatio: 1.6, maxW: .62}), {wheelie: .2}),
  draw(ctx, p, e) {
    const W = e.world, g = propGeom(e, {wRatio: 1.6, maxW: .62}), {cx, w, h} = g, base = e.ground + 6;
    const bh = Math.max(64, h * .36), by = base - h, k = beat(p, 'climax'), a = beat(p, 'after');
    const slide = 1 - easeOut(seg(p, 0, .22)), sx = slide * (e.W - g.left + 40), x0 = cx - w / 2 + sx, x1 = cx + w / 2 + sx;
    const tapeY = e.bikeTop + (e.ground - e.bikeTop) * .45;
    if (charging(p)) { speedLinesLocal(ctx, {x: 0, y: e.bikeTop - 20, w: g.left, h: e.ground - e.bikeTop}, p, {n: 16, color: W.line, seed: e.seed}); ghosts(ctx, e, 3, 28, .28); }
    if (impactFrame(ctx, e, k, 'finish', g.front + g.hit * e.ppu * .6, tapeY)) return;
    // 远柱（暗）、横幅、近柱
    ctx.fillStyle = W.ink; ctx.fillRect(x1 - 8, by, 14, h + 4);
    ctx.save(); ctx.translate(0, Math.sin(p * 18) * 2);
    ctx.fillStyle = W.ink; ctx.fillRect(x0 - 6 + 6, by + 6, x1 - x0 + 12, bh);
    ctx.fillStyle = W.y; ctx.fillRect(x0 - 6, by, x1 - x0 + 12, bh);
    const cell = Math.max(8, bh * .16);
    checker(ctx, x0 - 6, by, x1 - x0 + 12, cell * 1, cell); checker(ctx, x0 - 6, by + bh - cell, x1 - x0 + 12, cell, cell);
    ctx.lineWidth = 5; ctx.strokeStyle = W.ink; ctx.strokeRect(x0 - 6, by, x1 - x0 + 12, bh);
    num(ctx, `${e.thText} KM/H`, (x0 + x1) / 2, by + bh / 2 + 2, (bh - cell * 2) * .9, {fill: W.m, ghost: [W.c, '#fff'], maxWidth: (x1 - x0) * .9});
    ctx.restore();
    ctx.fillStyle = W.ink; ctx.fillRect(x0 - 10, by - 10, 16, h + 14);
    // 小旗
    for (const fx of [x0 - 2, x1 + 2]) { ctx.save(); ctx.translate(fx, by - 10); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -36); ctx.strokeStyle = W.ink; ctx.lineWidth = 4; ctx.stroke(); ctx.beginPath(); ctx.rect(0, -36, 34, 22); ctx.save(); ctx.clip(); checker(ctx, 0, -36, 34, 22, 7); ctx.restore(); ctx.lineWidth = 2.5; ctx.stroke(); ctx.restore(); }
    // 冲线彩带：撞断前一条线，撞断后两截甩飞并飘落
    if (p < .46) { ctx.lineWidth = 9; ctx.strokeStyle = W.ink; ctx.beginPath(); ctx.moveTo(x0, tapeY); ctx.lineTo(x1, tapeY + 4); ctx.stroke(); ctx.lineWidth = 6; ctx.strokeStyle = W.m; ctx.stroke(); }
    else {
      const q = seg(p, .46, 1);
      for (const [ax, s] of [[x0, -1], [x1, 1]]) {
        const len = (x1 - x0) * .5, tip = {x: ax + s * len * (.3 + q * .5) * (s < 0 ? -.4 : 1), y: tapeY + q * e.H * .6};
        ctx.lineWidth = 9; ctx.strokeStyle = W.ink; ctx.beginPath(); ctx.moveTo(ax, tapeY); ctx.bezierCurveTo(ax + s * len * .3, tapeY - 60 * (1 - q), tip.x - s * 40, tip.y - 80 * q, tip.x, tip.y); ctx.stroke();
        ctx.lineWidth = 6; ctx.strokeStyle = W.m; ctx.stroke();
      }
      confetti(ctx, e, (x0 + x1) / 2, tapeY, seg(p, .46, .9), {n: 70, spread: 1.7, seed: e.seed + 5});
      confetti(ctx, e, 0, 0, a, {n: 90, seed: e.seed + 6, rain: true});
      if (p < .85) e.say('FINISH!', (x0 + x1) / 2, Math.max(e.zones.title.y + 30, by - 40), e.big * .38 * back(seg(k, 0, .6)), {prio: 2, fill: W.y});
    }
  },
};

/* ---------------- 音障锥 ---------------- */
export const sonicCone = {
  // 车先后退给锥体留出空间，爆点时向前猛冲
  bike: (p, e) => { const back0 = e.landscape ? -.55 : -.45; return {dz: p < .26 ? back0 * easeOut(beat(p, 'setup')) : p < .46 ? back0 : p < .6 ? lerp(back0, .15, easeOut(beat(p, 'climax'))) : .15 * (1 - easeOut(beat(p, 'after'))), squash: p < .26 ? .95 : p < .6 ? 1.12 : 1, pitch: p < .26 ? .03 : p < .6 ? -.05 : 0, shake: p >= .46 && p < .58 ? 1.4 : p >= .26 && p < .46 ? .6 : 0}; },
  draw(ctx, p, e) {
    const W = e.world, nose = e.point('headlight'), L = e.ppu * (e.landscape ? 1.05 : .8), R = (e.ground - e.bikeTop) * .66;
    const s = beat(p, 'setup'), c = beat(p, 'conflict'), k = beat(p, 'climax'), a = beat(p, 'after');
    // 起：车头前方的压力波纹
    if (p < .46) for (let i = 0; i < 4; i++) { const q = (s * 1.5 + i * .25) % 1; ctx.save(); ctx.globalAlpha = (1 - q) * .9; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(nose.x + 20 + q * 60, nose.y, 18 + q * R * .8, -.9, .9); ctx.stroke(); ctx.restore(); }
    if (impactFrame(ctx, e, k, 'sonic', nose.x + L * .4, nose.y)) return;
    // 冲突→爆点：干净的白色蒸汽锥（墨线轮廓 + 下半网点阴影），锥尖在车头前方，只包住车头
    const grow = p < .26 ? 0 : p < .46 ? easeOut(c) : 1, peel = a;
    if (grow > 0 && peel < 1) {
      const apex = {x: nose.x + L * .75 * grow, y: nose.y}, rim = nose.x - L * .12 * grow, rr = R * grow * (1 + peel * .3);
      ctx.save(); ctx.globalAlpha = 1 - peel;
      ctx.beginPath(); ctx.moveTo(apex.x, apex.y);
      ctx.bezierCurveTo(apex.x - L * .2, apex.y - rr * .55, rim + L * .1, apex.y - rr, rim, apex.y - rr);
      ctx.quadraticCurveTo(rim - L * .18, apex.y, rim, apex.y + rr);
      ctx.bezierCurveTo(rim + L * .1, apex.y + rr, apex.x - L * .2, apex.y + rr * .55, apex.x, apex.y);
      ctx.closePath(); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 5; ctx.strokeStyle = W.ink; ctx.stroke();
      ctx.save(); ctx.clip(); ctx.globalAlpha = .4; halftone(ctx, rim - L * .2, apex.y, L * 1.2, rr, '#7fa3c8', 7, (px, py) => clamp01((py - apex.y) / rr)); ctx.restore();
      ctx.strokeStyle = '#9ec4e6'; ctx.lineWidth = 2.5;
      for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(apex.x - 6, apex.y + i * 3); ctx.quadraticCurveTo(rim + L * .3, apex.y + i * rr * .3, rim + 4, apex.y + i * rr * .42); ctx.stroke(); }
      ctx.restore();
      // 余韵：锥体剥落成烟团向后飘
      if (peel > 0) for (let i = 0; i < 5; i++) drawSmoke(ctx, rim - peel * e.W * .35 * (.5 + i * .2), apex.y + (i - 2) * rr * .4, R * .28 * (1 + peel), {alpha: 1 - peel, seed: e.seed + i, ink: W.ink});
    }
    // 爆点：2–3 圈清晰冲击环
    if (p >= .46) rings(ctx, nose.x + L * .4, nose.y, seg(p, .46, 1), {n: 3, maxR: e.W * .55, color: W.c, ink: W.ink, lw: 12, squash: .78});
    if (p >= .46 && p < .9) {
      const bx = e.stage.x + e.stage.w * (e.landscape ? .26 : .5), by = e.landscape ? e.H * .44 : e.zones.title.y + e.big * .3, bs = back(seg(k, 0, .6));
      burst(ctx, bx, by, e.big * .46 * bs, 16, W.y, W.ink, e.seed);
      e.say('BOOM', bx, by, e.big * .34 * bs, {prio: 2, fill: W.m, free: true});
    }
  },
};

/* ---------------- 数字赛跑 ---------------- */
function runnerNumber(ctx, e, x, y, size, step, mood) {
  const W = e.world, legA = [.6, -.1, -.6][step], armA = [-.6, .1, .6][step];
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = W.ink; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // 腿与胳膊（粗墨线 + 白手套/鞋）
  for (const [s, k] of [[-1, 1], [1, -1]]) {
    const lx = s * size * .14, ha = legA * k;
    ctx.lineWidth = size * .07; ctx.beginPath(); ctx.moveTo(lx, size * .32); ctx.lineTo(lx + Math.sin(ha) * size * .25, size * .32 + Math.cos(ha) * size * .25); ctx.lineTo(lx + Math.sin(ha) * size * .25 + size * .08, size * .62); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(lx + Math.sin(ha) * size * .25 + size * .12, size * .64, size * .1, size * .05, 0, 0, TAU); ctx.fillStyle = '#ff4a3d'; ctx.fill(); ctx.lineWidth = 3; ctx.stroke();
    const aa = armA * k; ctx.lineWidth = size * .05; ctx.beginPath(); ctx.moveTo(s * size * .3, -size * .05); ctx.lineTo(s * size * .3 + Math.sin(aa) * size * .22, -size * .05 + Math.cos(aa) * size * .14); ctx.stroke();
    ctx.beginPath(); ctx.arc(s * size * .3 + Math.sin(aa) * size * .22, -size * .05 + Math.cos(aa) * size * .14, size * .05, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 3; ctx.stroke();
  }
  num(ctx, e.thText, 0, 0, size * .82, {fill: W.y, ghost: [W.c, W.m], stroke: .12});
  // 眼睛
  for (const s of [-1, 1]) {
    const ex = s * size * .12, ey = -size * .14;
    ctx.beginPath(); ctx.ellipse(ex, ey, size * .065, size * .08, 0, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = W.ink; ctx.stroke();
    if (mood === 'ko') { ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(ex - 8, ey - 8); ctx.lineTo(ex + 8, ey + 8); ctx.moveTo(ex + 8, ey - 8); ctx.lineTo(ex - 8, ey + 8); ctx.stroke(); }
    else { const look = mood === 'scared' ? -size * .03 : size * .025; ctx.beginPath(); ctx.arc(ex + look, ey + (mood === 'scared' ? 0 : 2), size * .03, 0, TAU); ctx.fillStyle = W.ink; ctx.fill(); }
  }
  if (mood === 'cocky') { ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, size * .06, size * .08, .2, Math.PI - .2); ctx.stroke(); }
  if (mood === 'scared') { ctx.fillStyle = '#9ad8ff'; ctx.strokeStyle = W.ink; ctx.lineWidth = 2.5; for (const [dx, dy] of [[size * .36, -size * .32], [size * .44, -size * .14]]) { ctx.beginPath(); ctx.moveTo(dx, dy - 12); ctx.quadraticCurveTo(dx + 9, dy + 4, dx, dy + 8); ctx.quadraticCurveTo(dx - 9, dy + 4, dx, dy - 12); ctx.fill(); ctx.stroke(); } }
  ctx.restore();
}
export const numberRace = {
  bike: (p, e) => chargePose(p, propGeom(e, {hRatio: .8, wRatio: .7}), {wheelie: .15}),
  draw(ctx, p, e) {
    const W = e.world, g = propGeom(e, {hRatio: .8, wRatio: .7}), size = g.h, k = beat(p, 'climax'), a = beat(p, 'after');
    const step = frame3(p, 9), baseY = e.ground - size * .64;
    let x = g.cx, y = baseY, rot = 0, mood = p < .26 ? 'cocky' : p < .46 ? 'scared' : 'ko';
    if (p < .2) x = lerp(e.W + size, g.cx, easeOut(seg(p, 0, .2)));
    if (p >= .46) { const q = seg(p, .46, 1); x = g.cx - easeIn(q) * (g.cx + size * 1.2); rot = -q * 7; y = baseY - Math.abs(Math.sin(q * 8)) * size * .35 * (1 - q); }
    if (charging(p)) { ghosts(ctx, e, 3, 28, .28); speedLinesLocal(ctx, {x: x - size * .9, y: y - size * .4, w: size * .7, h: size * .8}, p, {n: 9, color: W.line, seed: e.seed}); }
    if (impactFrame(ctx, e, k, 'race', x, y)) return;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); runnerNumber(ctx, e, 0, 0, size, step, mood); ctx.restore();
    if (p >= .46 && p < .7) { for (let i = 0; i < 5; i++) { const ang = p * 20 + i * TAU / 5; ctx.fillStyle = W.y; ctx.beginPath(); ctx.arc(x + Math.cos(ang) * size * .5, y - size * .45 + Math.sin(ang) * size * .12, 6, 0, TAU); ctx.fill(); } }
    const ty = Math.max(e.zones.title.y + 20, g.top - 10);
    if (p > .06 && p < .26) e.say('来追我呀～', g.cx, ty, e.big * .16, {prio: 1, fill: '#fff'});
    else if (p >= .46 && p < .62) e.say('ZOOM!', e.stage.x + e.stage.w * .45, ty + 10, e.big * .36 * back(seg(k, 0, .6)), {prio: 2});
    else if (p >= .62 && p < .95) e.say('等等我！', Math.max(e.stage.x + 120, x + size * .3), ty, e.big * .2, {prio: 1, fill: '#fff'});
  },
};

/* ---------------- 动物剪影（平涂 + 墨线，3 帧步进） ---------------- */
const PAL = {
  runner: {body: '#e8473c', dark: '#1d1d26', skin: '#f2c193'}, elephant: {body: '#97a0ae', dark: '#6f7786'}, bear: {body: '#7a5332', dark: '#4e3420'},
  giraffe: {body: '#f0bd52', dark: '#a8612a'}, dog: {body: '#c4bdb1', dark: '#8f877b'}, kangaroo: {body: '#cc8148', dark: '#8f5530'},
  ostrich: {body: '#24222b', dark: '#f0a8a0', skin: '#f0a8a0'}, horse: {body: '#8f5a2c', dark: '#3a2414'}, hare: {body: '#b8916a', dark: '#7c5d40'},
  antelope: {body: '#cf9a5f', dark: '#2a1c12'}, cheetah: {body: '#eab44e', dark: '#2a1c12'},
};
function limb(ctx, hx, hy, l1, l2, a1, a2, w, col, ink, hoof = null) {
  const kx = hx + Math.sin(a1) * l1, ky = hy + Math.cos(a1) * l1, fx = kx + Math.sin(a1 + a2) * l2, fy = ky + Math.cos(a1 + a2) * l2;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy);
  ctx.lineWidth = w + 5; ctx.strokeStyle = ink; ctx.stroke(); ctx.lineWidth = w; ctx.strokeStyle = col; ctx.stroke();
  if (hoof) { ctx.beginPath(); ctx.ellipse(fx + w * .2, fy, w * .55, w * .32, 0, 0, TAU); ctx.fillStyle = hoof; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = ink; ctx.stroke(); }
}
const GAIT = [ // [前近, 前远, 后近, 后远]，每项 [大腿角, 小腿角]（正 = 向前）
  [[.8, -.6], [.5, -.3], [-.8, .7], [-.5, .5]],
  [[-.35, 1.0], [-.15, .7], [.5, -1.0], [.3, -.7]],
  [[.25, .2], [-.25, .8], [-.25, .35], [.35, -.6]],
];
function fill(ctx, col, ink, lw = 4) { ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = ink; ctx.stroke(); }
function eye(ctx, x, y, r, ink, mood) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = ink; ctx.stroke();
  ctx.beginPath(); ctx.arc(x + (mood === 'surprised' ? -r * .35 : r * .3), y, r * .5, 0, TAU); ctx.fillStyle = ink; ctx.fill();
}

/* 四足通用：cfg 决定比例与特征。原点在地面、身体中下方，面朝右。 */
function quad(ctx, s, f, c, ink, cfg, mood) {
  const legL = s * cfg.leg, bodyH = s * cfg.bh, bodyL = s * cfg.bl, hipY = -legL, chestX = bodyL * .38, rumpX = -bodyL * .4;
  const G = GAIT[f], lw = s * cfg.lw;
  // 远侧腿（暗）
  limb(ctx, chestX, hipY - bodyH * .1, legL * .5, legL * .55, G[1][0] * cfg.swing, G[1][1] * cfg.swing, lw * .9, c.dark, ink, cfg.hoof);
  limb(ctx, rumpX, hipY - bodyH * .15, legL * .52, legL * .55, G[3][0] * cfg.swing, G[3][1] * cfg.swing, lw * .95, c.dark, ink, cfg.hoof);
  if (cfg.tail) cfg.tail(ctx, rumpX, hipY - bodyH * .55, s, f, c, ink);
  // 躯干：胸深、腰收
  ctx.beginPath();
  ctx.moveTo(rumpX - bodyL * .1, hipY - bodyH * .55);
  ctx.bezierCurveTo(rumpX, hipY - bodyH * (1.05 + (cfg.hump || 0)), chestX - bodyL * .2, hipY - bodyH * 1.05, chestX + bodyL * .12, hipY - bodyH * (.9 + (cfg.withers || 0)));
  ctx.bezierCurveTo(chestX + bodyL * .25, hipY - bodyH * .5, chestX + bodyL * .1, hipY + bodyH * (cfg.chest || .05), chestX - bodyL * .05, hipY + bodyH * (cfg.chest || .05));
  ctx.bezierCurveTo(chestX - bodyL * .3, hipY + bodyH * (cfg.tuck ?? -.05), rumpX + bodyL * .25, hipY + bodyH * (cfg.tuck ?? -.05), rumpX - bodyL * .05, hipY + bodyH * .05);
  ctx.bezierCurveTo(rumpX - bodyL * .2, hipY - bodyH * .1, rumpX - bodyL * .18, hipY - bodyH * .45, rumpX - bodyL * .1, hipY - bodyH * .55);
  ctx.closePath(); fill(ctx, c.body, ink);
  if (cfg.pattern) { ctx.save(); ctx.clip(); cfg.pattern(ctx, rumpX - bodyL * .2, hipY - bodyH * 1.2, bodyL * 1.5, bodyH * 1.4, s, c); ctx.restore(); }
  // 近侧腿
  limb(ctx, chestX, hipY - bodyH * .1, legL * .5, legL * .55, G[0][0] * cfg.swing, G[0][1] * cfg.swing, lw, c.body, ink, cfg.hoof);
  limb(ctx, rumpX, hipY - bodyH * .15, legL * .52, legL * .55, G[2][0] * cfg.swing, G[2][1] * cfg.swing, lw * 1.05, c.body, ink, cfg.hoof);
  // 颈与头
  cfg.head(ctx, chestX + bodyL * .05, hipY - bodyH * .85, s, f, c, ink, mood);
}
const ANIMALS = {
  dog: (ctx, s, f, c, ink, mood) => quad(ctx, s, f, c, ink, {leg: .52, bh: .36, bl: .95, lw: .06, swing: 1.35, chest: .25, tuck: -.3, withers: .05,
    tail: (ctx, x, y, s, f) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x - s * .35, y + s * .05, x - s * .45, y - s * .12 + f * s * .04); ctx.lineWidth = s * .04 + 4; ctx.strokeStyle = ink; ctx.stroke(); ctx.lineWidth = s * .04; ctx.strokeStyle = c.body; ctx.stroke(); },
    head: (ctx, x, y, s, f, c, ink, mood) => { ctx.beginPath(); ctx.moveTo(x - s * .05, y + s * .02); ctx.lineTo(x + s * .12, y - s * .2); ctx.lineTo(x + s * .2, y - s * .12); ctx.lineTo(x + s * .05, y + s * .06); ctx.closePath(); fill(ctx, c.body, ink);
      ctx.beginPath(); ctx.ellipse(x + s * .18, y - s * .2, s * .09, s * .06, -.1, 0, TAU); fill(ctx, c.body, ink); ctx.beginPath(); ctx.moveTo(x + s * .2, y - s * .24); ctx.lineTo(x + s * .38, y - s * .2); ctx.lineTo(x + s * .38, y - s * .16); ctx.lineTo(x + s * .22, y - s * .14); fill(ctx, c.body, ink);
      ctx.beginPath(); ctx.arc(x + s * .385, y - s * .19, s * .022, 0, TAU); ctx.fillStyle = ink; ctx.fill();
      ctx.beginPath(); ctx.moveTo(x + s * .13, y - s * .25); ctx.lineTo(x + s * .05, y - s * .3); ctx.lineTo(x + s * .12, y - s * .2); fill(ctx, c.dark, ink, 3); eye(ctx, x + s * .23, y - s * .22, s * .025, ink, mood); } }, mood),
  cheetah: (ctx, s, f, c, ink, mood) => quad(ctx, s, f, c, ink, {leg: .48, bh: .34, bl: 1.05, lw: .06, swing: 1.4, chest: .2, tuck: -.25,
    pattern: (ctx, x, y, w, h, s) => { const r = rng(4); ctx.fillStyle = '#2a1c12'; for (let i = 0; i < 26; i++) { ctx.beginPath(); ctx.arc(x + r() * w, y + r() * h, s * .018, 0, TAU); ctx.fill(); } },
    tail: (ctx, x, y, s, f) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x - s * .3, y + s * .05, x - s * .5, y + s * .1, x - s * .62, y - s * .08 + f * s * .05); ctx.lineWidth = s * .045 + 4; ctx.strokeStyle = ink; ctx.stroke(); ctx.lineWidth = s * .045; ctx.strokeStyle = c.body; ctx.stroke(); ctx.setLineDash([6, 8]); ctx.strokeStyle = '#2a1c12'; ctx.stroke(); ctx.setLineDash([]); },
    head: (ctx, x, y, s, f, c, ink, mood) => { ctx.beginPath(); ctx.ellipse(x + s * .14, y - s * .1, s * .11, s * .085, 0, 0, TAU); fill(ctx, c.body, ink); ctx.beginPath(); ctx.arc(x + s * .1, y - s * .18, s * .03, 0, TAU); fill(ctx, c.body, ink, 3);
      ctx.beginPath(); ctx.moveTo(x + s * .2, y - s * .1); ctx.quadraticCurveTo(x + s * .2, y - s * .03, x + s * .23, y - s * .02); ctx.lineWidth = 3; ctx.strokeStyle = '#2a1c12'; ctx.stroke(); eye(ctx, x + s * .19, y - s * .13, s * .024, ink, mood); ctx.beginPath(); ctx.arc(x + s * .25, y - s * .08, s * .02, 0, TAU); ctx.fillStyle = ink; ctx.fill(); } }, mood),
  horse: (ctx, s, f, c, ink, mood) => quad(ctx, s, f, c, ink, {leg: .48, bh: .38, bl: .95, lw: .07, swing: 1.2, chest: .12, tuck: -.02, hoof: '#1d1d26',
    tail: (ctx, x, y, s, f) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x - s * .25, y - s * .05, x - s * .35, y + s * .15, x - s * .4, y + s * .3 - f * s * .05); ctx.lineWidth = s * .09; ctx.strokeStyle = ink; ctx.stroke(); },
    head: (ctx, x, y, s, f, c, ink, mood) => { ctx.beginPath(); ctx.moveTo(x - s * .1, y + s * .05); ctx.lineTo(x + s * .12, y - s * .38); ctx.lineTo(x + s * .26, y - s * .32); ctx.lineTo(x + s * .12, y + s * .08); ctx.closePath(); fill(ctx, c.body, ink);
      ctx.beginPath(); ctx.moveTo(x + s * .1, y - s * .4); ctx.lineTo(x + s * .42, y - s * .28); ctx.lineTo(x + s * .42, y - s * .2); ctx.lineTo(x + s * .22, y - s * .22); ctx.closePath(); fill(ctx, c.body, ink);
      ctx.beginPath(); ctx.moveTo(x + s * .14, y - s * .4); ctx.lineTo(x + s * .12, y - s * .5); ctx.lineTo(x + s * .19, y - s * .41); fill(ctx, c.body, ink, 3);
      ctx.beginPath(); ctx.moveTo(x + s * .12, y - s * .4); ctx.quadraticCurveTo(x - s * .05, y - s * .25, x - s * .12, y + s * .02); ctx.lineWidth = s * .06; ctx.strokeStyle = ink; ctx.stroke(); eye(ctx, x + s * .22, y - s * .34, s * .022, ink, mood); } }, mood),
  antelope: (ctx, s, f, c, ink, mood) => quad(ctx, s, f, c, ink, {leg: .52, bh: .34, bl: .85, lw: .055, swing: 1.3, chest: .1, tuck: -.05, hoof: '#1d1d26',
    pattern: (ctx, x, y, w, h) => { ctx.fillStyle = '#fff5e6'; ctx.fillRect(x, y + h * .78, w, h * .3); ctx.fillRect(x, y, w * .14, h); },
    tail: (ctx, x, y, s) => { ctx.beginPath(); ctx.ellipse(x - s * .03, y + s * .04, s * .05, s * .035, 0, 0, TAU); fill(ctx, '#fff', ink, 3); },
    head: (ctx, x, y, s, f, c, ink, mood) => { ctx.beginPath(); ctx.moveTo(x - s * .04, y + s * .04); ctx.lineTo(x + s * .08, y - s * .24); ctx.lineTo(x + s * .16, y - s * .2); ctx.lineTo(x + s * .06, y + s * .06); fill(ctx, c.body, ink);
      ctx.beginPath(); ctx.ellipse(x + s * .17, y - s * .25, s * .1, s * .055, .25, 0, TAU); fill(ctx, c.body, ink); ctx.fillStyle = '#fff5e6'; ctx.fillRect(x + s * .02, y - s * .1, s * .08, s * .05);
      ctx.lineWidth = s * .03; ctx.strokeStyle = '#1d1d26'; ctx.beginPath(); ctx.moveTo(x + s * .12, y - s * .3); ctx.quadraticCurveTo(x + s * .1, y - s * .48, x + s * .2, y - s * .5); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x + s * .125, y - s * .4); ctx.lineTo(x + s * .18, y - s * .4); ctx.stroke(); eye(ctx, x + s * .17, y - s * .27, s * .02, ink, mood); } }, mood),
  bear: (ctx, s, f, c, ink, mood) => quad(ctx, s, f, c, ink, {leg: .34, bh: .42, bl: 1.0, lw: .12, swing: .7, chest: .1, tuck: .05, hump: .25,
    head: (ctx, x, y, s, f, c, ink, mood) => { ctx.beginPath(); ctx.ellipse(x + s * .12, y + s * .02, s * .17, s * .14, .1, 0, TAU); fill(ctx, c.body, ink);
      ctx.beginPath(); ctx.ellipse(x + s * .29, y + s * .06, s * .08, s * .06, 0, 0, TAU); fill(ctx, '#c49a6c', ink, 3); ctx.beginPath(); ctx.arc(x + s * .36, y + s * .04, s * .025, 0, TAU); ctx.fillStyle = ink; ctx.fill();
      for (const dx of [.02, .14]) { ctx.beginPath(); ctx.arc(x + s * dx, y - s * .11, s * .05, 0, TAU); fill(ctx, c.body, ink, 3); } eye(ctx, x + s * .2, y - s * .02, s * .025, ink, mood); } }, mood),
  elephant: (ctx, s, f, c, ink, mood) => quad(ctx, s, f, c, ink, {leg: .4, bh: .5, bl: 1.05, lw: .16, swing: .45, chest: .02, tuck: .08,
    tail: (ctx, x, y, s) => { ctx.beginPath(); ctx.moveTo(x, y + s * .05); ctx.lineTo(x - s * .1, y + s * .3); ctx.lineWidth = 6; ctx.strokeStyle = ink; ctx.stroke(); },
    head: (ctx, x, y, s, f, c, ink, mood) => { ctx.beginPath(); ctx.ellipse(x + s * .14, y - s * .02, s * .2, s * .22, 0, 0, TAU); fill(ctx, c.body, ink);
      ctx.beginPath(); ctx.moveTo(x + s * .27, y + s * .02); ctx.bezierCurveTo(x + s * .42, y + s * .15, x + s * .36, y + s * .4, x + s * .46 + f * s * .03, y + s * .5); ctx.lineWidth = s * .09 + 5; ctx.strokeStyle = ink; ctx.stroke(); ctx.lineWidth = s * .09; ctx.strokeStyle = c.body; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + s * .22, y + s * .12); ctx.quadraticCurveTo(x + s * .34, y + s * .2, x + s * .4, y + s * .12); ctx.lineWidth = s * .035 + 3; ctx.strokeStyle = ink; ctx.stroke(); ctx.lineWidth = s * .035; ctx.strokeStyle = '#fff8e6'; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(x + s * .02, y, s * .16, s * .2, -.2 + f * .08, 0, TAU); fill(ctx, c.dark, ink); eye(ctx, x + s * .22, y - s * .07, s * .025, ink, mood); } }, mood),
  giraffe: (ctx, s, f, c, ink, mood) => quad(ctx, s * .62, f, c, ink, {leg: .85, bh: .34, bl: .8, lw: .06, swing: .8, chest: .05, tuck: -.05, withers: .15, hoof: '#1d1d26',
    pattern: (ctx, x, y, w, h, s) => { const r = rng(7); ctx.fillStyle = '#a8612a'; for (let i = 0; i < 12; i++) { ctx.beginPath(); ctx.roundRect?.(x + r() * w, y + r() * h, s * .12, s * .09, 4); if (!ctx.roundRect) ctx.rect(x + r() * w, y + r() * h, s * .12, s * .09); ctx.fill(); } },
    tail: (ctx, x, y, s) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - s * .12, y + s * .35); ctx.lineWidth = 4; ctx.strokeStyle = ink; ctx.stroke(); },
    head: (ctx, x, y, s, f, c, ink, mood) => { const nx = x + s * .35, ny = y - s * 1.0;
      ctx.beginPath(); ctx.moveTo(x - s * .06, y + s * .05); ctx.lineTo(nx - s * .05, ny); ctx.lineTo(nx + s * .06, ny + s * .04); ctx.lineTo(x + s * .14, y + s * .12); ctx.closePath(); fill(ctx, c.body, ink);
      ctx.save(); ctx.clip(); ctx.fillStyle = '#a8612a'; for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(lerp(x, nx, i / 6), lerp(y, ny, i / 6) + s * .02, s * .04, 0, TAU); ctx.fill(); } ctx.restore();
      ctx.beginPath(); ctx.ellipse(nx + s * .08, ny - s * .02, s * .13, s * .07, .3, 0, TAU); fill(ctx, c.body, ink);
      for (const dx of [-.02, .04]) { ctx.beginPath(); ctx.moveTo(nx + s * dx, ny - s * .06); ctx.lineTo(nx + s * dx, ny - s * .16); ctx.lineWidth = 4; ctx.strokeStyle = ink; ctx.stroke(); ctx.beginPath(); ctx.arc(nx + s * dx, ny - s * .17, s * .025, 0, TAU); ctx.fillStyle = ink; ctx.fill(); }
      eye(ctx, nx + s * .08, ny - s * .04, s * .03, ink, mood); } }, mood),
  hare: (ctx, s, f, c, ink, mood) => {
    // 野兔：大后腿蹬地、长耳朵黑尖、白尾团
    const hop = [0, s * .12, s * .05][f]; ctx.save(); ctx.translate(0, -hop);
    const G = [[.9, -.4, -1.2, .4], [-.2, .6, .4, -1.4], [.4, .1, -.6, -.4]][f];
    limb(ctx, s * .22, -s * .3, s * .17, s * .18, G[0], G[1], s * .05, c.dark, ink);
    ctx.beginPath(); ctx.ellipse(-s * .24, -s * .32, s * .07, s * .06, 0, 0, TAU); fill(ctx, '#fff', ink, 3);
    ctx.beginPath(); ctx.ellipse(0, -s * .34, s * .3, s * .17, -.12, 0, TAU); fill(ctx, c.body, ink);
    ctx.beginPath(); ctx.ellipse(-s * .14, -s * .26, s * .14, s * .13, 0, 0, TAU); fill(ctx, c.body, ink);
    limb(ctx, -s * .14, -s * .2, s * .14, s * .2, G[2], G[3], s * .07, c.body, ink);
    limb(ctx, s * .2, -s * .28, s * .15, s * .16, G[0] * .8, G[1], s * .05, c.body, ink);
    ctx.beginPath(); ctx.ellipse(s * .3, -s * .46, s * .12, s * .09, .2, 0, TAU); fill(ctx, c.body, ink);
    for (const [dx, rot] of [[.22, -.5], [.3, -.25]]) { ctx.save(); ctx.translate(s * dx, -s * .52); ctx.rotate(rot); ctx.beginPath(); ctx.ellipse(0, -s * .18, s * .045, s * .2, 0, 0, TAU); fill(ctx, c.body, ink, 3); ctx.beginPath(); ctx.ellipse(0, -s * .33, s * .03, s * .05, 0, 0, TAU); ctx.fillStyle = ink; ctx.fill(); ctx.restore(); }
    eye(ctx, s * .34, -s * .48, s * .028, ink, mood); ctx.beginPath(); ctx.arc(s * .42, -s * .44, s * .018, 0, TAU); ctx.fillStyle = '#e88f9a'; ctx.fill();
    ctx.restore();
  },
  kangaroo: (ctx, s, f, c, ink, mood) => {
    const hop = [s * .2, 0, s * .08][f]; ctx.save(); ctx.translate(0, -hop);
    ctx.beginPath(); ctx.moveTo(-s * .12, -s * .35); ctx.quadraticCurveTo(-s * .45, -s * .2, -s * .6, hop * .8); ctx.lineWidth = s * .08 + 5; ctx.strokeStyle = ink; ctx.stroke(); ctx.lineWidth = s * .08; ctx.strokeStyle = c.body; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(-s * .02, -s * .32, s * .17, s * .14, .3, 0, TAU); fill(ctx, c.body, ink);
    ctx.beginPath(); ctx.moveTo(-s * .02, -s * .22); ctx.lineTo(s * .12, -s * .1); ctx.lineTo(s * .3, -s * .06); ctx.lineTo(s * .3, -s * .01); ctx.lineTo(s * .05, -s * .02); ctx.closePath(); fill(ctx, c.body, ink);
    ctx.beginPath(); ctx.ellipse(s * .08, -s * .58, s * .1, s * .2, .35, 0, TAU); fill(ctx, c.body, ink);
    ctx.beginPath(); ctx.ellipse(s * .12, -s * .62, s * .05, s * .12, .35, 0, TAU); ctx.fillStyle = '#f2d2a9'; ctx.fill();
    limb(ctx, s * .12, -s * .62, s * .08, s * .08, 1.6, .6, s * .03, c.body, ink);
    ctx.beginPath(); ctx.ellipse(s * .2, -s * .8, s * .085, s * .06, .2, 0, TAU); fill(ctx, c.body, ink);
    for (const dx of [.15, .2]) { ctx.beginPath(); ctx.moveTo(s * dx, -s * .84); ctx.lineTo(s * (dx - .02), -s * .98); ctx.lineTo(s * (dx + .04), -s * .86); fill(ctx, c.body, ink, 3); }
    eye(ctx, s * .23, -s * .82, s * .02, ink, mood); ctx.beginPath(); ctx.arc(s * .285, -s * .78, s * .016, 0, TAU); ctx.fillStyle = ink; ctx.fill();
    ctx.restore();
  },
  ostrich: (ctx, s, f, c, ink, mood) => {
    const G = [[.7, -1.0, -.6, .9], [-.4, .9, .5, -.8], [.15, .2, -.15, .4]][f];
    limb(ctx, -s * .02, -s * .5, s * .27, s * .27, G[2], G[3], s * .04, '#d08a84', ink);
    ctx.beginPath(); ctx.moveTo(-s * .3, -s * .62); ctx.quadraticCurveTo(-s * .48, -s * .78, -s * .42, -s * .52); ctx.lineTo(-s * .3, -s * .58); fill(ctx, '#f6f1e6', ink, 3);
    ctx.beginPath(); ctx.ellipse(-s * .05, -s * .64, s * .28, s * .17, -.15, 0, TAU); fill(ctx, c.body, ink);
    ctx.beginPath(); ctx.ellipse(-s * .15, -s * .62, s * .1, s * .07, 0, 0, TAU); ctx.fillStyle = '#f6f1e6'; ctx.fill();
    limb(ctx, s * .04, -s * .5, s * .27, s * .27, G[0], G[1], s * .045, c.skin, ink);
    ctx.beginPath(); ctx.moveTo(s * .16, -s * .7); ctx.bezierCurveTo(s * .28, -s * .85, s * .2, -s * 1.0, s * .26, -s * 1.1); ctx.lineWidth = s * .05 + 5; ctx.strokeStyle = ink; ctx.stroke(); ctx.lineWidth = s * .05; ctx.strokeStyle = c.skin; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(s * .29, -s * 1.12, s * .06, s * .045, 0, 0, TAU); fill(ctx, c.skin, ink, 3);
    ctx.beginPath(); ctx.moveTo(s * .33, -s * 1.13); ctx.lineTo(s * .42, -s * 1.1); ctx.lineTo(s * .33, -s * 1.09); fill(ctx, '#f2c26b', ink, 2); eye(ctx, s * .3, -s * 1.13, s * .018, ink, mood);
  },
  runner: (ctx, s, f, c, ink, mood) => {
    // 通用跑者（不画真人肖像）：前倾、红背心、黑短裤
    const G = [[.9, -.2, -.8, 1.2], [-.3, 1.2, .5, .2], [.3, .4, -.3, .9]][f], A = [[-.9, -1.2], [.7, -1.4], [-.2, -1.0]][f];
    const hip = {x: 0, y: -s * .5}, neck = {x: s * .12, y: -s * .88};
    limb(ctx, hip.x, hip.y, s * .26, s * .26, G[2], G[3], s * .06, c.skin, ink);
    limb(ctx, neck.x - 4, neck.y + s * .05, s * .17, s * .15, -A[0], A[1], s * .045, c.skin, ink);
    ctx.beginPath(); ctx.moveTo(hip.x - s * .08, hip.y + s * .04); ctx.lineTo(neck.x - s * .08, neck.y); ctx.lineTo(neck.x + s * .07, neck.y + s * .02); ctx.lineTo(hip.x + s * .08, hip.y + s * .02); ctx.closePath(); fill(ctx, c.body, ink);
    ctx.beginPath(); ctx.rect(hip.x - s * .09, hip.y - s * .04, s * .18, s * .1); fill(ctx, c.dark, ink, 3);
    limb(ctx, hip.x, hip.y, s * .26, s * .26, G[0], G[1], s * .065, c.skin, ink, '#ffffff');
    limb(ctx, neck.x, neck.y + s * .05, s * .17, s * .15, A[0], A[1], s * .045, c.skin, ink);
    ctx.beginPath(); ctx.arc(neck.x + s * .06, neck.y - s * .08, s * .085, 0, TAU); fill(ctx, c.skin, ink);
    ctx.beginPath(); ctx.arc(neck.x + s * .05, neck.y - s * .12, s * .087, Math.PI * 1.05, Math.PI * 1.95); ctx.lineWidth = s * .03; ctx.strokeStyle = c.dark; ctx.stroke();
    eye(ctx, neck.x + s * .1, neck.y - s * .08, s * .018, ink, mood);
  },
};
export const SHAPE_SCALE = {runner: 1, elephant: 1.05, bear: .9, giraffe: 1.35, dog: .85, kangaroo: 1, ostrich: 1.05, horse: 1.05, hare: .75, antelope: .95, cheetah: .85};
export function animal(ctx, shape, x, ground, size, f, mood = 'run') {
  const draw = ANIMALS[shape] || ANIMALS.dog, c = PAL[shape] || PAL.dog;
  ctx.save(); ctx.translate(x, ground); draw(ctx, size * (SHAPE_SCALE[shape] || 1), f % 3, c, '#0b0a12', mood); ctx.restore();
}
export const ANIMAL_SHAPES = Object.keys(ANIMALS);

/* ---------------- 速度对比 ---------------- */
export const compare = {
  bike: (p, e) => chargePose(p, propGeom(e, {hRatio: .9, wRatio: 1}), {wheelie: .1}),
  draw(ctx, p, e) {
    const W = e.world, c = e.compare;
    if (!c) return;
    const g = propGeom(e, {hRatio: .9, wRatio: 1}), size = g.h * .72, base = e.ground + e.ppu * .05, k = beat(p, 'climax'), a = beat(p, 'after');
    const f = frame3(p, p < .46 ? 9 : 5);
    let x = g.cx, mood = 'run';
    if (p < .2) x = lerp(e.W + size, g.cx, easeOut(seg(p, 0, .2)));
    if (p >= .46) { mood = 'surprised'; x = g.cx - easeIn(seg(p, .52, 1)) * (g.cx + size * 1.4); }
    if (charging(p)) ghosts(ctx, e, 3, 28, .26);
    if (impactFrame(ctx, e, k, 'compare', x, base - size * .5)) return;
    speedLinesLocal(ctx, {x: x - size * 1.1, y: base - size * .9, w: size * .8, h: size * .8}, p, {n: 9, color: W.line, seed: e.seed + 2, alpha: .6});
    ctx.save(); ctx.translate(x, base); ctx.scale(1 - a * .25, 1 - a * .25); animal(ctx, c.shape, 0, 0, size, f, mood); ctx.restore();
    // 惊讶：问号 + 汗滴
    if (p >= .46 && p < .92) {
      const hx = x + size * .2, hy = base - size * 1.05 * (SHAPE_SCALE[c.shape] || 1);
      text(ctx, '?!', hx + size * .25, hy, size * .3, {fill: '#fff', ink: W.ink, stroke: .16});
      ctx.fillStyle = '#9ad8ff'; ctx.strokeStyle = W.ink; ctx.lineWidth = 2.5;
      for (const [dx, dy] of [[-.1, .05], [.45, .25]]) { const sx = hx + size * dx, sy = hy + size * dy; ctx.beginPath(); ctx.moveTo(sx, sy - 12); ctx.quadraticCurveTo(sx + 9, sy + 4, sx, sy + 8); ctx.quadraticCurveTo(sx - 9, sy + 4, sx, sy - 12); ctx.fill(); ctx.stroke(); }
    }
    // 主文字：并跑时“XX 在旁边！”，超越时“你已超过 XX！”
    const ty = Math.max(e.zones.title.y + 26, g.top - 6);
    if (p > .1 && p < .46) e.say(`${c.name} 来比赛了！`, e.stage.x + e.stage.w * .5, ty, e.big * .16, {prio: 1, fill: '#fff'});
    if (p >= .46 && p < .97) e.say(`你已超过 ${c.name}！`, e.stage.x + e.stage.w * .5, ty, e.big * .2 * back(seg(k, 0, .5)), {prio: 2, fill: W.y});
    // 注释（对白框缩小）：约值 + 口径 + 来源标注
    const z = e.zones.note, s2 = back(seg(p, .48, .62));
    if (s2 > 0 && z.w > 120) {
      const bw = Math.min(z.w, 300 * Math.max(1, e.unit * .8)), bh = 58, bx = z.x + (z.w - bw), by = e.landscape ? z.y : e.H - 150;
      ctx.save(); ctx.translate(bx + bw / 2, by + bh / 2); ctx.scale(s2, s2); ctx.translate(-bw / 2, -bh / 2);
      bubble(ctx, 0, 0, bw, bh, 20, bh + 14, W, {fill: '#fff8e0', lw: 3});
      text(ctx, `${c.name} ${approxLabel(c)}`, 12, 18, 16, {fill: W.ink, ink: '#fff8e0', align: 'left', stroke: .02, maxWidth: bw - 24});
      text(ctx, `${c.basis.slice(0, 20)} · 趣味对比 · 约值`, 12, 41, 12, {fill: '#6a5a44', ink: '#fff8e0', align: 'left', stroke: .01, maxWidth: bw - 24});
      ctx.restore();
    }
  },
};
