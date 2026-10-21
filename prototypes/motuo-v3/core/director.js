/* 导演：把游戏事件翻译成漫画分镜 cut-in / 拟声字 / 冲击帧，并统一管理闪光预算。
 * 规则：
 *  - 所有闪光（冲击帧、套印闪、GO 白闪）只能经 requestFlash()，任意 1s ≤ maxPerSecond 次。
 *  - cut-in 时长 0.6–1.2s，两次间隔 ≥ minGapMs，排队最多 1 个且过期丢弃。
 *  - 分镜版式永远给速度留一格（gauge 格完整包住速度区域，其余格不碰速度区域）。
 *  - 减少动态：不出 cut-in、不闪，改为静态角标字幕。
 */
import {rectPoly, clipAll, cut, halfPlane, contains} from './geometry.js';

export const CUTIN = Object.freeze({
  launch: {ms: 900, sfx: ['VROOM!', '轰——'], roles: ['rear', 'gauge', 'headlight'], label: '起步'},
  boost: {ms: 1000, sfx: ['轰！', 'BOOST!'], roles: ['bike', 'exhaust', 'gauge'], label: '强加速'},
  brake: {ms: 800, sfx: ['吱——！', 'SCREECH'], roles: ['front', 'gauge'], label: '急减速'},
  corner: {ms: 1100, sfx: ['SWOOSH!', '呼——'], roles: ['lean', 'tire', 'road', 'gauge'], label: '过弯'},
  milestone: {ms: 700, sfx: ['ZOOM!'], roles: ['bike', 'gauge'], label: '速度里程碑'},
});

export const IMPACT_MS = 84; // 冲击帧：12fps 下一拍

export function createFlashLimiter({maxPerSecond = 2, windowMs = 1000} = {}) {
  let stamps = [];
  const log = [];
  return {
    allow(now, kind = 'flash') {
      stamps = stamps.filter(t => now - t < windowMs);
      if (stamps.length >= maxPerSecond) return false;
      stamps.push(now); log.push({t: now, kind});
      return true;
    },
    countIn(now) { return stamps.filter(t => now - t < windowMs).length; },
    get log() { return log; },
    reset() { stamps = []; },
  };
}

// 给定闪光时刻列表，任意滑动 1s 窗口内的最大次数。
export function maxFlashesPerSecond(times, windowMs = 1000) {
  const s = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] >= windowMs) j++; best = Math.max(best, i - j + 1); }
  return best;
}

/* 版式：像素坐标。speed = 速度元素外框 {x,y,w,h}。
 * 横屏：速度格在右侧斜切竖条；竖屏：速度格在顶部斜切横条。其余区域按角色数再切。 */
