/* 2D 矢量漫画车：GLB 加载前与失败时的回退，也给漫画页兜底。
 * 坐标与 GLB 展示坐标一致（z 前后、y 上下，单位 = 模型单位，长 2.1），所以特效锚点通用。 */

export const BIKE_POINTS = Object.freeze({
  rearContact: [0, 0, -.669], frontContact: [0, 0, .749],
  rearAxle: [0, .335, -.669], frontAxle: [0, .301, .749],
  exhaust: [0, .6, -.98], headlight: [0, .64, .97], tank: [0, .98, .1], seat: [0, .9, -.5], disc: [0, .301, .749],
});
const R_REAR = .335, R_FRONT = .301;

// 车身轮廓（z, y）——侧视超跑：尾翘、油箱、风挡、车头、下导流。
const FAIRING = [[-1.05, .9], [-.82, .86], [-.42, .84], [-.3, .9], [-.05, 1.0], [.22, .99], [.4, .92], [.55, 1.04], [.72, 1.1], [.8, .98],
  [.98, .74], [1.02, .6], [.9, .5], [.62, .4], [.5, .3], [.12, .24], [-.2, .3], [-.32, .44], [-.62, .58], [-.86, .7], [-1.02, .8]];
const ACCENT = [[.5, .3], [.12, .24], [-.2, .3], [-.12, .44], [.3, .5], [.62, .42]];
const SEAT = [[-.82, .86], [-.42, .84], [-.32, .9], [-.6, .93], [-.86, .91]];
const SCREEN = [[.55, 1.04], [.72, 1.1], [.8, .98], [.66, .95]];

export function drawVectorBike(ctx, m, pose, paint, wheelAngle = 0) {
  const ppu = m.ppu;
  const c = Math.cos(pose.pitch), s = Math.sin(pose.pitch);
  const pz = pose.pitch < 0 ? BIKE_POINTS.rearContact[2] : BIKE_POINTS.frontContact[2];
  const offY = pz * s, offZ = pz - pz * c, yawK = Math.max(.35, Math.cos(pose.yaw));
  const jitter = pose.shake ? (Math.random() - .5) * pose.shake * .02 : 0;
  const T = (z, y) => {
    const y2 = y * c - z * s + offY + pose.dy + Math.abs(jitter) * .5;
    const z2 = (y * s + z * c + offZ) * yawK * pose.squash + pose.dz + jitter;
    return [m.sx(z2), m.sy(y2 / Math.sqrt(pose.squash))];
  };
  const path = pts => { ctx.beginPath(); pts.forEach(([z, y], i) => { const [x, yy] = T(z, y); i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); }); ctx.closePath(); };
  const ink = pose.impact > .5 ? '#000' : '#0b0a12', lw = Math.max(2.2, ppu * .018);
  ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // 轮子
  for (const [axle, R] of [[BIKE_POINTS.rearAxle, R_REAR], [BIKE_POINTS.frontAxle, R_FRONT]]) {
    const [x, y] = T(axle[2], axle[1]), r = R * ppu;
    ctx.beginPath(); ctx.ellipse(x, y, r * yawK, r, 0, 0, Math.PI * 2); ctx.fillStyle = '#121218'; ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = ink; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(x, y, r * .72 * yawK, r * .72, 0, 0, Math.PI * 2); ctx.fillStyle = '#2b2b33'; ctx.fill();
    ctx.strokeStyle = paint.accentColor === '#171b22' ? '#d9dde6' : paint.accentColor; ctx.lineWidth = Math.max(2, r * .09);
    ctx.beginPath();
    for (let k = 0; k < 5; k++) { const a = wheelAngle + k * Math.PI * 2 / 5; ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r * .7 * yawK, y + Math.sin(a) * r * .7); }
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r * .14, 0, Math.PI * 2); ctx.fillStyle = '#9aa0ad'; ctx.fill(); ctx.lineWidth = lw * .6; ctx.strokeStyle = ink; ctx.stroke();
  }
  // 摇臂、前叉、排气
  const line = (a, b, w, col) => { const [x1, y1] = T(a[0], a[1]), [x2, y2] = T(b[0], b[1]); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineWidth = w + lw * 1.4; ctx.strokeStyle = ink; ctx.stroke(); ctx.lineWidth = w; ctx.strokeStyle = col; ctx.stroke(); };
  line([-.669, .335], [-.15, .4], ppu * .05, '#3a3d48');
  line([.749, .301], [.6, .9], ppu * .04, '#c9a43a');
  line([-.25, .32], [-.95, .52], ppu * .07, '#b9bfcc');
  // 车身
  path(FAIRING); ctx.fillStyle = paint.bodyColor; ctx.fill();
  ctx.save(); ctx.clip();
  ctx.globalAlpha = .35; ctx.fillStyle = ink;
  const [, yMid] = T(0, .55); const cell = Math.max(4, ppu * .035);
  for (let gy = yMid; gy < yMid + ppu * .7; gy += cell) for (let gx = m.sx(-1.2); gx < m.sx(1.2); gx += cell) { const k = Math.min(1, (gy - yMid) / (ppu * .45)); ctx.beginPath(); ctx.arc(gx + ((gy / cell | 0) % 2) * cell / 2, gy, cell * .45 * k, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  path(ACCENT); ctx.fillStyle = paint.accentColor; ctx.fill(); ctx.lineWidth = lw * .7; ctx.strokeStyle = ink; ctx.stroke();
  path(SEAT); ctx.fillStyle = '#16161c'; ctx.fill();
  path(SCREEN); ctx.fillStyle = '#7fd0ff'; ctx.globalAlpha = .75; ctx.fill(); ctx.globalAlpha = 1; ctx.lineWidth = lw * .7; ctx.stroke();
  path(FAIRING); ctx.lineWidth = lw * 1.3; ctx.strokeStyle = ink; ctx.stroke();
  // 高光条 + 车灯
  ctx.beginPath(); { const [x1, y1] = T(-.2, .93), [x2, y2] = T(.35, .95); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); } ctx.lineWidth = Math.max(2, ppu * .02); ctx.strokeStyle = '#fffaf0'; ctx.stroke();
  { const [x, y] = T(.95, .66); ctx.beginPath(); ctx.ellipse(x, y, ppu * .04, ppu * .028, 0, 0, Math.PI * 2); ctx.fillStyle = '#fff7c2'; ctx.fill(); ctx.lineWidth = lw * .6; ctx.strokeStyle = ink; ctx.stroke(); }
  ctx.restore();
}
