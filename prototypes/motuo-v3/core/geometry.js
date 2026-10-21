/* 分镜几何：凸多边形按半平面裁切（Sutherland–Hodgman）+ 命中测试。
 * 漫画页、cut-in 斜切格都由“矩形 ∩ 若干斜线半平面”得到，格间留白由半平面平移实现。 */

// 保留直线 p→q 左侧（含 inset 的平移），坐标为像素。
export function halfPlane(p, q, inset = 0) {
  const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
  // 左法线 (dy, -dx)/len 指向保留侧（屏幕坐标 y 向下）。
  const nx = dy / len, ny = -dx / len;
  return {nx, ny, c: -(nx * p[0] + ny * p[1]) - inset};
}
export const side = (h, x, y) => h.nx * x + h.ny * y + h.c;

export function clip(poly, h) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(h, a[0], a[1]), sb = side(h, b[0], b[1]);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
export const rectPoly = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
export function clipAll(poly, planes) { return planes.reduce((p, h) => (p.length ? clip(p, h) : p), poly); }

export function contains(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function bounds(poly) {
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return {x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y};
}
export function area(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
export function tracePath(ctx, poly) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/* 一条“斜切线”把区域分成两侧：返回 [左/上侧, 右/下侧] 的半平面（各自带半个格间距）。 */
export function cut(p, q, gutter) {
  return [halfPlane(p, q, gutter / 2), halfPlane(q, p, gutter / 2)];
}

// 确定性伪随机（世界生成、手绘抖动）；同一 seed 永远同一画面。
export function rng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
