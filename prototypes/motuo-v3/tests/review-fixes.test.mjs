// 第二轮审核修复的回归测试：暂停定格速度、拟声字不横向压扁、倒计时巨字、车完整入画。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {simulateDemo, root} from './helpers.mjs';
import {drawTextStamp} from '../render/fx.js';
import {stageLayout, countdownFit, bikeMapping, maxDash} from '../core/layout.js';

const css = readFileSync(new URL('styles.css', root), 'utf8'), html = readFileSync(new URL('index.html', root), 'utf8');

test('暂停时速度元素有文本且可见：定格最后一条真实读数并标“定格”', () => {
  const r = simulateDemo();
  const paused = r.shown.filter(s => s.phase === 'paused');
  assert.ok(paused.length > 100);
  const pauseWall = r.phases.find(p => p.phase === 'paused').wall;
  const last = r.frames.filter(f => f.wall <= pauseWall + 1e-9).pop();
  for (const s of paused) { assert.ok(s.text.trim().length > 0); assert.equal(s.text, String(Math.round(last.speedKmh))); }
  // 暂停阶段没有任何规则把速度层隐藏或淡出；“定格”标签存在。
  for (const m of css.matchAll(/data-phase=paused\][^{]*\.speed[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(m[1], /display:none|visibility:hidden|opacity:0(?!\.9)/);
  assert.match(html, /id="speed-frozen"[^>]*>定格 · 最后读数</);
});

test('拟声字放不下时缩小字号，不用 maxWidth 横向压扁（“轰”保持完整字形）', () => {
  const calls = [], ctx = {font: '', save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    measureText(t) { return {width: t.length * parseFloat(this.font)}; },
    fillText(...a) { calls.push(['fill', a.length, this.font]); }, strokeText(...a) { calls.push(['stroke', a.length, this.font]); }};
  drawTextStamp(ctx, '轰——', 0, 0, 100, {maxWidth: 150, font: 'MotuoHan'});
  assert.ok(calls.length === 3 && calls.every(c => c[1] === 3), '不传第 4 个 maxWidth 参数');
  assert.equal(parseFloat(calls[0][2]), 50, '字号按比例缩小到能放下');
});

test('倒计时 3/2/1/GO!! 字形约 55–80% 屏高，且不超出画面宽度', () => {
  for (const [W, H] of [[832, 378], [378, 832], [1180, 820], [820, 1180]]) for (const t of ['3', '2', '1', 'GO!!', 'READY']) {
    const f = countdownFit(W, H, t);
    const portraitGo = W < H && t === 'GO!!';
    if (t !== 'READY') assert.ok(f.capRatio >= (portraitGo ? .45 : .55) && f.capRatio <= .8, `${t} ${W}x${H} ${f.capRatio.toFixed(2)}`);
    // 竖屏 GO!! 整块在速度巨字区域（上部 45%）之下。
    if (portraitGo) assert.ok(f.y - f.capRatio * H / 2 >= H * .44, `GO!! ${W}x${H} top ${(f.y / H - f.capRatio / 2).toFixed(2)}`);
    const width = Math.max(...f.lines.map(l => l.length)) * .8 * f.fontSize * f.sx;
    assert.ok(f.x - width / 2 >= -2 && f.x + width / 2 <= W + 2, `${t} ${W}x${H} 宽度`);
  }
  const ready = countdownFit(832, 378, 'READY'); assert.ok(ready.capRatio >= .3);
});

test('横竖屏两个车轮都完整在画面内（含 1.06 镜头缩放），冲刺不把车头推出画面', () => {
  for (const [W, H] of [[832, 378], [378, 832], [390, 844], [844, 390], [667, 375], [375, 667]]) {
    const L = stageLayout(W, H), m = bikeMapping(L), zoom = x => .4 * W + (x - .4 * W) * 1.06;
    const rear = zoom(m.sx(-1.05)), front = zoom(m.sx(1.05));
    assert.ok(rear >= 0 && front <= W, `${W}x${H}: ${rear.toFixed(1)}..${front.toFixed(1)}`);
    const dash = maxDash(L, W); assert.ok(m.sx(1.05) + dash * m.ppu <= W * .98 + .5);
  }
});
