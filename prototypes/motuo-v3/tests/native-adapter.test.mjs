import test from 'node:test';
import assert from 'node:assert/strict';
import {mapSnapshot, NATIVE_STALE_MS, installNativeAdapter, nativeMessage, tierCap, rideTitle, NATIVE_ACTIONS} from '../native-adapter.js';

const snap = (o = {}) => ({phase: 'riding', seconds: 12, distanceM: 140, speedKmh: 42.4, sampleTime: 101.7, speedSampleTime: 101.5, speedSampleElapsed: 11.8, speedSource: 'gps', motion: 'cruise', simulated: false, ...o});
test('快照映射为读数帧：时刻取读数时的骑行计时，身份取原生读数时刻，不改写数值', () => {
  const m = mapSnapshot(snap(), {receivedAt: 0, now: 100});
  assert.deepEqual(m.frame, {t: 11.8, speedKmh: 42.4, source: 'gps', simulated: false, motion: 'cruise', uncertaintyKmh: null});
  assert.equal(m.sampleKey, 'gps:101.5');
  assert.equal(m.distanceM, 140); assert.equal(m.elapsedS, 12); assert.equal(m.title, '路上见');
  // 旧原生（没有 speedSampleElapsed）：退回骑行计时；读数时刻不会超过当前计时
  assert.equal(mapSnapshot(snap({speedSampleElapsed: undefined}), {}).frame.t, 12);
  assert.equal(mapSnapshot(snap({speedSampleElapsed: 99}), {}).frame.t, 12);
});
test('惯导 → inertial（每个快照都是新估计）；无效、过期、非骑行 → 不给速度', () => {
  const ins = mapSnapshot(snap({speedSource: 'inertial', uncertaintyKmh: 3}), {});
  assert.equal(ins.frame.source, 'inertial'); assert.equal(ins.sampleKey, 'inertial:101.7'); assert.equal(ins.frame.uncertaintyKmh, 3);
  const none = mapSnapshot(snap({speedSource: 'unavailable'}), {});
  assert.equal(none.frame.speedKmh, null); assert.equal(none.sampleKey, 'unavailable:none');
  assert.equal(mapSnapshot(snap(), {receivedAt: 0, now: NATIVE_STALE_MS + 1}).frame.speedKmh, null);
  assert.equal(mapSnapshot(snap({speedKmh: -3}), {}).frame.speedKmh, null);
  assert.equal(mapSnapshot(snap({phase: 'paused'}), {}).frame, null);
  assert.equal(mapSnapshot(snap({phase: 'paused'}), {}).title, '暂停中');
  assert.equal(mapSnapshot({phase: 'weird'}), null);
  assert.equal(mapSnapshot(snap({motion: 'warp'}), {}).frame.motion, 'ready');
});
test('声浪只在 live 且非暂停时有效；32 段频谱折成 16 段', () => {
  const m = mapSnapshot(snap({sound: {live: true, level: .5, spectrum: Array(32).fill(.4), status: '正在聆听'}}), {});
  assert.equal(m.sound.valid, true); assert.equal(m.sound.bands.length, 16); assert.ok(Math.abs(m.sound.bands[3] - .4) < 1e-9);
  assert.equal(mapSnapshot(snap({phase: 'paused', sound: {live: true}}), {}).sound.valid, false);
  assert.equal(mapSnapshot(snap({sound: {live: false, status: '麦克风未授权'}}), {}).sound.status, '麦克风未授权');
});
test('发热 serious/critical 与低电量模式 → 低档封顶；nominal/fair 不封顶', () => {
  assert.equal(tierCap({thermalState: 'serious'}), 'low');
  assert.equal(tierCap({thermalState: 'critical'}), 'low');
  assert.equal(tierCap({thermalState: 'nominal', lowPower: true}), 'low');
  assert.equal(tierCap({thermalState: 'fair'}), null);
  assert.equal(tierCap({thermalState: 'nominal', thermal: true}), null, '有 thermalState 时以它为准');
  assert.equal(tierCap({thermal: true}), 'low', '旧版布尔 thermal');
  assert.equal(mapSnapshot(snap({thermalState: 'critical', thermal: true}), {}).cap, 'low');
  assert.equal(mapSnapshot(snap({lowPower: true}), {}).cap, 'low');
  assert.equal(mapSnapshot(snap(), {}).cap, null);
});
test('外观、面板请求、模态、可见、演示开关、复盘汇总逐字段清洗', () => {
  const m = mapSnapshot(snap({modal: true, active: false, demoMode: true, appearance: {paint: 'stealth', finish: 'chrome', world: 'snow', extra: 1}, panel: {id: 'p1', name: 'garage'},
    finishedRide: {id: 'r1', distanceM: 1200, durationS: 300, maxSpeedKmh: 66.2, simulated: true, validSpeedSamples: 290, timeline: [{t: 0, v: 0}, {t: 1, v: -2}, {t: 'x', v: 3}, {t: 2, v: 18}], events: [{t: 4, kind: 'turn'}, {t: 'bad', kind: 'turn'}]}}), {});
  assert.equal(m.modal, true); assert.equal(m.active, false); assert.equal(m.demoMode, true);
  assert.deepEqual(m.appearance, {paint: 'stealth', world: 'snow'});
  assert.deepEqual(m.panel, {id: 'p1', name: 'garage'});
  assert.equal(mapSnapshot(snap({panel: {id: 'p2', name: 'eval'}}), {}).panel, null);
  assert.equal(mapSnapshot(snap({appearance: {paint: 'gold'}}), {}).appearance, null);
  assert.deepEqual(m.finishedRide.timeline, [{t: 0, v: 0}, {t: 1, v: null}, {t: 2, v: 18}]);
  assert.deepEqual(m.finishedRide.events, [{t: 4, kind: 'turn'}]);
  assert.equal(m.finishedRide.maxSpeedKmh, 66.2); assert.equal(m.finishedRide.simulated, true);
  assert.equal(mapSnapshot(snap(), {}).active, true, '旧原生没有 active 字段时视为可见');
  assert.equal(rideTitle('idle'), '准备出发');
});
test('网页 → 原生消息：只发白名单动作，参数只留允许的键与取值', () => {
  assert.equal(nativeMessage('eval'), null);
  assert.deepEqual(nativeMessage('primary', {x: 1}), {action: 'primary'});
  assert.deepEqual(nativeMessage('appearance', {paint: 'ember', finish: 'satin', world: 'cosmic', code: 'x'}), {action: 'appearance', paint: 'ember', finish: 'satin', world: 'cosmic'});
  assert.deepEqual(nativeMessage('appearance', {paint: 'gold', finish: 'gloss'}), {action: 'appearance', finish: 'gloss'});
  assert.equal(nativeMessage('appearance', {paint: 'gold'}), null);
  assert.equal(nativeMessage('share', {png: 'data:text/html;base64,AAA'}), null);
  assert.deepEqual(nativeMessage('share', {png: 'data:image/png;base64,iVBOR', name: 'x'}), {action: 'share', png: 'data:image/png;base64,iVBOR'});
  for (const a of NATIVE_ACTIONS) if (!['appearance', 'share'].includes(a)) assert.deepEqual(nativeMessage(a), {action: a});
});
function harness() {
  const sent = [], calls = [];
  const win = {webkit: {messageHandlers: {motuo: {postMessage: m => sent.push(m)}}}, setInterval() {}, performance: {now: () => 0}};
  const app = {
    nativeActive: on => calls.push(['active', on]), nativeFlags: m => calls.push(['flags', m.modal]), nativeAppearance: a => calls.push(['appearance', a.paint]),
    nativePhase: (p, o) => calls.push(['phase', p, o]), nativeReading: f => calls.push(['reading', f.t, f.speedKmh]), nativePanel: n => calls.push(['panel', n]),
    nativeFinished: f => calls.push(['finished', f.id, sent.map(m => m.action).join(',')]), nativeRecapReleased: () => calls.push(['released']), nativeStale() {},
  };
  return {sent, calls, win, adapter: installNativeAdapter(app, win)};
}
test('MotuoNativeReceive：ready 由应用就绪后发送；同一读数只计一次；缺测只记一次；阶段先于读数', () => {
  const {sent, calls, win, adapter} = harness();
  assert.equal(adapter.native, true); assert.deepEqual(sent, []);
  adapter.ready(); assert.deepEqual(sent.map(m => m.action), ['ready']);
  win.MotuoNativeReceive(snap()); win.MotuoNativeReceive(snap({sampleTime: 101.8})); win.MotuoNativeReceive(snap({speedSampleTime: 102.5, speedSampleElapsed: 12.8, seconds: 13, speedKmh: 45}));
  win.MotuoNativeReceive(snap({speedSource: 'unavailable', speedKmh: null, seconds: 14})); win.MotuoNativeReceive(snap({speedSource: 'unavailable', speedKmh: null, seconds: 14.1}));
  const readings = calls.filter(c => c[0] === 'reading');
  assert.deepEqual(readings.map(c => [c[1], c[2]]), [[11.8, 42.4], [12.8, 45], [14, null]]);
  const order = calls.map(c => c[0]);
  assert.ok(order.indexOf('phase') < order.indexOf('reading'), '先进入骑行再计读数');
});
test('MotuoNativeReceive：复盘只接手一次且先回传 wrappedShown；原生撤回后网页收起；面板与外观去重；可见性变化', () => {
  const {sent, calls, win} = harness();
  const fr = {id: 'r1', distanceM: 1, durationS: 2, maxSpeedKmh: 3, timeline: []};
  win.MotuoNativeReceive(snap({phase: 'idle', finishedRide: fr, appearance: {paint: 'panda'}, panel: {id: 'a', name: 'garage'}}));
  win.MotuoNativeReceive(snap({phase: 'idle', finishedRide: fr, appearance: {paint: 'panda'}, panel: {id: 'a', name: 'garage'}}));
  assert.deepEqual(calls.filter(c => c[0] === 'finished'), [['finished', 'r1', 'wrappedShown']]);
  assert.equal(calls.filter(c => c[0] === 'appearance').length, 1);
  assert.equal(calls.filter(c => c[0] === 'panel').length, 1);
  win.MotuoNativeReceive(snap({phase: 'idle'}));
  assert.equal(calls.filter(c => c[0] === 'released').length, 1);
  win.MotuoNativeReceive(snap({phase: 'idle', active: false})); win.MotuoNativeReceive(snap({phase: 'idle', active: false})); win.MotuoNativeReceive(snap({phase: 'idle'}));
  assert.deepEqual(calls.filter(c => c[0] === 'active').map(c => c[1]), [false, true]);
  assert.deepEqual(sent.map(m => m.action), ['wrappedShown']);
});
test('浏览器预览（没有 webkit 桥）：不注册发送，不发任何消息', () => {
  const win = {};
  const a = installNativeAdapter({}, win);
  assert.equal(a.native, false); assert.equal(a.send('primary'), false); assert.equal(typeof win.MotuoNativeReceive, 'function');
});
