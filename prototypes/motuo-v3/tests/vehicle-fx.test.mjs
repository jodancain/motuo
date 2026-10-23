// 车辆状态 → 画面参数：方向、强度梯度、强度档、减少动态、低置信度弱化、静止无加减速、速度区可读、闪光限流、剧场让位、原生桥字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import {vehicleVisuals, createVehicleDirector, placeWord, normalizeVehicle, reducedHint, FX_LIMITS, FX_LEVEL_ORDER, confidenceGain} from '../core/vehicle-fx.js';
import {createFlashLimiter, maxFlashesPerSecond} from '../core/director.js';
import {mapSnapshot} from '../native-adapter.js';
import {generateSynthetic} from '../core/vehicle-synth.js';
import {runReplay} from '../core/vehicle-replay.js';

const base = {source: 'inferred', engine: 'running', engineConf: .9, motion: 'cruising', motionConf: .8, longG: 0, accel: 0, brake: 0, turn: 'none', yawDegS: 0, lean: 0, phase: 'none', turnConf: 0, mount: 'converged', mountConf: .8};
const v = o => ({...base, ...o});

test('转弯方向：左弯逆时针（负角）、右弯顺时针，弯内侧集中线在对应一侧，有上限', () => {
  const L = vehicleVisuals(v({turn: 'left', lean: 30, yawDegS: 20, phase: 'apex', turnConf: .8}));
  const R = vehicleVisuals(v({turn: 'right', lean: -30, yawDegS: -20, phase: 'apex', turnConf: .8}));
  assert.ok(L.tiltDeg < 0 && R.tiltDeg > 0, `${L.tiltDeg} ${R.tiltDeg}`);
  assert.ok(L.bikeRollDeg < 0 && R.bikeRollDeg > 0);
  assert.equal(L.innerSide, 'left'); assert.equal(R.innerSide, 'right');
  assert.ok(L.bend < 0 && R.bend > 0);
  const huge = vehicleVisuals(v({turn: 'left', lean: 60, turnConf: 1, phase: 'apex'}), {level: 'max'});
  assert.ok(Math.abs(huge.tiltDeg) <= FX_LIMITS.tiltDeg && Math.abs(huge.bikeRollDeg) <= FX_LIMITS.bikeRollDeg);
  const wide = vehicleVisuals(v({turn: 'left', lean: 60, turnConf: 1}), {level: 'max', aspect: 844 / 390});
  assert.ok(Math.abs(wide.tiltDeg) <= FX_LIMITS.tiltLandscapeDeg, '横屏上限更小');
  assert.ok(wide.zoom > wide.fov, '倾斜时补缩放');
});

test('加速强度梯度：起步 → 全油门，每项连续效果单调增强（一眼可见）', () => {
  const steps = [0.1, 0.35, 0.6, 0.9].map(a => vehicleVisuals(v({motion: 'accelerating', accel: a, longG: a * .24})));
  for (const key of ['warp', 'flameLen', 'edgeLines', 'parallax', 'speedStretch', 'shakePx']) {
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i][key] > steps[i - 1][key], `${key} ${steps.map(s => s[key])}`);
  }
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].fov < steps[i - 1].fov && steps[i].speedSkewDeg < steps[i - 1].speedSkewDeg);
  assert.equal(steps[0].wheelie, 0); assert.ok(steps[3].wheelie > 0, '强加速抬头');
  assert.ok(steps[3].speedStretch <= FX_LIMITS.speedStretch && steps[3].speedSkewDeg >= FX_LIMITS.speedSkewDeg, '速度数字拉伸有上限');
});

test('刹车分级：刹车 < 急刹 < 极限急刹；车头下沉、刹车灯、收线', () => {
  const b = vehicleVisuals(v({motion: 'braking', brake: .3, longG: -.12}));
  const h = vehicleVisuals(v({motion: 'hardBraking', brake: .6, longG: -.3}));
  const x = vehicleVisuals(v({motion: 'hardBraking', brake: .95, longG: -.45}));
  assert.deepEqual([b.brakeTier, h.brakeTier, x.brakeTier], [1, 2, 3]);
  assert.ok(b.dive < h.dive && h.dive < x.dive && b.brakeGlow < x.brakeGlow && b.reverseLines < x.reverseLines);
});

