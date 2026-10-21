/* 漫画/游戏类剧目：分镜三连、编辑盖章、成就解锁、趣味弹幕、烟花写字；以及叠加层：
 * 说明标签、今日新高、100 km/h 大事件横幅、回归（再次突破）简化版。 */
import {rng, clamp01, seg, beat, easeOut, easeIn, easeInOut, back, lerp, TAU, text, num, paper, burst, confetti, rings, count, halftone, impactFrame, inkHand, focus, bubble} from './common.js';
import {tracePath} from '../../core/geometry.js';
import {drawSmoke} from '../fx.js';

/* ---------------- 分镜三连：仪表 → 车头灯 → 后轮，格子占满主舞台，后两格是真实车画面特写 ---------------- */
function crop(ctx, e, name, zoom, poly, b) {
  if (!e.bikeImage) return;
  const k = e.bikeImage.width / e.W, pt = e.point(name), sw = b.w / zoom, sh = b.h / zoom;
  ctx.drawImage(e.bikeImage, (pt.x - sw / 2) * k, (pt.y - sh / 2) * k, sw * k, sh * k, b.x, b.y, b.w, b.h);
}
export const triplePanel = {
  bike: p => ({shake: p >= .44 && p < .56 ? 1.2 : .3, pitch: p >= .6 ? -.2 * Math.sin(beat(p, 'after') * Math.PI) : 0, dz: p >= .6 ? .25 * Math.sin(beat(p, 'after') * Math.PI) : 0}),
  draw(ctx, p, e) {
    const W = e.world, st = e.stage, g = 10, top = e.landscape ? 30 : st.y + 58, bot = e.landscape ? e.H - 44 : e.H - 70, H2 = bot - top;
    const cells = e.landscape
      ? [{x: st.x + 8, y: top, w: st.w * .5 - 8, h: H2 * .56}, {x: st.x + st.w * .5 + g, y: top, w: st.w * .5 - g - 8, h: H2 * .56}, {x: st.x + 8, y: top + H2 * .56 + g, w: st.w - 16, h: H2 * .44 - g}]
      : [{x: 8, y: top, w: e.W * .5 - 12, h: H2 * .46}, {x: e.W * .5 + 4, y: top, w: e.W * .5 - 12, h: H2 * .46}, {x: 8, y: top + H2 * .46 + g, w: e.W - 16, h: H2 * .54 - g}];
    const starts = [0, .2, .4], a = beat(p, 'after');
    cells.forEach((b0, i) => {
      const q = seg(p, starts[i], starts[i] + .1);
      if (q <= 0) return;
      // 余韵：三格分别向外滑出
      const out = easeIn(seg(a, i * .1, .5 + i * .1)), dx = (i === 0 ? -1 : i === 1 ? 1 : 0) * out * e.W * .6, dy = (i === 2 ? 1 : 0) * out * e.H * .6;
      const slide = (1 - easeOut(q)) * (i % 2 ? 1 : -1) * b0.w * .4;
      const b = {x: b0.x + slide + dx, y: b0.y + dy, w: b0.w, h: b0.h};
      const poly = [[b.x + 12, b.y], [b.x + b.w, b.y], [b.x + b.w - 12, b.y + b.h], [b.x, b.y + b.h]];
      ctx.save(); tracePath(ctx, poly); ctx.clip();
      ctx.fillStyle = i === 0 ? W.paper : W.sky[1]; ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.globalAlpha = .55; halftone(ctx, b.x, b.y, b.w, b.h, i === 0 ? W.m : W.accent, Math.max(7, b.w * .04), (px, py) => clamp01(Math.hypot(px - b.x - b.w / 2, py - b.y - b.h / 2) / (b.w * .55))); ctx.globalAlpha = 1;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2, R = Math.min(b.w, b.h) * .44;
      if (i === 0) {
        // 仪表：刻度 + 指针扫到阈值刻度（阈值是标签，不是读数）
        const oy = cy + R * .35;
        ctx.lineWidth = 8; ctx.strokeStyle = W.ink; ctx.beginPath(); ctx.arc(cx, oy, R, Math.PI, TAU); ctx.stroke();
        for (let k = 0; k <= 12; k++) { const ang = Math.PI + k / 12 * Math.PI; ctx.beginPath(); ctx.moveTo(cx + Math.cos(ang) * R * .8, oy + Math.sin(ang) * R * .8); ctx.lineTo(cx + Math.cos(ang) * R, oy + Math.sin(ang) * R); ctx.lineWidth = k === 9 ? 10 : 4; ctx.strokeStyle = k === 9 ? W.m : W.ink; ctx.stroke(); }
        const ang = Math.PI + lerp(.12, .75, easeOut(seg(p, .02, .2))) * Math.PI;
        ctx.lineWidth = 9; ctx.strokeStyle = W.ink; ctx.beginPath(); ctx.moveTo(cx, oy); ctx.lineTo(cx + Math.cos(ang) * R * .92, oy + Math.sin(ang) * R * .92); ctx.stroke();
        ctx.lineWidth = 5; ctx.strokeStyle = W.m; ctx.stroke(); ctx.beginPath(); ctx.arc(cx, oy, 10, 0, TAU); ctx.fillStyle = W.ink; ctx.fill();
        num(ctx, e.thText, cx, oy - R * .32, R * .55, {fill: W.y, ghost: [W.c, W.m]});
      } else {
        crop(ctx, e, i === 1 ? 'headlight' : 'rearAxle', i === 1 ? 2.4 : 1.7, poly, b);
        if (i === 1) { ctx.save(); ctx.globalAlpha = .75; ctx.fillStyle = '#fff7c2'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(b.x + b.w + 20, b.y - 10); ctx.lineTo(b.x + b.w + 20, b.y + b.h + 10); ctx.closePath(); ctx.fill(); ctx.restore(); }
        else for (let k = 0; k < 5; k++) drawSmoke(ctx, b.x + b.w * (.12 + k * .07), b.y + b.h * (.62 - k * .06), b.h * (.18 + k * .05), {seed: e.seed + k + Math.floor(p * 12), ink: W.ink});
      }
      if (i === 2) impactFrame(ctx, e, beat(p, 'climax'), 'triple', cx, cy) && (num(ctx, e.thText, cx, cy, b.h * .7, {fill: W.ink, ink: W.paper}));
      ctx.restore();
      tracePath(ctx, poly); ctx.lineWidth = 7; ctx.strokeStyle = W.ink; ctx.stroke();
      if (i === 1 && p < .62) e.say('FLASH!', b.x + b.w * .62, b.y + b.h * .24, b.h * .3, {prio: 1, free: true});
      if (i === 2 && p < .7) e.say('SKRRR!!', b.x + b.w * .66, b.y + b.h * .32, b.h * .42 * back(seg(p, .4, .5)), {prio: 2, free: true, fill: '#fff'});
    });
  },
};

