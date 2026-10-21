// 横屏漫画：横版页排版、整页渲染，旋转时揭示立即收尾、本帧整页上屏（每格都有内容，不出现空格）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {pageLayout, PAGE, PAGE_LANDSCAPE, selectMoments} from '../core/comic-layout.js';
import {createComicView} from '../render/comic-view.js';
import {renderComicPage} from '../render/comic-render.js';
import {bounds} from '../core/geometry.js';
import {createDom} from './fake-dom.mjs';
import {simulateDemo} from './helpers.mjs';

test('横版页：4–6 格两行排布，全部在页内、不重叠、每格是横幅（宽 > 高）', () => {
  for (const n of [4, 5, 6]) {
    const {panels} = pageLayout(n, PAGE_LANDSCAPE);
    assert.equal(panels.length, n);
    const boxes = panels.map(p => bounds(p.poly));
    for (const b of boxes) {
      assert.ok(b.x >= PAGE_LANDSCAPE.margin - 1 && b.x + b.w <= PAGE_LANDSCAPE.W - PAGE_LANDSCAPE.margin + 1, JSON.stringify(b));
      assert.ok(b.y >= PAGE_LANDSCAPE.header - 1 && b.y + b.h <= PAGE_LANDSCAPE.H - PAGE_LANDSCAPE.footer + 1, JSON.stringify(b));
      assert.ok(b.w > b.h, `横幅格 ${b.w}×${b.h}`);
    }
    assert.deepEqual([...new Set(panels.map(p => p.row))], [0, 1]);
  }
  assert.equal(pageLayout(5).panels.length, 5, '竖版不变');
});

// 记录型画布：只记 drawImage 的源，判断“整页上屏”。
function fakeCanvas(name) {
  const c = {name, width: 0, height: 0, dataset: {}, ops: []};
  const ctx = new Proxy({}, {get: (t, k) => (k === 'drawImage' ? (img, ...a) => c.ops.push({k, src: img?.name, a}) : k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; }});
  c.getContext = () => ctx;
  return c;
}
const pagesFor = () => ({portrait: Object.assign(fakeCanvas('portrait'), {width: PAGE.W, height: PAGE.H}), landscape: Object.assign(fakeCanvas('landscape'), {width: PAGE_LANDSCAPE.W, height: PAGE_LANDSCAPE.H})});

test('旋转发生在逐格揭示中途：立即结束揭示，另一方向的页整页上屏，画布尺寸随之切换', () => {
  const view = fakeCanvas('view'), pages = pagesFor(), renders = [];
  const cv = createComicView({view, render: o => { renders.push(o); return {canvas: pages[o], panels: pageLayout(5, o === 'landscape' ? PAGE_LANDSCAPE : PAGE).panels}; }});
  cv.show('portrait', 0);
  assert.equal(view.width, PAGE.W); assert.equal(cv.revealing, true);
  cv.frame(500); // 第 2 格揭示中
  view.ops.length = 0;
  const r = cv.orient('landscape', 520);
  assert.equal(r.changed, true); assert.equal(cv.revealing, false, '揭示立即收尾');
  assert.equal(view.width, PAGE_LANDSCAPE.W); assert.equal(view.height, PAGE_LANDSCAPE.H);
  assert.deepEqual(view.ops.map(o => [o.src, ...o.a]), [['landscape', 0, 0]], '同一帧整页贴上，不是逐格');
  assert.equal(view.dataset.orientation, 'landscape');
  assert.equal(cv.frame(560), false, '之后不再揭示');
  // 转回竖屏：直接贴缓存，不重新渲染
  view.ops.length = 0; cv.orient('portrait', 600);
  assert.deepEqual(view.ops.map(o => o.src), ['portrait']); assert.deepEqual(renders, ['portrait', 'landscape']);
  assert.ok(cv.revealedAt !== null);
});
test('预渲染后旋转不再渲染；减少动态时首屏直接整页', () => {
  const view = fakeCanvas('view'), pages = pagesFor(), renders = [];
  const cv = createComicView({view, reduced: () => true, render: o => { renders.push(o); return {canvas: pages[o], panels: pageLayout(4, o === 'landscape' ? PAGE_LANDSCAPE : PAGE).panels}; }});
  cv.show('landscape', 0);
  assert.equal(cv.revealing, false); assert.deepEqual(view.ops.map(o => o.src), ['landscape']);
  cv.prerender('portrait'); cv.orient('portrait', 10); cv.orient('landscape', 20);
  assert.deepEqual(renders, ['landscape', 'portrait']);
});
test('横版页整页渲染：每一格都画了场景并贴进格子，注释只取记录值', () => {
  const dom = createDom(); globalThis.document = dom.doc;
  try {
    const {record} = simulateDemo();
    const moments = selectMoments(record);
    const draws = [];
    const canvas = dom.doc.createElement('canvas');
    const painter = {paint: () => draws.push('paint'), clear() {}};
    const bike = {snapshot: () => dom.doc.createElement('canvas')};
    const res = renderComicPage(canvas, {record, moments, painter, bike, page: PAGE_LANDSCAPE});
    assert.equal(canvas.width, PAGE_LANDSCAPE.W); assert.equal(canvas.height, PAGE_LANDSCAPE.H);
    assert.equal(res.panels.length, moments.length);
    assert.equal(draws.length, moments.length, '每格各画一次场景');
  } finally { delete globalThis.document; }
});