test('静止：不出加速 / 刹车效果；熄火压暗、怠速抖动与排气、轰油门火焰', () => {
  const stopped = vehicleVisuals(v({motion: 'stopped', accel: .9, brake: .9, engine: 'idle'}));
  assert.equal(stopped.accel, 0); assert.equal(stopped.brakeTier, 0); assert.equal(stopped.warp, 0); assert.equal(stopped.tiltDeg, 0);
  assert.ok(stopped.idleJitter > 0 && stopped.puff > 0 && stopped.ripple > 0);
  assert.ok(vehicleVisuals(v({motion: 'stopped', engine: 'off'})).dim > .5);
  const rev = vehicleVisuals(v({motion: 'stopped', engine: 'revving'}));
  assert.ok(rev.revFlame > 0 && rev.idleJitter > stopped.idleJitter);
});

test('强度档：关 < 弱 < 标准 < 强；“关”不倾斜不震动', () => {
  const s = FX_LEVEL_ORDER.map(level => vehicleVisuals(v({turn: 'right', lean: -25, turnConf: .8, motion: 'accelerating', accel: .7}), {level}));
  for (let i = 2; i < s.length; i++) assert.ok(Math.abs(s[i].tiltDeg) >= Math.abs(s[i - 1].tiltDeg) && s[i].shakePx >= s[i - 1].shakePx);
  assert.equal(s[0].tiltDeg, 0); assert.equal(s[0].shakePx, 0); assert.equal(s[0].bikeRollDeg, 0);
  assert.ok(Math.abs(s[1].tiltDeg) < Math.abs(s[2].tiltDeg));
});

test('减少动态：不倾斜、不震动、不缩放，只用颜色 / 图标示意', () => {
  for (const o of [{turn: 'left', lean: 30, turnConf: .9}, {motion: 'hardBraking', brake: .9}, {motion: 'accelerating', accel: .9}, {motion: 'stopped', engine: 'revving'}]) {
    const r = vehicleVisuals(v(o), {reduced: true});
    for (const key of ['tiltDeg', 'bikeRollDeg', 'shakePx', 'warp', 'lunge', 'dive', 'wheelie', 'idleJitter']) assert.equal(r[key], 0, `${JSON.stringify(o)} ${key}`);
    assert.equal(r.fov, FX_LIMITS.fovMax); assert.ok(r.icons.length > 0); assert.ok(reducedHint(r).length > 0);
  }
  assert.match(reducedHint(vehicleVisuals(v({turn: 'left', lean: 20, turnConf: .8}), {reduced: true})), /左弯/);
});

test('低置信度弱化：同样的状态，置信度低效果小', () => {
  const hi = vehicleVisuals(v({turn: 'left', lean: 30, turnConf: .9, motion: 'accelerating', accel: .8, motionConf: .8}));
  const lo = vehicleVisuals(v({turn: 'left', lean: 30, turnConf: .25, motion: 'accelerating', accel: .8, motionConf: .25}));
  assert.ok(Math.abs(lo.tiltDeg) < Math.abs(hi.tiltDeg) * .6 && lo.warp < hi.warp * .6);
  assert.ok(confidenceGain(0) >= .25 && confidenceGain(1) === 1);
});

test('剧场 / 分镜进行中：连续效果减半；导演只保留急刹的字', () => {
  const a = vehicleVisuals(v({turn: 'left', lean: 30, turnConf: .9})), b = vehicleVisuals(v({turn: 'left', lean: 30, turnConf: .9}), {theatre: true});
  assert.ok(Math.abs(b.tiltDeg - a.tiltDeg / 2) < 1e-9);
  const d = createVehicleDirector();
  d.step(v({}), 0); const out = d.step(v({turn: 'left', lean: 25, turnConf: .9}), 1000, {theatre: true});
  assert.equal(out.filter(o => o.type === 'word').length, 0);
  const hard = d.step(v({turn: 'left', lean: 25, motion: 'hardBraking', brake: .8}), 3000, {theatre: true});
  assert.ok(hard.some(o => o.type === 'word' && o.kind === 'hard'));
});

