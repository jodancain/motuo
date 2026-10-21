/* 镜头花活（只变换场景层，不碰速度 DOM）、数字变形（装饰用的阈值副本，不是读数）、世界专属反应。 */
import {rng, clamp01, seg, beat, easeOut, easeIn, easeInOut, back, lerp, TAU, text, num, burst, rings, count, impactFrame, ghosts, focus} from './common.js';
import {drawFlame} from '../fx.js';

/* ---------------- 希区柯克变焦：背景 1.0 → 1.42 → 1.0，车大小不变；透视线收缩 ---------------- */
const dollyK = p => (p < .5 ? easeInOut(seg(p, .04, .5)) : 1 - easeInOut(seg(p, .62, .95)));
export const dollyZoom = {
  camera: p => ({sceneScale: 1 + .6 * dollyK(p)}),
  bike: p => ({squash: 1 + .03 * dollyK(p), shake: p > .46 && p < .52 ? .6 : 0}),
  draw(ctx, p, e) {
    const W = e.world, c = e.point('tank'), z = dollyK(p);
    // 透视线：从画面四周指向车，内圈随变焦收缩（远景被“吸”过来）
    const rnd = rng(e.seed + 61), R = Math.hypot(e.W, e.H);
    ctx.save(); ctx.strokeStyle = W.line; ctx.lineCap = 'round';
    for (let i = 0; i < count(e, 48); i++) {
      const a = i / 48 * TAU + rnd() * .1, r0 = e.ppu * lerp(1.7, .9, z) * (1 + rnd() * .3), r1 = R;
      ctx.globalAlpha = .25 + .55 * z; ctx.lineWidth = 1.5 + rnd() * 3 * (1 + z);
      ctx.beginPath(); ctx.moveTo(c.x + Math.cos(a) * r0, c.y + Math.sin(a) * r0 * .7); ctx.lineTo(c.x + Math.cos(a) * r1, c.y + Math.sin(a) * r1 * .7); ctx.stroke();
    }
    ctx.restore();
    // 画框暗角向内收：强调“镜头在推”
    const inset = 30 * z * e.unit;
    ctx.save(); ctx.fillStyle = W.ink; ctx.globalAlpha = .55 * z;
    ctx.beginPath(); ctx.rect(0, 0, e.W, e.H); ctx.ellipse(c.x, c.y, e.W * .62 - inset * 2, e.H * .62 - inset, 0, 0, TAU); ctx.fill('evenodd'); ctx.restore();
    if (p > .4 && p < .7 && !e.quiet) e.say('ZOOOM', e.stage.x + e.stage.w * .5, e.landscape ? e.H * .22 : e.zones.title.y + 30, e.big * .32 * back(seg(p, .4, .52)), {prio: 2});
  },
};

/* ---------------- 甩镜：全屏横向模糊条纹 → 切到同一辆车的新机位（3/4 角度）→ 落定 ---------------- */
export const whipPan = {
  camera: p => ({panX: p < .32 ? -easeIn(p / .32) * .34 : p < .5 ? .34 * (1 - easeOut(seg(p, .32, .5))) : 0}),
  bike: p => ({yaw: p < .32 ? 0 : .55 * (1 - easeInOut(seg(p, .75, 1))), dz: p >= .32 && p < .6 ? .2 * Math.sin(seg(p, .32, .6) * Math.PI) : 0, shake: p > .3 && p < .36 ? 1 : 0}),
  draw(ctx, p, e) {
    const W = e.world, q = 1 - Math.abs(p - .32) / .18;
    if (q > 0) {
      // 横向模糊：全屏彩色拉丝 + 墨色快门条
      ctx.save(); const rnd = rng(e.seed + 71 + Math.floor(p * 24));
      ctx.globalAlpha = Math.min(.95, q * 1.2); ctx.fillStyle = W.sky[1]; ctx.fillRect(0, 0, e.W, e.H);
      for (let i = 0; i < count(e, 70); i++) { const y = rnd() * e.H, h = 2 + rnd() * 14, x = rnd() * e.W * .3; ctx.globalAlpha = q * (.4 + rnd() * .6); ctx.fillStyle = [W.line, W.c, W.m, W.y, W.ink][i % 5]; ctx.fillRect(x - e.W * .2, y, e.W * (1 + rnd()), h); }
      ctx.restore();
    }
    if (p > .32 && p < .4) impactFrame(ctx, e, seg(p, .32, .5), 'whip', e.W * .4, e.H * .5);
    // 新机位标记：分镜角标
    if (p >= .4 && p < .9) { const s = back(seg(p, .4, .5)); ctx.save(); ctx.globalAlpha = 1 - seg(p, .8, .9); ctx.fillStyle = W.ink; ctx.fillRect(e.stage.x + 14, e.landscape ? e.H - 82 : e.H - 120, 150 * s, 26); text(ctx, 'CAM 2 · 斜侧机位', e.stage.x + 22, (e.landscape ? e.H - 82 : e.H - 120) + 13, 14 * s, {fill: '#fff', ink: W.ink, align: 'left', stroke: .01}); ctx.restore(); }
    if (p > .3 && p < .7 && !e.quiet) e.say('WHOOSH!', e.stage.x + e.stage.w * .48, e.landscape ? e.H * .24 : e.zones.title.y + 30, e.big * .34 * back(seg(p, .3, .42)), {prio: 2, fill: '#fff'});
  },
};

