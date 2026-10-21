import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateDemo} from './helpers.mjs';
import {selectMoments, captionFor, pageSummary, pageLayout, PAGE, comicFilename} from '../core/comic-layout.js';
import {contains, area} from '../core/geometry.js';
import {createDom} from './fake-dom.mjs';

const demo = simulateDemo();
test('关键时刻：起步/最高速/最强加速/过弯/急减速/结束，4–6 格且按时间排序', () => {
  const m = selectMoments(demo.record);
  assert.ok(m.length >= 4 && m.length <= 6);
  assert.deepEqual(m.map(x => x.kind).sort(), ['accel', 'brake', 'corner', 'finish', 'launch', 'top']);
  assert.equal(m[m.length - 1].kind, 'finish');
  for (let i = 1; i < m.length - 1; i++) assert.ok(m[i].t >= m[i - 1].t);
});

test('漫画数值只取记录值：每格速度/加速度/时刻都与记录中的同一条读数一致', () => {
  const rs = demo.record.readings;
  for (const m of selectMoments(demo.record)) {
    const r = rs.find(x => x.t === m.t && x.speedKmh === m.speedKmh);
    assert.ok(r, `${m.kind} @${m.t}`);
    assert.equal(m.accelMs2, r.accelMs2);
    if (m.kind === 'top') assert.equal(m.speedKmh, Math.max(...rs.filter(x => Number.isFinite(x.speedKmh)).map(x => x.speedKmh)));
    if (m.kind === 'finish') { assert.equal(m.distanceM, demo.record.summary.distanceM); assert.equal(m.maxSpeedKmh, demo.record.summary.maxSpeedKmh); }
  }
});

test('注释文本中没有凭空数字（去掉记录值后不剩任何数字）', () => {
  for (const m of selectMoments(demo.record)) {
    const c = captionFor(m);
    let text = [c.time, ...c.lines, c.big || ''].join(' ');
    for (const v of [...c.values].sort((a, b) => b.length - a.length)) text = text.split(v).join('');
    text = text.replace(/m\/s²/g, '');
    assert.doesNotMatch(text, /\d/, `${m.kind}: ${text}`);
    assert.match(c.badge, /DEMO/);
  }
  const s = pageSummary(demo.record);
  let t = [s.line, s.score].join(' '); for (const v of s.values) t = t.split(v).join('');
  assert.doesNotMatch(t, /\d/); assert.match(s.score, /游戏分/); assert.match(s.source, /DEMO/);
});

test('只有极少读数时不编造：<2 条有效读数不出漫画；不足 4 格时补中段巡航（仍是记录值）', () => {
  assert.equal(selectMoments({readings: [{t: 0, speedKmh: 0}], events: []}).length, 0);
  const rec = {readings: [0, 1, 2, 3].map(t => ({t, speedKmh: t * 5, shown: String(t * 5), accelMs2: null})), events: [], summary: {distanceM: 10, durationS: 3, maxSpeedKmh: 15}};
  const m = selectMoments(rec);
  assert.ok(m.length >= 3); assert.ok(m.every(x => rec.readings.some(r => r.t === x.t && r.speedKmh === x.speedKmh)));
});

test('页面版式：4/5/6 格都在页内、互不重叠、面积充足', () => {
  for (const n of [4, 5, 6]) {
    const l = pageLayout(n);
    assert.equal(l.panels.length, n);
    for (const p of l.panels) { assert.ok(p.poly.every(([x, y]) => x >= PAGE.margin - .5 && x <= PAGE.W - PAGE.margin + .5 && y >= PAGE.header - .5 && y <= PAGE.H - PAGE.footer + .5)); assert.ok(area(p.poly) > 60000); }
    for (let y = PAGE.header; y < PAGE.H - PAGE.footer; y += 9) for (let x = PAGE.margin; x < PAGE.W - PAGE.margin; x += 9) assert.ok(l.panels.filter(p => contains(p.poly, x, y)).length <= 1);
  }
});

test('导出流程：toBlob 产出 PNG，文件名含日期；无 toBlob 时退回 dataURL；下载链接被点击', async () => {
  const {exportComic, downloadComic, renderComicPage} = await import('../render/comic-render.js');
  const blobCanvas = {toBlob: (cb, type) => cb(new Blob([new Uint8Array([137, 80, 78, 71])], {type}))};
  const out = await exportComic(blobCanvas, {date: new Date(2026, 9, 20, 9, 5)});
  assert.equal(out.type, 'image/png'); assert.equal(out.filename, 'motuo-ride-comic-20261020-0905.png');
  assert.equal(comicFilename(new Date(2026, 0, 2, 3, 4)), 'motuo-ride-comic-20260102-0304.png');
  const url = await exportComic({toDataURL: () => 'data:image/png;base64,iVBOR'}, {toBlob: false});
  assert.match(url.dataURL, /^data:image\/png/);
  await assert.rejects(exportComic({toDataURL: () => 'data:,'}, {toBlob: false}));
  let clicked = null; const doc = {body: {appendChild() {}}, createElement: () => ({click() { clicked = this.download; }, remove() {}})};
  await downloadComic(blobCanvas, doc, {date: new Date(2026, 9, 20, 9, 5)});
  assert.equal(clicked, 'motuo-ride-comic-20261020-0905.png');
  // 整页渲染数据结构（假 DOM，不栅格化）：每格注释即 captionFor(记录值)。
  const dom = createDom(); globalThis.document = dom.doc;
  const {createWorldPainter} = await import('../render/scene.js');
  const moments = selectMoments(demo.record);
  const page = dom.doc.createElement('canvas');
  const res = renderComicPage(page, {record: demo.record, moments, painter: createWorldPainter(), bike: {snapshot: () => dom.doc.createElement('canvas')}});
  assert.equal(page.width, PAGE.W); assert.equal(page.height, PAGE.H);
  assert.equal(res.panels.length, moments.length);
  res.panels.forEach((p, i) => assert.deepEqual(p.caption, captionFor(moments[i])));
  delete globalThis.document;
});