/* ---------------- 编辑盖章：纸签甩出 → 大手压下（影子变大）→ “啪”盖印 + 震动 + 墨点 → 手抬走，印章留 ---------------- */
export const stamp = {
  bike: p => ({squash: p >= .4 && p < .5 ? .88 : 1, shake: p >= .4 && p < .5 ? 1.4 : 0, dy: p >= .4 && p < .5 ? -.03 : 0}),
  draw(ctx, p, e) {
    const W = e.world, st = e.stage, slam = .4, lift = [.5, .6];
    // 竖屏：车占下半屏，认证单放在车下方的路面带（按带高），印章与“认证中”都看得见、不压车。
    const band = e.zones.title;
    const cw = e.landscape ? Math.min(st.w * .62, e.H * .82) : e.W * .82, ch = e.landscape ? e.H * .5 : Math.max(60, band.h - 6);
    const cx = e.landscape ? st.x + st.w * .45 : e.W * .5, cy = e.landscape ? e.H * .38 : band.y + band.h / 2;
    // 纸签：从左下甩入、旋转落定
    const q = back(seg(p, 0, .2)), rot = lerp(-.6, -.05, q);
    ctx.save(); ctx.translate(lerp(-cw, cx, q), cy); ctx.rotate(rot);
    paper(ctx, -cw / 2, -ch / 2, cw, ch, W, {fill: '#fff8e6', dots: W.c, lw: 5});
    text(ctx, '速度认证单', -cw / 2 + 18, -ch / 2 + ch * .14, ch * .13, {fill: W.ink, ink: '#fff8e6', align: 'left', stroke: .02});
    ctx.strokeStyle = 'rgba(11,10,18,.35)'; ctx.lineWidth = 2;
    for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(-cw / 2 + 18, -ch / 2 + ch * (.28 + i * .17)); ctx.lineTo(cw / 2 - 18, -ch / 2 + ch * (.28 + i * .17)); ctx.stroke(); }
    text(ctx, 'MOTUO 编辑部', cw / 2 - 16, ch / 2 - ch * .1, ch * .08, {fill: '#6a5a44', ink: '#fff8e6', align: 'right', stroke: .01});
    const R = Math.min(cw, ch) * .36;
    // 手的影子
    if (p < slam) { const sh = easeIn(seg(p, .15, slam)); ctx.save(); ctx.globalAlpha = .35 * sh; ctx.fillStyle = W.ink; ctx.beginPath(); ctx.ellipse(0, 0, R * (1.6 - sh * .5), R * (.9 - sh * .2), 0, 0, TAU); ctx.fill(); ctx.restore(); }
    // 印章：红色在纸色底上，清楚可读
    if (p >= slam) {
      const pop = 1 + .12 * (1 - easeOut(seg(p, slam, slam + .06))), wob = Math.sin((p - slam) * 40) * .01 * (1 - seg(p, slam, .7));
      ctx.save(); ctx.rotate(-.14 + wob); ctx.scale(pop, pop);
      ctx.strokeStyle = '#d7262b'; ctx.lineWidth = R * .1; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke();
      ctx.lineWidth = R * .04; ctx.beginPath(); ctx.arc(0, 0, R * .8, 0, TAU); ctx.stroke();
      text(ctx, `${e.thText} KM/H`, 0, -R * .16, R * .38, {font: 'MotuoNum, MotuoDisplay, sans-serif', fill: '#d7262b', stroke: 0, maxWidth: R * 1.5});
      text(ctx, '达成', 0, R * .36, R * .4, {fill: '#d7262b', stroke: 0});
      const rnd = rng(e.seed + 9); ctx.fillStyle = '#d7262b';
      for (let i = 0; i < count(e, 18); i++) { const a = rnd() * TAU, d = R * (1.08 + rnd() * .5) * easeOut(seg(p, slam, slam + .08)); ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, 2 + rnd() * 7, 0, TAU); ctx.fill(); }
      ctx.restore();
    }
    ctx.restore();
    if (p >= slam) impactFrame(ctx, e, seg(p, slam, slam + .12), 'stamp', cx, cy);
    // 大手：从画外砸下 → 停 → 抬走
    const hs = ch * .62 * (e.landscape ? 1 : 1.1), down = easeIn(seg(p, .14, slam)), up = easeIn(seg(p, lift[0], lift[1]));
    const hy = lerp(-hs * .3, cy, down) - up * (cy + hs * .2), hx = cx + 6;
    if (up < 1) inkHand(ctx, hx, hy, hs, W, {sleeve: W.c});
    if (p >= slam && p < .62) e.say('啪！', cx + cw * .34, e.landscape ? Math.max(e.zones.title.y + 20, cy - ch * .62) : e.zones.note.y + e.zones.note.h / 2, (e.landscape ? ch * .5 : Math.min(ch * .7, 64)) * back(seg(p, slam, slam + .1)), {prio: 2, fill: W.y, free: true});
    else if (p > .05 && p < slam) e.say('认证中……', cx, cy + ch * .12, ch * .16, {prio: 1, fill: W.ink, ink: '#fff8e6', ghost: null, stroke: .04, free: true});
  },
};