/* ---------------- 子弹时间：世界冻结、去饱和、车身残影、时钟大字 → BANG! 恢复 ---------------- */
export const bulletTime = {
  camera: p => (p < .62 ? {timeScale: .04, desat: .75 * easeOut(seg(p, 0, .12))} : {timeScale: 1, desat: .75 * (1 - seg(p, .62, .72))}),
  bike: p => (p < .62 ? {shake: 0, squash: 1.02} : {dz: .5 * Math.sin(seg(p, .62, 1) * Math.PI), shake: p < .7 ? 1.4 : 0, squash: 1.08}),
  draw(ctx, p, e) {
    const W = e.world, c = e.point('tank');
    if (p < .62) {
      ghosts(ctx, e, 5, 34, .3);
      // 悬停的雨滴 / 碎屑
      const rnd = rng(e.seed + 81);
      for (let i = 0; i < count(e, 50); i++) { const x = rnd() * e.W, y = rnd() * e.ground; ctx.globalAlpha = .75; ctx.fillStyle = i % 3 ? '#ffffff' : W.c; ctx.fillRect(x, y, 3, 12); }
      ctx.globalAlpha = 1;
      for (let i = 0; i < 3; i++) { ctx.save(); ctx.globalAlpha = .5; ctx.strokeStyle = W.c; ctx.lineWidth = 3; ctx.setLineDash([12, 14]); ctx.lineDashOffset = -p * 200; ctx.beginPath(); ctx.ellipse(c.x, c.y, e.ppu * (1.2 + i * .45), e.ppu * (.6 + i * .25), 0, 0, TAU); ctx.stroke(); ctx.restore(); }
      if (!e.quiet) {
        // 时钟大字
        const z = e.zones.title, s = back(seg(p, .02, .14)), r = (e.landscape ? e.big * .36 : Math.min(e.big * .36, z.h * .46)) * s, x = e.landscape ? e.stage.x + e.stage.w * .56 : e.W * .24, y = e.landscape ? e.H * .45 : z.y + z.h * .5;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = W.paper; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = W.ink; ctx.stroke();
        for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * .8, y + Math.sin(a) * r * .8); ctx.lineTo(x + Math.cos(a) * r * .92, y + Math.sin(a) * r * .92); ctx.lineWidth = 3; ctx.stroke(); }
        const a = -Math.PI / 2 + p * .8; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r * .72, y + Math.sin(a) * r * .72); ctx.stroke();
        ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + r * .45, y); ctx.stroke();
        e.say('子弹时间', e.landscape ? x : x + r * 1.1 + e.big * .3, e.landscape ? y + r + e.big * .16 : y, e.big * .24, {prio: 1, fill: '#fff', free: e.landscape});
      }
    } else {
      impactFrame(ctx, e, seg(p, .62, .8), 'bullet', c.x, c.y);
      rings(ctx, c.x, c.y, seg(p, .62, 1), {n: 3, maxR: e.W * .6, color: W.y, ink: W.ink, lw: 12, squash: .7});
      if (!e.quiet) e.say('BANG!', e.stage.x + e.stage.w * .45, e.landscape ? e.H * .26 : e.zones.title.y + 30, e.big * .4 * back(seg(p, .62, .74)), {prio: 2});
    }
  },
};

