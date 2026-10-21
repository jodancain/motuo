// 记录型 2D 画布替身：跟踪变换矩阵、save/restore 与 clip 栈，记录每个绘制操作发生时生效的裁切与文字位置。
// 不栅格化；用于检查“剧场所有绘制都在给车让位的裁切里”“文字不出画”等结构性约束。
export function createRecordingCtx() {
  let m = [1, 0, 0, 1, 0, 0], clips = [], path = [];
  const stack = [], ops = [];
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const pt = (x, y) => ({x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5]});
  const grad = {addColorStop() {}};
  const record = (kind, extra = {}) => ops.push({kind, clips: clips.slice(), ...extra});
  const api = {
    save() { stack.push({m: m.slice(), clips: clips.slice()}); },
    restore() { const s = stack.pop(); if (s) { m = s.m; clips = s.clips; } },
    setTransform(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) { m = typeof a === 'object' ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b, c, d, e, f]; },
    resetTransform() { m = [1, 0, 0, 1, 0, 0]; },
    transform(a, b, c, d, e, f) { m = mul(m, [a, b, c, d, e, f]); },
    translate(x, y) { m = mul(m, [1, 0, 0, 1, x, y]); },
    scale(x, y) { m = mul(m, [x, 0, 0, y, 0, 0]); },
    rotate(r) { const c = Math.cos(r), s = Math.sin(r); m = mul(m, [c, s, -s, c, 0, 0]); },
    beginPath() { path = []; },
    rect(x, y, w, h) { const a = pt(x, y), b = pt(x + w, y + h); path.push({x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y)}); },
    clip(rule) { clips.push({rule: rule || 'nonzero', rects: path.slice()}); },
    fill() { record('fill'); }, stroke() { record('stroke'); },
    fillRect() { record('fillRect'); }, strokeRect() { record('strokeRect'); }, clearRect() {},
    drawImage() { record('drawImage'); },
    fillText(s, x, y) { record('text', {s: String(s), ...pt(x, y)}); }, strokeText(s, x, y) { record('text', {s: String(s), ...pt(x, y)}); },
    measureText(s) { const size = parseFloat(String(api.font).match(/(\d+(\.\d+)?)px/)?.[1] || 10); return {width: String(s).length * size * .62, actualBoundingBoxAscent: size * .7, actualBoundingBoxDescent: size * .2}; },
    createLinearGradient: () => grad, createRadialGradient: () => grad, createConicGradient: () => grad, createPattern: () => grad,
    getImageData: (x, y, w, h) => ({data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h}), putImageData() {}, createImageData: (w, h) => ({data: new Uint8ClampedArray(w * h * 4), width: w, height: h}),
    setLineDash() {}, getLineDash: () => [], isPointInPath: () => false,
    getTransform: () => ({a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5]}),
    font: '10px sans-serif',
    ops: () => ops,
  };
  for (const k of ['moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'closePath', 'roundRect']) api[k] = () => {};
  return new Proxy(api, {get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? undefined : undefined)), set: (t, k, v) => { t[k] = v; return true; }});
}
