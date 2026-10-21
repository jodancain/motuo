/* 分镜 cut-in 渲染：画面裂成 2–4 个斜切格，各格是车的局部特写（取自实时车画布）+ 网点爆炸背景 + 烟/火/火花。
 * 速度格（gauge）只画背景与表盘刻度装饰，真实速度 DOM 永远叠在其上。
 * 首拍为冲击帧（墨白反相），是否出现由导演的闪光预算决定。24fps 步进入场。 */
import {tracePath, bounds} from '../core/geometry.js';
import {halftone, drawFocusLines, isDark} from './scene.js';
import {drawSmoke, drawFlame, drawSparks, drawTextStamp} from './fx.js';
import {IMPACT_MS} from '../core/director.js';

const ZOOM = {rear: ['rearAxle', 1.8], front: ['frontAxle', 1.8], exhaust: ['exhaust', 1.9], headlight: ['headlight', 1.8], tire: ['rearContact', 2], bike: ['tank', 1.05], lean: ['tank', 1.0]};

export function createCutinRenderer() {
  function panelBackground(ctx, poly, world, role, t, impact) {
    const b = bounds(poly), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.fillStyle = impact ? world.ink : role === 'gauge' ? world.paper : world.sky[1];
    ctx.fillRect(b.x, b.y, b.w, b.h);
    if (!impact) {
      // 网点放射爆：主色在中心，撞色在外圈。
      const R = Math.hypot(b.w, b.h) / 2;
      ctx.globalAlpha = role === 'gauge' ? .5 : .8;
      halftone(ctx, b.x, b.y, b.w, b.h, role === 'gauge' ? world.m : world.accent, Math.max(7, R * .06), (x, y) => Math.min(1, Math.hypot(x - cx, y - cy) / R * 1.1));
      ctx.globalAlpha = 1;
    }
    drawFocusLines(ctx, b.w * 2, b.h * 2, cx, cy, {color: impact ? world.paper : (role === 'gauge' ? world.ink : (isDark(world) ? world.paper : world.ink)), count: 46, inner: .22, alpha: impact ? .95 : .55, jitter: Math.floor(t / 83)});
  }

  function gaugeDecor(ctx, poly, world, speedRect, impact) {
    // 表盘：围绕速度的半圈刻度与指针弧（无数字、无数值，纯装饰）。
    const cx = speedRect.x + speedRect.w / 2, cy = speedRect.y + speedRect.h * .55, R = Math.max(speedRect.w, speedRect.h) * .62;
    ctx.save(); ctx.lineCap = 'round';
    for (let i = 0; i <= 24; i++) {
      const a = Math.PI * (.85 + i / 24 * 1.3), r1 = R * (i % 4 ? .93 : .86);
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.lineWidth = i % 4 ? 3 : 6; ctx.strokeStyle = impact ? world.paper : world.ink; ctx.stroke();
    }
    ctx.lineWidth = 10; ctx.strokeStyle = world.c; ctx.globalAlpha = .9;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.06, Math.PI * .85, Math.PI * 2.15); ctx.stroke();
    ctx.restore();
  }

  function zoomed(ctx, poly, role, bike, srcCanvas, dpr, impact, world, t) {
    const z = ZOOM[role]; if (!z || !srcCanvas) return;
    const b = bounds(poly), p = bike.point(z[0]), k = z[1];
    // 以锚点为中心、按格子大小反推源区域。
    const sw = b.w / k, sh = b.h / k, sx = p.x - sw / 2, sy = p.y - sh / 2;
    ctx.save();
    if (role === 'lean') { ctx.translate(b.x + b.w / 2, b.y + b.h / 2); ctx.rotate(-.18); ctx.translate(-(b.x + b.w / 2), -(b.y + b.h / 2)); }
    if (impact) ctx.filter = 'grayscale(1) contrast(4) invert(1)';
    ctx.drawImage(srcCanvas, sx * dpr, sy * dpr, sw * dpr, sh * dpr, b.x, b.y, b.w, b.h);
    ctx.filter = 'none';
    ctx.restore();
    if (impact) return;
    const seed = Math.floor(t / 83);
    const ax = b.x + b.w / 2, ay = b.y + b.h / 2, s = Math.min(b.w, b.h);
    if (role === 'rear' || role === 'tire') for (let i = 0; i < 4; i++) drawSmoke(ctx, ax - s * (.15 + i * .18), ay + s * (.2 - i * .06), s * (.16 + i * .05), {seed: seed + i, ink: world.ink});
    if (role === 'exhaust') drawFlame(ctx, ax, ay, s * .7, {angle: Math.PI * .97, seed, ink: world.ink});
    if (role === 'front') drawSparks(ctx, ax, ay + s * .3, s * .6, {angle: Math.PI * .95, spread: 1.1, count: 16, seed, color: world.y, ink: world.ink});
    if (role === 'headlight') {
      ctx.save(); ctx.globalAlpha = .85; ctx.fillStyle = '#fff7c2';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(b.x + b.w * 1.2, b.y - b.h * .1); ctx.lineTo(b.x + b.w * 1.2, b.y + b.h * 1.1); ctx.closePath(); ctx.fill(); ctx.restore();
    }
  }

  /* plan：导演给出的 cut-in；layout：cutinLayout() 结果；elapsed：毫秒。 */
  function draw(ctx, {plan, layout, elapsed, bike, bikeCanvas, dpr, world, speedRect, roadTop}) {
    const W = layout.W, H = layout.H;
    const impact = plan.impact && elapsed < IMPACT_MS;
    const step = Math.floor(elapsed / (1000 / 24)) * (1000 / 24);
    ctx.clearRect(0, 0, W, H);
    // 纸色格间留白
    ctx.fillStyle = impact ? world.paper : world.paper; ctx.globalAlpha = impact ? 1 : Math.min(1, step / 60); ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    layout.panels.forEach((panel, i) => {
      // 错峰滑入（40ms），偏移随步进量化。
      const local = Math.max(0, step - i * 40), k = Math.min(1, local / 160), ease = 1 - (1 - k) ** 3;
      if (local <= 0 && !impact) return;
      const b = bounds(panel.poly), dir = i % 2 ? 1 : -1;
      ctx.save();
      ctx.translate(impact ? 0 : dir * (1 - ease) * b.w * .35, 0);
      tracePath(ctx, panel.poly); ctx.clip();
      panelBackground(ctx, panel.poly, world, panel.role, elapsed, impact);
      if (panel.role === 'gauge') gaugeDecor(ctx, panel.poly, world, speedRect, impact);
      else if (panel.role === 'road') {
        const rb = b; ctx.fillStyle = world.road.fill; ctx.fillRect(rb.x, rb.y + rb.h * .45, rb.w, rb.h);
        ctx.fillStyle = world.road.lane; for (let x = rb.x - (elapsed * 1.6 % 120); x < rb.x + rb.w; x += 120) ctx.fillRect(x, rb.y + rb.h * .7, 70, 10);
        ctx.fillStyle = world.ink; ctx.globalAlpha = .7; ctx.fillRect(rb.x, rb.y + rb.h * .58, rb.w, 8); ctx.globalAlpha = 1;
        // 胎痕 + 横向速度线：路面特写
        ctx.fillStyle = world.ink; ctx.beginPath(); ctx.moveTo(rb.x, rb.y + rb.h * .9); ctx.quadraticCurveTo(rb.x + rb.w * .5, rb.y + rb.h * .62, rb.x + rb.w, rb.y + rb.h * .66); ctx.lineTo(rb.x + rb.w, rb.y + rb.h * .72); ctx.quadraticCurveTo(rb.x + rb.w * .5, rb.y + rb.h * .7, rb.x, rb.y + rb.h * .98); ctx.fill();
        ctx.fillStyle = world.line; ctx.globalAlpha = .75;
        for (let k = 0; k < 9; k++) { const yy = rb.y + rb.h * (.08 + k * .045), len = rb.w * (.3 + ((k * 37) % 50) / 100), x0 = rb.x + ((elapsed * 2.2 + k * 140) % (rb.w + len)) - len; ctx.fillRect(x0, yy, len, 3 + (k % 3)); }
        ctx.globalAlpha = 1;
      } else zoomed(ctx, panel.poly, panel.role, bike, bikeCanvas, dpr, impact, world, elapsed);
      ctx.restore();
      ctx.save(); ctx.translate(impact ? 0 : dir * (1 - ease) * b.w * .35, 0);
      tracePath(ctx, panel.poly); ctx.lineWidth = Math.max(4, Math.min(W, H) * .012); ctx.strokeStyle = impact ? world.paper : world.ink; ctx.stroke();
      ctx.restore();
    });
    // 拟声字：最大的非速度格中央。
    if (!impact) {
      const big = layout.panels.filter(p => p.role !== 'gauge').map(p => ({p, b: bounds(p.poly)})).sort((a, b) => b.b.w * b.b.h - a.b.w * a.b.h)[0];
      if (big) {
        const pop = Math.min(1, elapsed / 140), size = Math.min(big.b.w * .3, big.b.h * .42) * (1.25 - .25 * pop);
        // 拟声字限定在自己的格子内，不越过格线进入速度格。
        ctx.save(); tracePath(ctx, big.p.poly); ctx.clip();
        drawTextStamp(ctx, plan.sfx[0], big.b.x + big.b.w * .5, big.b.y + big.b.h * .32, size, {fill: world.y, shadow: world.m, ink: world.ink, maxWidth: big.b.w * .86});
        // 副字与漫画页 “轰！” 同一样式：黄字、品红套印、按字号成比例的墨线；字号不低于主字 0.6。
        if (plan.sfx[1]) { const han = /[一-鿿]/.test(plan.sfx[1]); drawTextStamp(ctx, plan.sfx[1], big.b.x + big.b.w * .5, big.b.y + big.b.h * .74, size * (han ? .62 : .5), {fill: han ? world.y : '#ffffff', shadow: world.m, ink: world.ink, rotate: .06, stroke: .11, shadowOffset: .035, font: han ? 'MotuoHan, sans-serif' : 'MotuoDisplay, MotuoHan, sans-serif', maxWidth: big.b.w * .7}); }
        ctx.restore();
      }
    }
    return impact;
  }
  return {draw};
}
