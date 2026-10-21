import test from 'node:test';
import assert from 'node:assert/strict';
import {loadShared} from './helpers.mjs';
import {createRideModel} from '../core/ride-model.js';
import {buildComicRecord} from '../core/native-record.js';
import {selectMoments, captionFor, pageSummary} from '../core/comic-layout.js';

const {Signals, Game} = loadShared();
const makeModel = () => createRideModel({signals: Signals, game: Game});
const speeds = [0, 6, 14, 24, 33, 41, 48, 55, 61, 66, 70, 72, 72, 71, 68, 60, 48, 33, 20, 9, 2, 0, 0, 5, 14, 22, 28, 31, 30, 26];
const timeline = speeds.map((v, i) => ({t: i, v}));
const finished = {id: 'r1', distanceM: 812.4, durationS: 30.2, maxSpeedKmh: 72.3, simulated: true, validSpeedSamples: 30, timeline, events: [{t: 13, kind: 'turn'}, {t: 2, kind: 'dataGap'}]};

test('漫画记录以原生保存的时间线为准：读数逐条等于时间线，汇总等于原生汇总', () => {
  const live = {readings: [], events: [], worlds: [{t: 0, world: 'neon'}, {t: 15, world: 'snow'}], milestones: [{t: 8, threshold: 60, tier: 3, newHigh: false, comeback: false, main: 'stamp'}], summary: {score: 4321}};
  const r = buildComicRecord({finished, live, makeModel});
  assert.equal(r.origin, 'native-timeline');
  assert.deepEqual(r.readings.map(x => x.speedKmh), speeds);
  assert.deepEqual(r.readings.map(x => x.t), timeline.map(p => p.t));
  assert.equal(r.readings.find(x => x.t === 20).world, 'snow', '世界取自网页实时记录');
  assert.equal(r.summary.distanceM, 812.4); assert.equal(r.summary.durationS, 30.2); assert.equal(r.summary.maxSpeedKmh, 72.3);
  assert.equal(r.summary.simulated, true); assert.equal(r.summary.score, 4321); assert.equal(r.summary.origin, 'native');
  assert.ok(r.events.some(e => e.kind === 'corner' && e.native && e.t === 13), '原生转向并入过弯');
  assert.ok(!r.events.some(e => e.kind === 'dataGap'));
  assert.equal(r.milestones.length, 1);
  // 漫画每格数字都来自记录
  const moments = selectMoments(r);
  assert.ok(moments.length >= 4);
  const recorded = new Set(r.readings.map(x => String(Math.round(x.speedKmh))));
  for (const m of moments) { const c = captionFor(m); if (m.kind !== 'finish') assert.ok(recorded.has(String(Math.round(m.speedKmh))), c.title); }
  assert.match(pageSummary(r).source, /DEMO · 原生演示骑行/);
  assert.match(pageSummary(r).line, /最高 72 km\/h/);
});
test('实测骑行标注 GPS 实测；时间线缺测点保持缺测，不补值', () => {
  const tl = timeline.map((p, i) => (i === 10 ? {t: p.t, v: null} : p));
  const r = buildComicRecord({finished: {...finished, simulated: false, timeline: tl}, live: null, makeModel});
  assert.equal(r.readings[10].speedKmh, null);
  assert.equal(pageSummary(r).source, '数据：本机记录 · GPS 实测');
  for (const m of selectMoments(r)) assert.equal(captionFor(m).badge, 'GPS 实测');
});
test('时间线不足时退回网页实时记录；两者都不足则不生成', () => {
  const live = {readings: [{t: 1, speedKmh: 20, shown: '20'}, {t: 2, speedKmh: 25, shown: '25'}], events: [], worlds: [{t: 0, world: 'neon'}], milestones: [], summary: {score: 10}};
  const r = buildComicRecord({finished: {...finished, timeline: [{t: 0, v: 3}]}, live, makeModel});
  assert.equal(r.origin, 'live'); assert.equal(r.summary.distanceM, 812.4);
  assert.equal(buildComicRecord({finished: {...finished, timeline: []}, live: null, makeModel}), null);
  assert.equal(buildComicRecord({finished: null, makeModel}), null);
});
test('短骑行（8 条读数）也排满至少 4 格，补的格只用不同的已记录读数', () => {
  const short = {...finished, timeline: [0, 6, 15, 24, 32, 40, 47, 53].map((v, t) => ({t, v}))};
  const r = buildComicRecord({finished: short, live: null, makeModel});
  const moments = selectMoments(r);
  assert.ok(moments.length >= 4, `只有 ${moments.length} 格`);
  const ts = moments.filter(m => m.kind !== 'finish').map(m => m.t);
  assert.equal(new Set(ts).size, ts.length, '每格对应不同读数');
  for (const m of moments) if (m.kind !== 'finish') assert.ok(short.timeline.some(p => p.t === m.t && p.v === m.speedKmh));
});