/* ---------------- 成就解锁（游戏）：大卡片 + 旋转光芒 + 等级条 + LEVEL UP，最后缩成徽章飞走 ---------------- */
export const achievement = {
  bike: p => ({pitch: p >= .46 && p < .9 ? -.24 * Math.sin(seg(p, .46, .9) * Math.PI) : 0, shake: p >= .46 && p < .54 ? .8 : 0}),
  draw(ctx, p, e) {
    const W = e.world, st = e.stage, bw = e.landscape ? Math.min(st.w * .9, 520 * e.unit) : e.W * .92, bh = e.landscape ? e.H * .3 : Math.min(140, st.h * .3);
    const cx0 = e.landscape ? st.x + st.w * .5 : e.W / 2, cy0 = e.landscape ? e.H * .48 : st.y + 64 + bh / 2;
    const inQ = back(seg(p, 0, .2)), fly = easeIn(beat(p, 'after') > .5 ? seg(p, .8, 1) : 0);
    const cx = lerp(cx0, 120, fly), cy = lerp(cy0 - (1 - inQ) * (e.H * .7), 60, fly), sc = lerp(1, .2, fly);
    // 光芒
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(p * 1.5); ctx.globalAlpha = .35 * inQ * (1 - fly);
    for (let i = 0; i < 16; i++) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, bw * .75, i / 16 * TAU, (i + .5) / 16 * TAU); ctx.closePath(); ctx.fillStyle = i % 2 ? W.y : W.c; ctx.fill(); }
    ctx.restore();
    ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-bw / 2, -bh / 2);
    ctx.fillStyle = W.ink; ctx.beginPath(); ctx.roundRect?.(8, 8, bw, bh, 18); ctx.fill();
    ctx.fillStyle = '#1b1530'; ctx.strokeStyle = '#ffcf3a'; ctx.lineWidth = 7; ctx.beginPath(); ctx.roundRect?.(0, 0, bw, bh, 18); if (!ctx.roundRect) ctx.rect(0, 0, bw, bh); ctx.fill(); ctx.stroke();
    // 奖杯
    const ix = bh * .5, iy = bh * .52, r = bh * .34;
    ctx.fillStyle = '#ffcf3a'; ctx.strokeStyle = W.ink; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(ix - r * .7, iy - r * .75); ctx.lineTo(ix + r * .7, iy - r * .75); ctx.quadraticCurveTo(ix + r * .62, iy + r * .25, ix, iy + r * .32); ctx.quadraticCurveTo(ix - r * .62, iy + r * .25, ix - r * .7, iy - r * .75); ctx.fill(); ctx.stroke();
    ctx.fillRect(ix - r * .12, iy + r * .3, r * .24, r * .32); ctx.beginPath(); ctx.rect(ix - r * .5, iy + r * .6, r, r * .18); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 6; ctx.strokeStyle = '#ffcf3a'; ctx.beginPath(); ctx.arc(ix - r * .72, iy - r * .38, r * .3, Math.PI * .5, Math.PI * 1.5); ctx.stroke(); ctx.beginPath(); ctx.arc(ix + r * .72, iy - r * .38, r * .3, -Math.PI * .5, Math.PI * .5); ctx.stroke();
    text(ctx, '成就解锁 · 游戏', bh + 6, bh * .2, bh * .14, {fill: '#ffcf3a', ink: '#1b1530', align: 'left', stroke: .02});
    text(ctx, e.title, bh + 4, bh * .5, bh * .34, {fill: '#ffffff', ink: '#1b1530', ghost: [W.c, W.m], align: 'left', stroke: .06, maxWidth: bw - bh - 24});
    const lv = Math.min(5, e.tier), fillQ = easeOut(seg(p, .26, .46));
    ctx.fillStyle = '#3a3158'; ctx.fillRect(bh + 4, bh * .76, bw - bh - 26, 14);
    ctx.fillStyle = W.c; ctx.fillRect(bh + 4, bh * .76, (bw - bh - 26) * fillQ, 14);
    text(ctx, `Lv.${lv - 1} → Lv.${lv}`, bw - 22, bh * .64, bh * .13, {fill: W.y, ink: '#1b1530', align: 'right', stroke: .02});
    if (p >= .46) { const s = back(seg(p, .46, .56)); ctx.save(); ctx.translate(bw - 30, -6); ctx.rotate(.18); ctx.scale(s, s); burst(ctx, 0, 0, bh * .38, 12, '#ff4a3d', W.ink, e.seed); text(ctx, 'LEVEL', 0, -bh * .07, bh * .14, {fill: '#fff', ink: W.ink}); text(ctx, 'UP!', 0, bh * .1, bh * .17, {fill: W.y, ink: W.ink}); ctx.restore(); }
    ctx.restore();
    if (p >= .46) impactFrame(ctx, e, beat(p, 'climax'), 'achieve', cx, cy) && null;
    // 星屑余韵
    const rnd = rng(e.seed + 4), q = seg(p, .46, 1);
    if (q > 0) for (let i = 0; i < count(e, 30); i++) { const a = rnd() * TAU, d = easeOut(q) * (80 + rnd() * 220) * e.unit; const sx = cx0 + Math.cos(a) * d, sy = cy0 + Math.sin(a) * d * .6 + q * q * 80; ctx.save(); ctx.translate(sx, sy); ctx.rotate(q * 6 + i); ctx.globalAlpha = 1 - q; ctx.fillStyle = i % 2 ? '#ffcf3a' : '#fff'; ctx.beginPath(); for (let k = 0; k < 8; k++) { const rr = k % 2 ? 3 : 9; ctx.lineTo(Math.cos(k / 8 * TAU) * rr, Math.sin(k / 8 * TAU) * rr); } ctx.closePath(); ctx.fill(); ctx.restore(); }
  },
};

