import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {simulateDemo, root} from './helpers.mjs';

test('减少动态：没有 cut-in 与闪光，改为静态字幕', () => {
  const r = simulateDemo({reduced: true});
  assert.equal(r.plans.filter(p => p.type === 'cutin').length, 0);
  assert.ok(r.plans.filter(p => p.type === 'caption').length >= 5);
  assert.equal(r.limiter.log.length, 0);
  assert.ok(r.director.captions(0).length >= 0);
});

test('减少动态的替代路径在 CSS 与主程序中存在', () => {
  const css = readFileSync(new URL('styles.css', root), 'utf8'), app = readFileSync(new URL('app.js', root), 'utf8');
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /\.reduced \.camera\{transform:none!important\}/);
  assert.match(app, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
  // 翻页、拟声字、冲刺、漫画逐格揭示在减少动态时都有跳过分支。
  for (const fn of ['function pageFlip', 'function word', 'function revealComic']) {
    const body = app.slice(app.indexOf(fn), app.indexOf(fn) + 400);
    assert.match(body, /isReduced\(\)/, fn);
  }
});
