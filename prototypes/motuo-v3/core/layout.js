/* 舞台版式：横屏与竖屏的地平线、路面、车与速度巨字位置。纯函数。 */

export function stageLayout(W, H) {
  const landscape = W >= H * 1.05;
  if (landscape) {
    const roadTop = Math.round(H * .73);
    const ground = Math.round(roadTop + (H - roadTop) * .52);
    const lengthPx = Math.round(Math.min(W * .5, H * 1.12));
    return {
      W, H, landscape, roadTop, ground, horizon: Math.round(H * .6),
      // rearX：后轮接地点；车头朝右。
      bike: {rearX: Math.round(W * .1), ground, lengthPx},
      // 速度巨字：右上，字高≥屏高 35%（盒高 = fontSize × lineHeight）。
      speed: {right: Math.round(W * .035), top: Math.round(H * .05), fontSize: Math.round(H * .47), lineHeight: .82, maxWidth: Math.round(W * .4), scaleMin: .7},
      scrollScale: W / 844,
    };
  }
  const roadTop = Math.round(H * .71);
  const ground = Math.round(roadTop + (H - roadTop) * .42);
  // 前后轮都完整在画面内：车尾 5%，车长 88%（前轮外缘约在 93%，再留给 1.06 镜头缩放与倾斜）。
  const lengthPx = Math.round(W * .88);
  return {
    W, H, landscape, roadTop, ground, horizon: Math.round(H * .6),
    bike: {rearX: Math.round(W * .05), ground, lengthPx},
    speed: {right: Math.round(W * .05), top: Math.round(H * .085), fontSize: Math.round(H * .43), lineHeight: .82, maxWidth: Math.round(W * .86), scaleMin: .52},
    scrollScale: W / 600,
  };
}

/* 巨字横向压缩：Orbitron 等宽数字字宽约 0.834em。宽度放不下时先压缩（不低于 scaleMin），
 * 仍放不下再缩字号。返回 {fontSize, scaleX}，保证盒高 ≥ 35% 屏高（2 位数时）。 */
export function speedFit(layout, digits) {
  const s = layout.speed, advance = .834, tracking = -.04;
  const width = fontSize => digits * fontSize * (advance + tracking);
  let fontSize = s.fontSize, scaleX = Math.min(1, s.maxWidth / width(fontSize));
  if (scaleX < s.scaleMin) { scaleX = s.scaleMin; fontSize = Math.floor(s.maxWidth / (digits * (advance + tracking) * scaleX)); }
  return {fontSize, scaleX: Math.round(scaleX * 1000) / 1000, boxHeight: fontSize * s.lineHeight};
}

// 车的屏幕映射：车尾 x = rearX，地面 y = ground；模型展示长度 2.1 单位 → lengthPx 像素。
export function bikeMapping(L) {
  const half = 1.05, ppu = L.bike.lengthPx / (half * 2);
  return {ppu, sx: z => L.bike.rearX + (z + half) * ppu, sy: y => L.bike.ground - y * ppu};
}

/* 倒计时巨字：READY / 3 / 2 / 1 / GO!!。数字字形高约 60–80% 屏高；宽度不够时纵向拉伸（竖屏窄长海报字，≤1.6 倍）。
 * 横屏放在车头前方，竖屏放在车上方。cap ≈ 0.72em（MotuoDisplay 大写/数字高度）。 */
export function countdownFit(W, H, text) {
  const landscape = W >= H * 1.05, go = /GO/.test(text), word = text.length > 2 && !go;
  // 竖屏的 GO!! 叠成两行 “GO / !!”，整块按两行计高度。
  const lines = !landscape && go ? [text.slice(0, 2), text.slice(2)] : [text];
  // adv 取 Russo One 实测较宽字母（含描边与套印偏移）的保守值。
  const cap = .72, adv = .8, n = Math.max(...lines.map(l => l.length), 1), rows = lines.length;
  const maxW = landscape ? W * (go ? .9 : word ? .72 : .44) : W * .9;
  // 竖屏 GO!! 在速度巨字（上部约 45%）之下，两行合计约半屏高。
  const targetCap = H * (landscape ? (word ? .4 : .7) : (word ? .2 : rows > 1 ? .25 : .56));
  let fontSize = Math.min(targetCap / cap, maxW / (n * adv));
  const sy = Math.min(go ? 2 : 1.6, Math.max(1, targetCap / (fontSize * cap)));
  const x = landscape ? W * (go ? .5 : word ? .6 : .76) : W * .5, y = landscape ? H * .46 : H * (rows > 1 ? .7 : .33);
  return {fontSize: Math.round(fontSize), sx: 1, sy: Math.round(sy * 100) / 100, x: Math.round(x), y: Math.round(y), lines, capRatio: rows * fontSize * cap * sy / H};
}

// 冲刺最远位移（模型单位）：车头外缘不越过画面右侧 2%。
export function maxDash(L, W) {
  const m = bikeMapping(L);
  return Math.max(0, (W * .98 - m.sx(1.05)) / m.ppu);
}