/* ---------------- 趣味弹幕：密集（≥20 条、4–6 条轨道），个别彩色描边大字 ---------------- */
const DANMAKU = ['前方高能！', '这也太快了', '+1', '稳住别浪', '起飞！', '666', '注意安全哦', '冲冲冲', '好帅', '名场面', '车神附体', '风好大', '这速度可以', '帅到我了', '慢点慢点', '截图了', 'awsl', '我也想骑', '太丝滑了', '爷青回', '燃起来了', '前排围观', '速度与激情', '好家伙'];
export const danmaku = {
  bike: p => ({dy: .02 * Math.abs(Math.sin(p * 30)), shake: .25}),
  draw(ctx, p, e) {
    const W = e.world, rnd = rng(e.seed + 21), lanes = e.landscape ? 6 : 5;
    const top = e.landscape ? 104 : e.stage.y + 70, bottom = e.landscape ? e.H - 70 : e.H - 110, n = Math.max(22, count(e, 26));
    const density = p < .26 ? .45 : p < .9 ? 1 : .55;
    for (let i = 0; i < n; i++) {
      if (rnd() > density + .25) { rnd(); rnd(); rnd(); continue; }
      const lane = i % lanes, y = lerp(top, bottom, lane / (lanes - 1)), delay = rnd() * .55, v = .8 + rnd() * .9;
      const msg = DANMAKU[Math.floor(rnd() * DANMAKU.length)], q = seg(p, delay, delay + .5 / v);
      if (q <= 0 || q >= 1) continue;
      const size = (e.landscape ? 22 : 19) * (rnd() < .25 ? 1.45 : 1) * Math.max(1, e.unit * .9);
      const x = lerp(e.W + 20, -size * msg.length * 1.1, q);
      text(ctx, msg, x, y + (lane % 2 ? 6 : 0), size, {fill: [W.y, '#ffffff', W.c, W.m, '#9dff8a'][i % 5], ink: W.ink, align: 'left', stroke: .16});
    }
    // 爆点：彩色描边大字“前方高能!!!”从中间轨道穿过（主文字）
    const big = seg(p, .38, .92);
    if (big > 0 && big < 1) {
      // 竖屏：中间轨道正好是车身，大字改走车下方的路面带
      const y = e.landscape ? lerp(top, bottom, .5) : e.zones.title.y + e.zones.title.h / 2, size = e.landscape ? e.big * .3 : Math.min(e.big * .22, e.zones.title.h * .7), x = lerp(e.W + 20, -size * 6, big);
      e.say('前方高能!!!', x, y, size, {prio: 2, align: 'left', fill: '#ff3b2f', ink: '#ffffff', ghost: [W.ink, W.y], stroke: .2, free: true, rot: 0, maxWidth: 0});
    }
    ctx.save(); ctx.globalAlpha = 1 - seg(p, .92, 1);
    const lx = e.landscape ? e.zones.note.x : 10, ly = e.landscape ? e.zones.note.y + 60 : e.H - 96;
    ctx.fillStyle = W.ink; ctx.fillRect(lx, ly, 176, 24);
    text(ctx, '趣味弹幕 · 非真实用户', lx + 8, ly + 12, 14, {fill: '#fff', ink: W.ink, align: 'left', stroke: .01});
    ctx.restore();
  },
};