/* ---------------- 数字变形：大号阈值副本居中于主舞台 ---------------- */
// 横屏：数字在主舞台中部，叫声在数字下方。竖屏：车占下半屏，数字放在车下方的路面带（按带高封顶），
// 叫声放在速度巨字与车之间的注释带；都不压车身、不出画。字号按位数封顶。
const big = e => {
  const n = Math.max(2, e.thText.length);
  if (e.landscape) { const size = Math.min(e.H * .44, e.stage.w * .9 / (n * .8)); return {x: e.stage.x + e.stage.w * .5, y: e.H * .5, size, sayY: e.H * .5 + size * .62}; }
  const band = e.zones.title, note = e.zones.note, size = Math.min(band.h / .8, e.W * .9 / (n * .8));
  return {x: e.W * .5, y: band.y + band.h * .5, size, sayY: note.y + note.h * .5};
};

export const numFire = {
  bike: p => ({pitch: p >= .46 && p < .9 ? -.12 * Math.sin(seg(p, .46, .9) * Math.PI) : 0, shake: p >= .26 && p < .6 ? .7 : 0}),
  draw(ctx, p, e) {
    const W = e.world, {x, y, size, sayY} = big(e), s = back(seg(p, 0, .18)), fire = easeOut(seg(p, .2, .46)), char = seg(p, .6, 1);
    const rnd = rng(e.seed + 91), flick = Math.floor(p * 24);
    // 车也着火：排气口长火舌
    const ex = e.point('exhaust'); if (p > .2 && p < .9) drawFlame(ctx, ex.x, ex.y, e.ppu * (.4 + fire * .5), {angle: Math.PI * .97, seed: flick, ink: W.ink});
    if (impactFrame(ctx, e, beat(p, 'climax'), 'fire', x, y)) { num(ctx, e.thText, x, y, size, {fill: W.ink, ink: W.paper}); return; }
    if (fire > 0) for (let i = 0; i < 8; i++) drawFlame(ctx, x - size * .6 + i * size * .17, y - size * .2, size * (.3 + rnd() * .3) * fire * (p >= .46 && p < .6 ? 1.5 : 1) * (1 - char * .7), {angle: -Math.PI / 2 + (rnd() - .5) * .3, seed: flick + i, ink: W.ink});
    num(ctx, e.thText, x, y, size * s, {fill: char > 0 ? lerpColor('#ff8a2a', '#3a2a22', char) : fire > .3 ? '#ff8a2a' : '#ffffff', ghost: ['#ffd23a', '#d7262b']});
    ctx.fillStyle = '#ffd23a';
    for (let i = 0; i < count(e, 30) * fire; i++) { const sx = x + (rnd() - .5) * size * 1.2, sy = y - size * .3 - ((p * 1.6 + rnd()) % 1) * size; ctx.fillRect(sx, sy, 5, 5); }
    if (p >= .46 && p < .9) e.say('燃起来了！', x, sayY, size * .2 * back(seg(p, .46, .56)), {free: !e.landscape, prio: 2, fill: '#fff'});
  },
};
function lerpColor(a, b, t) { const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16), ch = s => Math.round(lerp(pa >> s & 255, pb >> s & 255, t)); return `rgb(${ch(16)},${ch(8)},${ch(0)})`; }

