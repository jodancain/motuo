#!/usr/bin/env node
/* 生成合成回放与 JS 估计器的关键状态序列（Swift 单测据此做交叉一致性检查）。
 *   node tools/vehicle-state/make-synthetic.mjs [--check]
 * 输出 fixtures/vehicle-state/synthetic-ride.json 与 synthetic-expected.json（均为参数生成，非真实数据）。
 * --check：只比较，不写；不一致时退出码 1（node 测试也会做同样检查）。 */
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateSynthetic} from '../../prototypes/motuo-v3/core/vehicle-synth.js';
import {runReplay} from '../../prototypes/motuo-v3/core/vehicle-replay.js';

export const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/vehicle-state/synthetic-ride.json');
export const EXPECTED = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/vehicle-state/synthetic-expected.json');

/* 关键状态序列：状态切换（字段/目标/时刻）、过弯（方向/起止）、疑似换挡（时刻）。时刻保留 0.1 s。 */
export function keySequence(events) {
  const r1 = v => Math.round(v * 10) / 10;
  return {
    states: events.filter(e => e.type === 'state').map(e => ({t: r1(e.t), field: e.field, to: e.to})),
    corners: events.filter(e => e.type === 'corner').map(e => ({dir: e.dir, start: r1(e.start), end: r1(e.end), angleDeg: e.angleDeg})),
    shifts: events.filter(e => e.type === 'suspectedShift').map(e => r1(e.t)),
  };
}
export function build() {
  const data = generateSynthetic();
  const text = JSON.stringify(data);
  const res = runReplay(data, {simulated: true});
  const expected = {about: '由 prototypes/motuo-v3/core/vehicle-state.js 在 synthetic-ride.json 上得到的关键状态序列；Swift 估计器必须一致（VehicleStateTests）。', generator: 'tools/vehicle-state/make-synthetic.mjs', ...keySequence(res.events)};
  return {text, expected: JSON.stringify(expected, null, 1) + '\n'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {text, expected} = build();
  if (process.argv.includes('--check')) {
    const ok = existsSync(FIXTURE) && readFileSync(FIXTURE, 'utf8') === text && existsSync(EXPECTED) && readFileSync(EXPECTED, 'utf8') === expected;
    console.log(ok ? '合成回放与期望序列一致' : '合成回放或期望序列已过期：运行 node tools/vehicle-state/make-synthetic.mjs');
    process.exit(ok ? 0 : 1);
  }
  writeFileSync(FIXTURE, text); writeFileSync(EXPECTED, expected);
  console.log(`写出 ${FIXTURE}（${text.length} 字节）与 ${EXPECTED}`);
}