/* ---------------- 烟花写字：多发礼花升空 → 炸开 → 火花点阵拼出数字 → 下坠消散 ---------------- */
const glyphCache = new Map();
function glyphPoints(s) {
  if (glyphCache.has(s)) return glyphCache.get(s);
  const Wc = 520, Hc = 260, c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Wc, Hc) : Object.assign(document.createElement('canvas'), {width: Wc, height: Hc});
  const g = c.getContext('2d'); g.font = '230px MotuoNum, MotuoDisplay, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#000'; g.fillText(s, Wc / 2, Hc / 2 + 8);
  const d = g.getImageData?.(0, 0, Wc, Hc)?.data, pts = [];
  let minX = Wc, maxX = 0, minY = Hc, maxY = 0;
  if (d) for (let y = 0; y < Hc; y += 12) for (let x = (y / 12) % 2 ? 6 : 0; x < Wc; x += 12) if (d[(y * Wc + x) * 4 + 3] > 128) { pts.push([x, y]); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const out = {pts: pts.map(([x, y]) => [(x - minX) / w - .5, (y - minY) / h - .5]), aspect: w / h};
  glyphCache.set(s, out); return out;
}
export const fireworks = {
  bike: p => ({pitch: p >= .46 ? -.18 * Math.sin(seg(p, .46, 1) * Math.PI) : 0, shake: p >= .46 && p < .52 ? .9 : 0}),
  draw(ctx, p, e) {
    const W = e.world, st = e.stage, rnd = rng(e.seed + 31), cols = [W.y, W.c, W.m, '#ffffff'];
    const gh = e.landscape ? e.H * .42 : Math.min(e.H * .34, st.h * .6), G = glyphPoints(e.thText), gw = Math.min(gh * G.aspect, (e.landscape ? st.w : e.W) * .9), ghh = gw / G.aspect;
    const cx = e.landscape ? st.x + st.w * .52 : e.W / 2, cy = e.landscape ? e.H * .5 : st.y + 60 + ghh / 2 + 10;
    // 起：火箭升空；冲突：小礼花
    for (let k = 0; k < 3 + e.tier; k++) {
      const t0 = k * .05, rx = (e.landscape ? st.x + st.w * (.1 + rnd() * .8) : e.W * (.1 + rnd() * .8)), ry = (e.landscape ? e.H * (.08 + rnd() * .3) : st.y + 40 + rnd() * ghh), col = cols[k % 4];
      const up = seg(p, t0, t0 + .2), ex = seg(p, t0 + .2, t0 + .5);
      if (up > 0 && up < 1) { const y = lerp(e.roadTop, ry, easeOut(up)); ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(rx, y + 40); ctx.lineTo(rx, y); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.fillRect(rx - 3, y - 3, 6, 6); }
      if (ex > 0 && ex < 1) for (let i = 0; i < count(e, 26); i++) { const a = i / 26 * TAU, d = easeOut(ex) * 90 * e.unit; const px = rx + Math.cos(a) * d, py = ry + Math.sin(a) * d + ex * ex * 40; ctx.globalAlpha = 1 - ex; ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - Math.cos(a) * 14, py - Math.sin(a) * 14); ctx.stroke(); ctx.globalAlpha = 1; }
    }
    // 主礼花：中央火箭升到字心
    const mUp = seg(p, .3, .46);
    if (mUp > 0 && mUp < 1) { const y = lerp(e.roadTop, cy, easeOut(mUp)); ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(cx, y + 60); ctx.lineTo(cx, y); ctx.stroke(); }
    if (p >= .46) {
      impactFrame(ctx, e, beat(p, 'climax'), 'firework', cx, cy);
      const fly = easeOut(seg(p, .46, .58)), hold = seg(p, .58, .74), fall = seg(p, .74, 1);
      const r = Math.max(4, gh * .03);
      G.pts.forEach(([ux, uy], i) => {
        const tx = cx + ux * gw, ty = cy + uy * ghh;
        const x = lerp(cx, tx, fly), y = lerp(cy, ty, fly) + fall * fall * e.H * .45 * (.6 + (i % 7) / 10);
        const tw = (i * 7 + Math.floor(p * 40)) % 9 === 0, col = tw ? '#ffffff' : (ux < 0 ? W.y : W.c);
        ctx.globalAlpha = 1 - fall;
        if (fly < 1 || fall > 0) { ctx.strokeStyle = col; ctx.lineWidth = r * .8; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - (tx - cx) * .12 * (1 - fly), y - (ty - cy) * .12 * (1 - fly) - fall * 18); ctx.stroke(); }
        ctx.beginPath(); ctx.arc(x, y, r * (tw && hold > 0 ? 1.5 : 1) + 2.5, 0, TAU); ctx.fillStyle = W.ink; ctx.fill();
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r * (tw && hold > 0 ? 1.5 : 1), 0, TAU); ctx.fill();
      });
      ctx.globalAlpha = 1;
      if (fly >= 1 && fall < .5) text(ctx, 'KM/H', cx + gw * .42, cy + ghh * .62, ghh * .16, {fill: '#fff', ghost: [W.c, W.m], alpha: 1 - fall * 2});
    }
  },
};