export const numShatter = {
  bike: p => ({shake: p >= .46 && p < .58 ? 1.5 : 0, dz: p >= .46 && p < .7 ? .2 * Math.sin(seg(p, .46, .7) * Math.PI) : 0}),
  draw(ctx, p, e) {
    const W = e.world, {x, y, size, sayY} = big(e), rnd = rng(e.seed + 101);
    const crack = seg(p, .22, .46), out = easeOut(seg(p, .46, .62)), backQ = easeInOut(seg(p, .68, .92)), d = out * (1 - backQ);
    if (impactFrame(ctx, e, beat(p, 'climax'), 'shatter', x, y)) { num(ctx, e.thText, x, y, size, {fill: W.ink, ink: W.paper}); return; }
    if (p < .46 || p > .92) {
      num(ctx, e.thText, x, y, size * (p > .92 ? 1.06 : back(seg(p, 0, .18))), {fill: p > .92 ? '#fff' : W.y, ghost: [W.c, W.m]});
      if (crack > 0 && p < .46) { ctx.strokeStyle = W.ink; ctx.lineWidth = 4; ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = rnd() * TAU, l = size * .6 * crack * (.5 + rnd() * .5); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l * .5, y + Math.sin(a) * l * .5 + (rnd() - .5) * 10); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); } ctx.stroke(); }
      if (p > .92) rings(ctx, x, y, seg(p, .92, 1), {n: 2, maxR: size, color: W.y, ink: W.ink});
    } else {
      const cols = 7, rows = 5, cw = size * 1.4 / cols, ch = size * .95 / rows;
      for (let i = 0; i < cols * rows; i++) {
        const cx = i % cols, cy = Math.floor(i / cols), ox = x - size * .7 + cx * cw, oy = y - size * .48 + cy * ch;
        const a = Math.atan2(oy + ch / 2 - y, ox + cw / 2 - x) + (rnd() - .5) * .6, dist = (.4 + rnd()) * size * 1.3;
        ctx.save(); ctx.translate(Math.cos(a) * dist * d, Math.sin(a) * dist * d); ctx.translate(ox + cw / 2, oy + ch / 2); ctx.rotate((rnd() - .5) * 7 * d); ctx.translate(-(ox + cw / 2), -(oy + ch / 2));
        ctx.beginPath(); ctx.rect(ox, oy, cw, ch); ctx.clip(); num(ctx, e.thText, x, y, size, {fill: W.y, ghost: [W.c, W.m]}); ctx.restore();
      }
    }
    if (p >= .46 && p < .7) e.say('CRASH!', x, sayY, size * .3 * back(seg(p, .46, .56)), {free: !e.landscape, prio: 2, fill: '#fff'});
    else if (p > .74 && p < .95) e.say('重组！', x, sayY, size * .18, {free: !e.landscape, prio: 1, fill: W.y});
  },
};

export const numFreeze = {
  bike: p => ({shake: p < .46 ? .25 * seg(p, .2, .46) : p < .58 ? 1.5 : 0, squash: p >= .2 && p < .46 ? .97 : 1}),
  draw(ctx, p, e) {
    const W = e.world, {x, y, size, sayY} = big(e), rnd = rng(e.seed + 111), ice = easeOut(seg(p, .14, .44)), shatter = seg(p, .46, 1);
    if (impactFrame(ctx, e, beat(p, 'climax'), 'ice', x, y)) { num(ctx, e.thText, x, y, size, {fill: W.ink, ink: W.paper}); return; }
    if (p < .46) {
      num(ctx, e.thText, x, y, size * back(seg(p, 0, .14)), {fill: '#e8f6ff', ghost: ['#7fd0ff', '#ffffff']});
      // 车身结霜
      ctx.save(); ctx.globalAlpha = .3 * ice; ctx.fillStyle = '#cfefff'; ctx.beginPath(); ctx.ellipse(e.point('tank').x, e.point('tank').y + e.ppu * .25, e.ppu * 1.05, e.ppu * .45, 0, 0, TAU); ctx.fill(); ctx.restore();
      if (ice > 0) {
        const w = size * 1.55 * ice, h = size * 1.1 * ice;
        ctx.save(); ctx.globalAlpha = .55; ctx.fillStyle = '#bfe6ff'; ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = i / 10 * TAU, rr = (i % 2 ? .92 : 1.05); ctx.lineTo(x + Math.cos(a) * w / 2 * rr, y + Math.sin(a) * h / 2 * rr); } ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 5; ctx.strokeStyle = W.ink; ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x - w * .38, y - h * .3); ctx.lineTo(x - w * .1, y - h * .38); ctx.moveTo(x + w * .2, y + h * .28); ctx.lineTo(x + w * .36, y + h * .1); ctx.stroke();
        ctx.restore();
        e.say('冻住了…', x, sayY, size * .18, {free: !e.landscape, prio: 1, fill: '#fff'});
      }
      return;
    }
    for (let i = 0; i < count(e, 46); i++) {
      const a = rnd() * TAU, d = easeOut(shatter) * size * (1 + rnd() * 1.6), r = (8 + rnd() * 20) * e.unit;
      ctx.save(); ctx.translate(x + Math.cos(a) * d, y + Math.sin(a) * d + shatter * shatter * size * 1.2); ctx.rotate(a + shatter * 6); ctx.globalAlpha = 1 - seg(shatter, .5, 1);
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * .7, r * .5); ctx.lineTo(-r * .6, r * .6); ctx.closePath(); ctx.fillStyle = i % 3 ? '#cfefff' : '#fff'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = W.ink; ctx.stroke(); ctx.restore();
    }
    num(ctx, e.thText, x, y, size * (1 + shatter * .1), {fill: '#fff', ghost: [W.c, W.m], alpha: 1 - seg(shatter, .5, 1)});
    if (shatter < .6) e.say('CRACK!', x, sayY, size * .32 * back(seg(shatter, 0, .2)), {free: !e.landscape, prio: 2});
  },
};

