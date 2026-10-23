#!/usr/bin/env node
/* 真实 / 合成回放 → 车辆状态估计 → 指标报告。
 *   node tools/vehicle-state/replay-report.mjs <回放.json> [--out <目录>] [--no-mic]
 * 回放文件路径也可用环境变量 MOTUO_REPLAY_FIXTURE。真实骑行文件只在本机读取，绝不复制进仓库；
 * 输出（指标 JSON / Markdown 表 / 绘图用时间序列）写到 --out（默认 artifacts/vehicle-state-20261023/，已 gitignore）。
 * 时间序列只含估计器输出与速度，不含经纬度。 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runReplay} from '../../prototypes/motuo-v3/core/vehicle-replay.js';
import {evaluate} from './metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out') || process.env.MOTUO_REPLAY_FIXTURE;
if (!file || !existsSync(file)) { console.error('用法：replay-report.mjs <回放.json> [--out 目录]（或设 MOTUO_REPLAY_FIXTURE）'); process.exit(2); }
const out = resolve(opt('--out') || resolve(here, '../../artifacts/vehicle-state-20261023'));
mkdirSync(out, {recursive: true});
const data = JSON.parse(readFileSync(file, 'utf8'));
const withMic = !args.includes('--no-mic');
const t0 = performance.now();
const res = runReplay(data, {withMic, simulated: !!data.synthetic});
const ms = performance.now() - t0;
const report = evaluate(data, res);
report.runtimeMs = Math.round(ms);
const tag = opt('--tag') || (data.synthetic ? 'synthetic' : 'real') + (withMic ? '' : '-nomic');
writeFileSync(resolve(out, `metrics-${tag}.json`), JSON.stringify(report, null, 1));
writeFileSync(resolve(out, `metrics-${tag}.md`), report.markdown);
// 绘图用序列（10 Hz）：估计器输出 + GPS 速度；无位置信息。
const series = {t: [], speed: [], longG: [], yaw: [], lean: [], motion: [], engine: [], turn: [], vib: [], level: []};
for (const s of res.snaps) {
  series.t.push(s.t); series.speed.push(s.speedMps); series.longG.push(s.longitudinalG); series.yaw.push(s.turn.yawRateDegS);
  series.lean.push(s.turn.leanEstimateDeg); series.motion.push(s.motion.state); series.engine.push(s.engine.state); series.turn.push(s.turn.state);
  series.vib.push(s.vibrationG); series.level.push(s.sound?.levelDb ?? null);
}
const gps = data.gps ? {t: data.gps.t, v: data.gps.speed_mps} : null;
writeFileSync(resolve(out, `series-${tag}.json`), JSON.stringify({series, events: res.events, gps, reference: report.reference}));
console.log(report.markdown);
console.log(`\n输出：${out}（metrics-${tag}.json / .md、series-${tag}.json）· 用时 ${Math.round(ms)} ms`);