/* ---------------- 叠加层 ---------------- */
export const label = {
  draw(ctx, p, e) {
    const W = e.world, a = Math.min(easeOut(seg(p, 0, .12)), 1 - seg(p, .9, 1));
    if (a <= 0) return;
    const z = e.zones.label, x = z.x, y = z.y, name = e.comeback ? '再次突破' : e.actName, tags = [e.preview ? '预览 · 非骑行数据' : e.simulated ? 'DEMO' : null, e.main === 'achievement' || e.layers?.includes('achievement') ? '游戏' : null].filter(Boolean);
    const line1 = `突破 ${e.thText} KM/H`, line2 = [name, ...tags].join(' · ');
    ctx.save(); ctx.globalAlpha = a;
    ctx.font = '15px MotuoHan, sans-serif'; const w2 = ctx.measureText(line2).width; ctx.font = '19px MotuoNum, MotuoHan, sans-serif';
    const w = Math.min(z.w, Math.max(150, w2 + 24, ctx.measureText(line1).width + 26));
    ctx.fillStyle = W.ink; ctx.fillRect(x + 4, y + 4, w, 50); ctx.fillStyle = '#ffe45c'; ctx.fillRect(x, y, w, 50); ctx.lineWidth = 3; ctx.strokeStyle = W.ink; ctx.strokeRect(x, y, w, 50);
    text(ctx, line1, x + 10, y + 16, 19, {font: 'MotuoNum, MotuoHan, sans-serif', fill: W.ink, ink: '#ffe45c', align: 'left', stroke: .02, maxWidth: w - 20});
    text(ctx, line2, x + 10, y + 38, 14, {fill: W.ink, ink: '#ffe45c', align: 'left', stroke: .02, maxWidth: w - 20});
    for (let i = 0; i < Math.min(5, e.tier); i++) { ctx.fillStyle = W.m; ctx.beginPath(); ctx.arc(x + 12 + i * 14, y + 60, 5, 0, TAU); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = W.ink; ctx.stroke(); }
    ctx.restore();
  },
};