export const numNeon = {
  bike: p => ({dy: .02 * Math.abs(Math.sin(p * 20)), shake: p >= .46 && p < .52 ? .6 : 0}),
  draw(ctx, p, e) {
    const W = e.world, {x, y, size, sayY} = big(e), fade = 1 - seg(p, .9, 1), on = seg(p, .1, .46), lit = p >= .46 && Math.floor(p * 40) % 6 !== 0;
    // 灯管背板
    ctx.save(); ctx.globalAlpha = fade * .85; ctx.fillStyle = '#0d0820'; const bw = size * 1.6, bh = size * 1.05;
    ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh); ctx.lineWidth = 5; ctx.strokeStyle = W.ink; ctx.strokeRect(x - bw / 2, y - bh / 2, bw, bh);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.fillStyle = '#6a6a7a'; ctx.beginPath(); ctx.arc(x + sx * (bw / 2 - 12), y + sy * (bh / 2 - 12), 5, 0, TAU); ctx.fill(); }
    ctx.restore();
    if (impactFrame(ctx, e, beat(p, 'climax'), 'neon', x, y)) return;
    ctx.save(); ctx.globalAlpha = fade;
    ctx.font = `${Math.round(size)}px MotuoNum, MotuoDisplay, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.lineWidth = size * .07; ctx.strokeStyle = 'rgba(60,30,80,.9)'; ctx.strokeText(e.thText, x, y);
    ctx.setLineDash(on < 1 ? [size * 3.4 * on, size * 7] : []);
    ctx.shadowColor = W.m; ctx.shadowBlur = lit ? 32 : 10;
    ctx.lineWidth = size * .055; ctx.strokeStyle = lit ? '#ffd6f6' : W.m; ctx.strokeText(e.thText, x, y);
    ctx.shadowColor = W.c; ctx.lineWidth = size * .02; ctx.strokeStyle = '#fff'; ctx.strokeText(e.thText, x, y);
    ctx.restore();
    if (on < 1 && on > 0) { const r2 = rng(e.seed + Math.floor(p * 20)); ctx.strokeStyle = W.y; ctx.lineWidth = 3; ctx.beginPath(); const sx = x - size * .55 + on * size * 1.1, sy = y + (r2() - .5) * size * .6; for (let i = 0; i < 6; i++) { ctx.moveTo(sx, sy); ctx.lineTo(sx + (r2() - .5) * 60, sy + (r2() - .5) * 60); } ctx.stroke(); }
    if (p >= .46 && p < .9) e.say('ON AIR', x, sayY, size * .22 * back(seg(p, .46, .56)), {free: !e.landscape, prio: 2, fill: W.c, ghost: [W.m, '#fff']});
    else if (p > .1 && p < .46) e.say('滋…滋滋…', x, sayY, size * .15, {free: !e.landscape, prio: 1, fill: '#fff'});
  },
};

/* ---------------- 世界专属反应：同一次突破在不同世界演法不同。等级越高元素越多。 ---------------- */
export const world = {
  draw(ctx, p, e) {
    const W = e.world, rnd = rng(e.seed + 121), k = e.tier, f = e.stage, u = Math.max(1, e.unit);
    if (W.key === 'neon') {
      // 霓虹都市：街边广告牌依次翻牌成这个数字
      const n = 3 + Math.min(4, k);
      for (let i = 0; i < n; i++) {
        const bx = f.x + f.w * (.06 + (i / n) * .9) + rnd() * 20, by = (e.landscape ? e.roadTop - e.H * (.22 + rnd() * .3) : f.y + 20 + rnd() * f.h * .3), bw = 86 * u + rnd() * 30, bh = 46 * u;
        const flip = seg(p, .05 + i * .05, .2 + i * .05), sy = Math.abs(Math.cos(flip * Math.PI)), show = flip > .5;
        ctx.save(); ctx.translate(bx, by); ctx.scale(1, sy || .02);
        ctx.fillStyle = '#0d0820'; ctx.fillRect(-bw / 2, -bh / 2, bw, bh); ctx.lineWidth = 3; ctx.strokeStyle = show ? W.m : W.c; ctx.shadowColor = W.m; ctx.shadowBlur = show ? 14 : 0; ctx.strokeRect(-bw / 2 + 3, -bh / 2 + 3, bw - 6, bh - 6);
        if (show) num(ctx, e.thText, 0, 1, bh * .7, {fill: i % 2 ? W.y : W.c, ink: '#0d0820', stroke: .08});
        ctx.restore();
      }
    } else if (W.key === 'sunset') {
      for (let i = 0; i < count(e, 10 + k * 3); i++) {
        const sx = f.x + rnd() * f.w, sy = e.horizon - rnd() * 30, q = seg(p, rnd() * .2, .9), fx = sx - q * (100 + rnd() * 200), fy = sy - easeOut(q) * (140 + rnd() * 180), wing = Math.sin(p * 40 + i) * 10;
        ctx.strokeStyle = W.ink; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(fx - 16, fy - wing); ctx.quadraticCurveTo(fx - 8, fy - 10, fx, fy); ctx.quadraticCurveTo(fx + 8, fy - 10, fx + 16, fy - wing); ctx.stroke();
      }
      const sp = seg(p, .1, .7);
      for (let i = 0; i < count(e, 24 + k * 6); i++) { const a = -Math.PI * (.15 + rnd() * .7), v = (70 + rnd() * 140) * u, x = f.x + f.w * (.2 + rnd() * .6) + Math.cos(a) * v * sp, y = e.horizon + 6 + Math.sin(a) * v * sp + 220 * sp * sp; ctx.globalAlpha = 1 - sp; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3 + rnd() * 6, 0, TAU); ctx.fill(); }
      ctx.globalAlpha = 1;
    } else if (W.key === 'snow') {
      ctx.save(); ctx.strokeStyle = '#e8f6ff'; ctx.lineCap = 'round';
      for (let i = 0; i < count(e, 34 + k * 8); i++) { const y = rnd() * e.ground, x = e.W - ((p * (1.5 + rnd()) + rnd()) % 1.2) * e.W * 1.2, len = 40 + rnd() * 140; ctx.globalAlpha = .8; ctx.lineWidth = 1.5 + rnd() * 2.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y); ctx.stroke(); }
      ctx.restore();
      const av = easeOut(seg(p, .05, .8)), x0 = f.x + f.w * .1, y0 = e.horizon - e.H * .24, x1 = f.x + f.w * .55, y1 = e.horizon - 8;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, e.W, e.horizon); ctx.clip();
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = W.ink; ctx.lineWidth = 2.5;
      for (let i = 0; i < count(e, 18); i++) { const q = rnd() * av, x = lerp(x0, x1, q) + (rnd() - .5) * 34, y = lerp(y0, y1, q) + (rnd() - .5) * 18, r = (7 + rnd() * 14) * u * (.4 + q); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.stroke(); }
      ctx.restore();
    } else {
      const n = 3 + Math.min(3, k), q = easeInOut(seg(p, 0, .5)), ly = e.landscape ? e.H * .16 : f.y + 30;
      for (let i = 0; i < n; i++) {
        const sx = f.x + rnd() * f.w, sy = rnd() * e.horizon, tx = f.x + f.w * ((i + .5) / n), r = (12 + rnd() * 16) * u;
        ctx.beginPath(); ctx.arc(lerp(sx, tx, q), lerp(sy, ly, q), r, 0, TAU); ctx.fillStyle = [W.m, W.c, W.y, '#ff9ee8', '#9ad8ff', '#fff'][i]; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = W.ink; ctx.stroke();
      }
      if (q >= 1) { ctx.save(); ctx.globalAlpha = .6; ctx.strokeStyle = W.c; ctx.lineWidth = 2; ctx.setLineDash([6, 8]); ctx.beginPath(); ctx.moveTo(f.x, ly); ctx.lineTo(f.x + f.w, ly); ctx.stroke(); ctx.restore(); }
      for (let i = 0; i < count(e, 12 + k * 4); i++) { const t0 = rnd() * .6, m = seg(p, t0, t0 + .3); if (m <= 0 || m >= 1) continue; const sx = rnd() * e.W * 1.2, sy = -20 + rnd() * e.H * .3, x = sx - m * 320, y = sy + m * 220; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.globalAlpha = 1 - m; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 70, y - 46); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
  },
};
