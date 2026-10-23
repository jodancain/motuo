// 车辆状态估计器（JS 版，与 Swift 权威实现逐条对应）：合成回放各状态、滞回、GPS 丢失、换挡不饱和、固定产物一致、
// 仓库里没有真实骑行数据；设置 MOTUO_REPLAY_FIXTURE 时再跑一遍真实回放指标。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createVehicleStateEstimator, VS} from '../core/vehicle-state.js';
import {generateSynthetic} from '../core/vehicle-synth.js';
import {runReplay, createReplayPlayer} from '../core/vehicle-replay.js';
import {evaluate, matchCorners, parseReferenceCorners} from '../../../tools/vehicle-state/metrics.mjs';
import {build, keySequence, FIXTURE, EXPECTED} from '../../../tools/vehicle-state/make-synthetic.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const synth = generateSynthetic();
const res = runReplay(synth, {simulated: true});

test('合成回放：每种状态都被演出并识别（真值段准确率）', () => {
  const r = evaluate(synth, res);
  assert.ok(r.truth.engine.accuracy >= 0.95, `engine ${r.truth.engine.accuracy}`);
  assert.ok(r.truth.motion.accuracy >= 0.88, `motion ${r.truth.motion.accuracy}`);
  assert.ok(r.truth.turn.accuracy >= 0.95, `turn ${r.truth.turn.accuracy}`);
  assert.ok(r.truthCorners.every(c => c.found), JSON.stringify(r.truthCorners));
  const seen = f => new Set(res.events.filter(e => e.type === 'state' && e.field === f).map(e => e.to));
  for (const s of ['off', 'idle', 'running', 'revving']) assert.ok(seen('engine').has(s), `engine ${s}`);
  for (const s of ['launching', 'accelerating', 'cruising', 'braking', 'hardBraking', 'coasting', 'stopped']) assert.ok(seen('motion').has(s), `motion ${s}`);
  for (const p of ['entry', 'apex', 'exit']) assert.ok(res.snaps.some(s => s.turn.cornerPhase === p), p);
  assert.ok(res.snaps.some(s => s.mount.status === 'converged'));
  assert.ok(res.snaps.every(s => s.source === 'simulated' && s.turn.leanSource === 'inferred'));
});

test('静止时不报加速 / 刹车 / 转弯 / 换挡（手在晃手机、发动机在抖、声音很大）', () => {
  const est = createVehicleStateEstimator(), ev = [];
  const e2 = createVehicleStateEstimator({onEvent: e => ev.push(e)});
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < 1500; i++) {
    const t = i * 0.02;
    for (const x of [est, e2]) {
      x.motion(t, [rnd() * 0.6, rnd() * 0.6, rnd() * 0.6], [-0.2, -0.74, -0.64], [rnd() * 1.5, rnd() * 1.5, rnd() * 1.5]);
      if (i % 50 === 0) x.gps(t, 0, 0.3, 4);
      if (i % 2 === 0) x.acoustic(t, -10 + 8 * rnd());
    }
  }
  assert.equal(ev.filter(e => e.type === 'corner' || e.type === 'suspectedShift').length, 0);
  assert.ok(!ev.some(e => e.type === 'state' && e.field === 'motion' && e.to !== 'stopped'));
  assert.ok(!ev.some(e => e.type === 'state' && e.field === 'turn' && e.to !== 'none'));
  const s = est.snapshot();
  assert.equal(s.accelIntensity, 0); assert.equal(s.brakeIntensity, 0); assert.equal(s.longitudinalG, 0);
});

test('滞回 + 最短持续：门限附近的稳定加速度不抖', () => {
  for (const a of [0.045, -0.06, 0.06]) {
    const ev = [], est = createVehicleStateEstimator({onEvent: e => ev.push(e)});
    let v = 15, seed = 3; const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 6000; i++) {
      const t = i * 0.02; v = Math.max(3, v + a * 9.80665 * 0.02);
      est.motion(t, [rnd() * 0.3, rnd() * 0.3, 0], [0, -0.7071, -0.7071], [0, 0, 0]);
      if (i % 50 === 0) est.gps(t, v + rnd() * 0.2, 0.4, 4);
    }
    const changes = ev.filter(e => e.type === 'state' && e.field === 'motion' && e.t > 10);
    assert.ok(changes.length <= 4, `a=${a}: ${changes.map(c => c.to)}`);
  }
});

test('GPS 丢失：只用 IMU（安装已收敛），置信度降低；没有速度就不判转弯', () => {
  const [g0, g1] = synth.script.gpsLost[0];
  const inside = res.snaps.filter(s => s.t > g0 + 3 && s.t < g1);
  assert.ok(inside.length > 20);
  for (const s of inside) {
    assert.equal(s.speedMps, null); assert.equal(s.longitudinalSource, 'imu');
    assert.ok(s.motion.confidence <= 0.35); assert.equal(s.turn.state, 'none'); assert.equal(s.engine.state, 'running');
  }
});