export const newHigh = {
  draw(ctx, p, e) {
    const W = e.world, s = back(seg(p, 0, .2)) * (1 - seg(p, .9, 1));
    if (s <= 0) return;
    const z = e.zones.badge, r = Math.min(z.h * .42, z.w * .36, 70 * e.unit) * s, x = z.x + z.w / 2, y = z.y + z.h / 2;
    ctx.save(); ctx.translate(x, y); ctx.rotate(.1);
    burst(ctx, 0, 0, r * 1.25, 16, '#ffcf3a', W.ink, e.seed + 40, p * 2);
    ctx.fillStyle = '#ffe9a8'; ctx.strokeStyle = W.ink; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-r * .5, -r * .5); ctx.lineTo(-r * .3, -r * .85); ctx.lineTo(0, -r * .58); ctx.lineTo(r * .3, -r * .85); ctx.lineTo(r * .5, -r * .5); ctx.closePath(); ctx.fill(); ctx.stroke();
    text(ctx, '今日新高！', 0, -r * .05, r * .4, {fill: '#d7262b', ink: '#fff', stroke: .12, maxWidth: r * 2.1});
    text(ctx, e.simulated || e.preview ? '演示 · 不计入纪录' : '已记入今日纪录', 0, r * .42, r * .17, {fill: W.ink, ink: '#ffcf3a', stroke: .05, maxWidth: r * 2});
    ctx.restore();
  },
};