test('拟声字落点永远避开速度区（横竖屏多种尺寸 × 各方向）', () => {
  for (const [W, H, speed] of [[844, 390, {x: 520, y: 18, w: 300, h: 170}], [390, 844, {x: 40, y: 20, w: 330, h: 190}], [1180, 820, {x: 760, y: 30, w: 400, h: 230}], [667, 375, {x: 400, y: 15, w: 250, h: 150}]]) {
    for (const side of ['left', 'right', 'front', 'rear']) for (const size of [30, 50, 80]) {
      const at = placeWord({W, H, speed, side, size, bike: {x: W * .4, y: H * .62}});
      if (!at) continue;
      const b = at.box, pad = 12;
      assert.ok(!(b.x < speed.x + speed.w + pad && b.x + b.w > speed.x - pad && b.y < speed.y + speed.h + pad && b.y + b.h > speed.y - pad), `${W}x${H} ${side} ${size}`);
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H);
    }
  }
});

test('闪光限流：整段合成回放连续急刹 / 起步，冲击帧经限流，任意 1 s ≤ 3 次', () => {
  const limiter = createFlashLimiter({maxPerSecond: 2});
  const d = createVehicleDirector({requestFlash: (t, k) => limiter.allow(t, k)});
  const res = runReplay(generateSynthetic(), {simulated: true});
  let impacts = 0;
  res.snaps.forEach((s, i) => { for (const o of d.step(s, i * 100)) if (o.type === 'impact') impacts++; });
  // 极端：每 100 ms 一次急刹切换
  for (let i = 0; i < 50; i++) { d.step(v({motion: 'cruising'}), 100000 + i * 100); d.step(v({motion: 'hardBraking', brake: .9}), 100050 + i * 100); }
  assert.ok(impacts >= 1, '合成回放里的急刹出冲击帧');
  assert.ok(maxFlashesPerSecond(limiter.log.map(l => l.t)) <= 3);
  const words = d.log.filter(o => o.type === 'word');
  assert.ok(words.some(w => w.kind === 'cornerIn') && words.some(w => w.kind === 'hard') && words.some(w => w.kind === 'launch') && words.some(w => w.kind === 'rev') && words.some(w => w.kind === 'ignite'), [...new Set(words.map(w => w.kind))].join());
});

test('连续弯有节奏：间隔短的第二个弯出“连弯”字', () => {
  const d = createVehicleDirector({cooldownMs: 0});
  d.step(v({}), 0);
  const a = d.step(v({turn: 'left', lean: 20, turnConf: .8}), 1000), b = d.step(v({turn: 'right', lean: -20, turnConf: .8}), 2500);
  assert.equal(a.find(o => o.type === 'word').kind, 'cornerIn');
  assert.ok(b.some(o => o.type === 'word' && o.chain >= 2));
});

test('原生桥：vehicle 字段只在骑行中且快照新鲜时转发；非法值被归一化', () => {
  const snap = {phase: 'riding', seconds: 10, speedKmh: 40, speedSource: 'gps', sampleTime: 1, vehicle: {...base, motion: 'braking', brake: 2, turn: 'sideways'}};
  const m = mapSnapshot(snap, {receivedAt: 0, now: 0});
  const n = normalizeVehicle(m.vehicle);
  assert.equal(n.motion, 'braking'); assert.equal(n.brake, 1); assert.equal(n.turn, 'none');
  assert.equal(mapSnapshot({...snap, phase: 'paused'}).vehicle, null);
  assert.equal(mapSnapshot(snap, {receivedAt: 0, now: 5000}).vehicle, null);
  assert.equal(normalizeVehicle({motion: 'flying'}), null);
});