test('疑似换挡不再定时饱和：只在加速中、需要麦克风、冷却 ≥2.5 s；恒速巡航为 0', () => {
  const shifts = res.events.filter(e => e.type === 'suspectedShift');
  assert.ok(shifts.length >= 1 && shifts.length <= 6, String(shifts.length));
  for (const e of shifts) assert.ok(res.snaps.some(s => Math.abs(s.t - e.t) < 0.11 && ['accelerating', 'launching'].includes(s.motion.state)));
  assert.equal(runReplay(synth, {withMic: false}).events.filter(e => e.type === 'suspectedShift').length, 0, '没有麦克风不报');
  const ev = [], est = createVehicleStateEstimator({onEvent: e => ev.push(e)});
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const up = [0.22, 0.74, 0.64];
  for (let i = 0; i < 30000; i++) {
    const t = i * 0.02, w = 0.3 * Math.sin(2 * Math.PI * 1.7 * t);
    est.motion(t, [rnd() * 0.5, rnd() * 0.5, rnd() * 0.5], up.map(x => -x / 1.0001), up.map(x => x * w + rnd() * 0.2));
    if (i % 50 === 0) est.gps(t, 22.2 + 0.15 * rnd(), 0.4, 4);
    if (i % 2 === 0) est.acoustic(t, -11 + 1.2 * rnd());
  }
  assert.equal(ev.filter(e => e.type === 'suspectedShift').length, 0);
  assert.equal(ev.filter(e => e.type === 'corner').length, 0, '1.7 Hz 支架摆动不是转弯');
});

test('倾斜只作视觉驱动：有上限、左正右负', () => {
  assert.ok(res.snaps.every(s => Math.abs(s.turn.leanEstimateDeg) <= VS.leanMaxDeg));
  for (const s of res.snaps) if (s.turn.cornerPhase === 'apex') assert.equal(Math.sign(s.turn.leanEstimateDeg), s.turn.state === 'left' ? 1 : -1);
});

test('提交的合成回放与期望序列由生成脚本确定性产出（Swift 交叉一致性用）', () => {
  const {text, expected} = build();
  assert.equal(readFileSync(FIXTURE, 'utf8'), text, '运行 node tools/vehicle-state/make-synthetic.mjs 更新');
  assert.equal(readFileSync(EXPECTED, 'utf8'), expected);
  assert.ok(text.length < 1_000_000, `${text.length} 字节`);
  assert.deepEqual(JSON.parse(expected).states, keySequence(res.events).states);
});

test('实时回放播放器：按倍速推进、事件按序吐出、可循环', () => {
  const p = createReplayPlayer(synth, {simulated: true, speedup: 4, loop: true});
  let n = 0, last = null;
  for (let i = 0; i < 400; i++) { const out = p.step(0.1); n += out.events.length; last = out.snapshot; }
  assert.ok(p.loops === 1 && n > 20 && last.t !== null, `${p.loops} ${n}`);
});

test('参考弯匹配规则：一对一、窗口 [起点−3, 终点+1.5]', () => {
  assert.deepEqual(parseReferenceCorners({corners_from_desk_analysis: '估计的 3 个弯：10,20,30 s（…）'}), [10, 20, 30]);
  const m = matchCorners([10, 11, 30], [{start: 9, end: 12}, {start: 40, end: 42}]);
  assert.equal(m.matched, 1); assert.equal(m.extra.length, 1);
});

test('仓库里没有真实骑行数据（ride1 / deid 文件、或含 groundTruthNotes 的回放）', () => {
  const tracked = execFileSync('git', ['ls-files'], {cwd: repo, encoding: 'utf8'}).split('\n').filter(Boolean);
  const bad = tracked.filter(f => /ride1|deid/i.test(f.split('/').pop()) && !/\.(mjs|js|swift|md|py)$/.test(f));
  assert.deepEqual(bad, []);
  for (const f of tracked.filter(f => f.endsWith('.json') && existsSync(repo + f) && statSync(repo + f).size > 200_000)) {
    const head = readFileSync(repo + f, 'utf8').slice(0, 4000);
    assert.ok(!head.includes('groundTruthNotes') && !/真实骑行去标识化/.test(head), `${f} 像真实回放`);
  }
  const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {cwd: repo, encoding: 'utf8'});
  assert.ok(!/ride1-deid/.test(untracked), '工作区出现了 ride1-deid 副本');
  for (const d of ['prototypes', 'fixtures', 'tools']) {
    const walk = p => readdirSync(p, {withFileTypes: true}).flatMap(e => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(`${p}/${e.name}`)) : [`${p}/${e.name}`]));
    assert.ok(!walk(repo + d).some(f => /ride1-deid/.test(f)), `${d}/ 下有 ride1-deid 文件`);
  }
});

test('真实回放指标（仅当 MOTUO_REPLAY_FIXTURE 指向本机文件）', {skip: !(process.env.MOTUO_REPLAY_FIXTURE && existsSync(process.env.MOTUO_REPLAY_FIXTURE))}, () => {
  const data = JSON.parse(readFileSync(process.env.MOTUO_REPLAY_FIXTURE, 'utf8'));
  const r = evaluate(data, runReplay(data));
  assert.ok(r.cornerMatch.matched >= 9, `参考弯 ${r.cornerMatch.matched}/${r.cornerMatch.reference}`);
  assert.equal(r.stops.falseActive, 0); assert.equal(r.stops.falseEvents, 0);
  assert.ok(r.redLight.idleFraction >= 0.95); assert.ok(r.highway.noneFraction >= 0.85);
  assert.ok(r.shift.count < 30, `换挡 ${r.shift.count}`);
});