// 大事件横幅：全屏聚光灯 + 彩纸；横幅只在开场与收尾出现，期间让位给三幕剧目的主文字
export const grandBanner = {
  draw(ctx, p, e) {
    const W = e.world;
    ctx.save(); ctx.globalAlpha = .2; ctx.fillStyle = '#fff';
    for (const k of [-1, 0, 1]) { const sx = e.W * (.5 + k * .48), sw = Math.sin(p * 5 + k * 2) * e.W * .18; ctx.beginPath(); ctx.moveTo(sx - 10, 0); ctx.lineTo(sx + 10, 0); ctx.lineTo(e.W * .45 + sw + 120, e.H); ctx.lineTo(e.W * .45 + sw - 120, e.H); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    confetti(ctx, e, 0, 0, p, {n: 80, seed: e.seed + 50, rain: true});
    const show = p < .3 ? back(seg(p, 0, .1)) * (1 - seg(p, .24, .3)) : p > .8 ? back(seg(p, .8, .88)) : 0;
    if (show <= 0) return;
    const h = (e.landscape ? 70 : 56) * Math.max(1, e.unit * .85), w = e.landscape ? e.stage.w * .94 : e.W * .94;
    const cx = e.landscape ? e.stage.x + e.stage.w / 2 : e.W / 2, y = e.landscape ? e.H * .44 : e.zones.title.y + h / 2 + 4;
    ctx.save(); ctx.translate(cx, y); ctx.rotate(-.04); ctx.scale(show, show);
    ctx.fillStyle = W.ink; ctx.fillRect(-w / 2 + 8, -h / 2 + 8, w, h); ctx.fillStyle = '#d7262b'; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = '#ffcf3a'; ctx.fillRect(-w / 2, -h / 2, w, 7); ctx.fillRect(-w / 2, h / 2 - 7, w, 7);
    ctx.restore();
    e.say(`${e.thText} KM/H 大事件`, cx, y + 2, h * .62 * show, {prio: 3, free: true, fill: '#ffcf3a', ink: W.ink, ghost: [W.c, '#fff'], stroke: .1, rot: -.04});
  },
};

// 回归：减速后再次突破的简化演出
export const comeback = {
  bike: p => ({dz: .2 * Math.sin(seg(p, 0, .7) * Math.PI), pitch: -.08 * Math.sin(seg(p, .1, .7) * Math.PI)}),
  draw(ctx, p, e) {
    const W = e.world, nose = e.point('headlight');
    rings(ctx, nose.x, nose.y, p, {n: 2, maxR: e.ppu * 1.6, color: W.y, ink: W.ink, lw: 8, squash: .7});
    const s = back(seg(p, 0, .3)) * (1 - seg(p, .8, 1));
    if (s > 0) e.say(`再次突破 ${e.thText}！`, e.stage.x + e.stage.w * .45, e.landscape ? e.H * .26 : e.zones.title.y + 30, e.big * .2 * s, {prio: 2, fill: W.y});
  },
};