export function cutinLayout(kind, W, H, speed) {
  const spec = CUTIN[kind] || CUTIN.milestone;
  const roles = spec.roles.filter(r => r !== 'gauge');
  const g = Math.max(8, Math.round(Math.min(W, H) * .022));
  const pad = Math.round(Math.min(W, H) * .03);
  const full = rectPoly(0, 0, W, H);
  const landscape = W >= H;
  let gaugePlanes, restPlanes;
  if (landscape) {
    // 斜线从顶部 x0 到底部 x0 - slant（向下左倾），速度框上沿处的线位置决定是否碰到速度框。
    const slant = W * .08, x0 = Math.min(W - 40, speed.x - pad + slant * Math.max(0, speed.y - pad) / H);
    const top = [x0, 0], bottom = [x0 - slant, H];
    [restPlanes, gaugePlanes] = [[halfPlane(bottom, top, g / 2)], [halfPlane(top, bottom, g / 2)]];
  } else {
    const slant = H * .035, y0 = Math.min(H - 40, speed.y + speed.h + pad + slant);
    const left = [0, y0], right = [W, y0 - slant];
    [gaugePlanes, restPlanes] = [[halfPlane(left, right, g / 2)], [halfPlane(right, left, g / 2)]];
  }
  const panels = [{role: 'gauge', poly: clipAll(full, gaugePlanes)}];
  const rest = clipAll(full, restPlanes);
  const rb = boundsOf(rest);
  const n = roles.length;
  if (n === 1) panels.push({role: roles[0], poly: rest});
  else if (n === 2) {
    // 横屏上下切、竖屏左右切，切线带斜度。
    const [a, b] = landscape
      ? cut([rb.x + rb.w, rb.y + rb.h * .46], [rb.x, rb.y + rb.h * .56], g)
      : cut([rb.x + rb.w * .58, rb.y + rb.h], [rb.x + rb.w * .46, rb.y], g);
    panels.push({role: roles[0], poly: clipAll(rest, [b])}, {role: roles[1], poly: clipAll(rest, [a])});
  } else {
    // 三格：一条长切线 + 一条短切线。
    const [top, bottom] = landscape
      ? cut([rb.x + rb.w, rb.y + rb.h * .42], [rb.x, rb.y + rb.h * .52], g)
      : cut([rb.x + rb.w, rb.y + rb.h * .38], [rb.x, rb.y + rb.h * .48], g);
    const upper = clipAll(rest, [bottom]), lower = clipAll(rest, [top]);
    const lb = boundsOf(lower);
    const [l, r] = cut([lb.x + lb.w * .55, lb.y + lb.h], [lb.x + lb.w * .45, lb.y], g);
    panels.push({role: roles[0], poly: upper}, {role: roles[1], poly: clipAll(lower, [r])}, {role: roles[2], poly: clipAll(lower, [l])});
  }
  return {kind, W, H, gutter: g, panels: panels.filter(p => p.poly.length >= 3)};
}
function boundsOf(poly) {
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  return {x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)};
}
// 速度框四角 + 中心都在 gauge 格内，且不落入其他格。
export function speedReserved(layout, speed) {
  const pts = [[speed.x, speed.y], [speed.x + speed.w, speed.y], [speed.x, speed.y + speed.h], [speed.x + speed.w, speed.y + speed.h], [speed.x + speed.w / 2, speed.y + speed.h / 2]];
  const gauge = layout.panels.find(p => p.role === 'gauge');
  return !!gauge && pts.every(([x, y]) => contains(gauge.poly, x, y)) &&
    layout.panels.filter(p => p !== gauge).every(p => pts.every(([x, y]) => !contains(p.poly, x, y)));
}

export function createDirector({limiter = createFlashLimiter(), reduced = () => false, minGapMs = 1400, queueTtlMs = 1200} = {}) {
  let active = null, queued = null, lastStart = -Infinity, captions = [], holdUntil = -Infinity;
  const history = [];
  function plan(ev, now) {
    const kind = ev.kind;
    const spec = CUTIN[kind];
    if (!spec) return null;
    if (reduced()) {
      const c = {type: 'caption', kind, at: now, until: now + 1600, text: `${spec.label} · ${ev.word || ''}`.trim()};
      captions = captions.filter(x => x.until > now).concat(c);
      history.push(c);
      return c;
    }
    // 里程碑的副字是被跨越的阈值（如 “30 KM/H”），不是读数；读数在速度格里。
    const sfx = kind === 'milestone' && ev.word ? [spec.sfx[0], `突破 ${ev.word}`] : spec.sfx;
    return {type: 'cutin', kind, ev, ms: spec.ms, sfx, roles: spec.roles, label: spec.label};
  }
  function startPlan(p, now) {
    p.at = Math.round(now); p.until = p.at + p.ms;
    // 冲击帧只在闪光预算允许时出现；不允许就直接进入分镜，不闪。
    p.impact = limiter.allow(now, 'impact-' + p.kind);
    active = p; lastStart = now; history.push(p);
    return p;
  }
  return {
    event(ev, now) {
      const p = plan(ev, now);
      if (!p || p.type === 'caption') return p;
      if (!active && now >= holdUntil && now - lastStart >= minGapMs) return startPlan(p, now);
      queued = {p, at: Math.max(now, holdUntil)};
      return null;
    },
    // 每帧：结束过期分镜、尝试启动排队项。返回当前 cut-in（或 null）。
    update(now) {
      if (active && now >= active.until) active = null;
      if (!active && queued && now >= holdUntil) {
        if (now - queued.at > queueTtlMs) queued = null;
        else if (now - lastStart >= minGapMs) { const p = queued.p; queued = null; return startPlan(p, now); }
      }
      return active;
    },
    requestFlash(now, kind) { return !reduced() && limiter.allow(now, kind); },
    cancel() { active = null; queued = null; },
    // 突破剧场进行中：分镜让位，结束后再播排队的那一个。
    hold(until) { holdUntil = Math.max(holdUntil, until); if (active) active = null; },
    captions(now) { return captions.filter(c => c.until > now); },
    get active() { return active; }, get history() { return history; }, get limiter() { return limiter; },
  };
}
