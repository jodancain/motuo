/* 屏上的「今日骑行漫画」：竖屏显示竖版页、横屏显示横版页（导出 / 分享永远用竖版页）。
 * 两张页各自渲染一次并缓存（离屏画布）；逐格揭示只在首次显示时播放。
 * 旋转（orient）时立刻结束揭示、把另一张页整页画到屏上：缓存有就直接贴，没有就当场同步渲染，
 * 所以旋转后的第一帧里每一格都是完整的，不会出现空格。依赖注入，便于 node 测试。 */
import {tracePath} from '../core/geometry.js';

export function createComicView({view, render, reduced = () => false, each = 420, onStamp = () => {}}) {
  const pages = {};
  let cur = null, reveal = null, revealedAt = null;
  const ensure = o => (pages[o] ||= render(o));
  function bare(pg) {
    const g = view.getContext('2d');
    g.drawImage(pg.canvas, 0, 0);
    for (const p of pg.panels) { tracePath(g, p.poly); g.fillStyle = '#f3ead6'; g.fill(); g.lineWidth = 7; g.strokeStyle = '#0b0a12'; g.stroke(); }
  }
  function size(pg) { if (view.width !== pg.canvas.width) view.width = pg.canvas.width; if (view.height !== pg.canvas.height) view.height = pg.canvas.height; }
  function full(o, t) {
    const pg = ensure(o); size(pg);
    view.getContext('2d').drawImage(pg.canvas, 0, 0);
    view.dataset.orientation = o; reveal = null; revealedAt ??= t;
    return pg;
  }
  return {
    // 首次显示：先画纸与空框，之后逐格砸入（减少动态时直接整页）。
    show(o, t) {
      cur = o; revealedAt = null;
      const pg = ensure(o); size(pg); view.dataset.orientation = o;
      if (reduced()) return full(o, t);
      bare(pg); reveal = {t0: t, shown: -1};
      return pg;
    },
    // 每帧：推进揭示。返回 true 表示还在揭示。
    frame(t) {
      if (!reveal) return false;
      const pg = pages[cur], g = view.getContext('2d'), {t0} = reveal;
      const i = Math.min(pg.panels.length - 1, Math.floor((t - t0) / each));
      const k = Math.max(0, Math.min(1, ((t - t0) - i * each) / 160));
      for (let j = 0; j <= i; j++) {
        const p = pg.panels[j], scale = j === i ? 1 + .14 * (1 - k) * (1 - k) : 1;
        g.save(); tracePath(g, p.poly); g.clip();
        g.fillStyle = '#f3ead6'; g.fill();
        const b = p.poly.reduce((a, [x, y]) => ({x: a.x + x / p.poly.length, y: a.y + y / p.poly.length}), {x: 0, y: 0});
        g.translate(b.x, b.y); g.scale(scale, scale); g.translate(-b.x, -b.y);
        g.drawImage(pg.canvas, 0, 0); g.restore();
        tracePath(g, p.poly); g.lineWidth = 7; g.strokeStyle = '#0b0a12'; g.stroke();
      }
      if (i !== reveal.shown) { reveal.shown = i; onStamp(i); }
      if (t - t0 > each * pg.panels.length + 200) { full(cur, t); return false; }
      return true;
    },
    // 旋转：揭示立即收尾，另一张页整页上屏（同一帧内完成）。
    orient(o, t) { if (!cur) return null; const changed = o !== cur; cur = o; return {changed, page: full(o, t)}; },
    // 空闲时预先渲染另一张页，旋转时直接贴缓存。
    prerender(o) { return ensure(o); },
    page: o => ensure(o),
    cached: o => !!pages[o],
    get current() { return cur; }, get revealing() { return !!reveal; }, get revealedAt() { return revealedAt; },
  };
}
