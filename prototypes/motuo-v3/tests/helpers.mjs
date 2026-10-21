// v3 测试公共件：在 vm 中加载复制自 v2 的 IIFE 模块，并用真实模块跑完整演示剧本。
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildDemoScript, createDemoPlayer} from '../core/demo-script.js';
import {createRideModel, speedText} from '../core/ride-model.js';
import {createDirector, createFlashLimiter} from '../core/director.js';
import {nextWorld} from '../render/worlds.js';

export const root = new URL('../', import.meta.url);
export function loadShared() {
  const ctx = vm.createContext({window: {}});
  for (const f of ['drive-signals', 'game-events', 'sound-trend', 'motion-kit']) vm.runInContext(readFileSync(new URL(`shared/${f}.js`, root), 'utf8'), ctx);
  return {Signals: ctx.window.MotuoDriveSignals, Game: ctx.window.MotuoGame, Trend: ctx.window.MotuoSoundTrend, Motion: ctx.window.MotuoMotion};
}

/* 按 60fps 推进完整演示；返回每帧显示的速度文本、事件、导演计划、闪光记录与骑行记录。 */
export function simulateDemo({reduced = false, fps = 60, hiddenBetween = null} = {}) {
  const {Signals, Game} = loadShared();
  const script = buildDemoScript();
  const ride = createRideModel({signals: Signals, game: Game});
  const limiter = createFlashLimiter({maxPerSecond: 2});
  const director = createDirector({limiter, reduced: () => reduced});
  let wall = 0, record = null, world = 'neon', phase = 'idle';
  const frames = [], events = [], plans = [], shown = [], phases = [];
  const player = createDemoPlayer(script, {
    countdown: () => { phase = 'countdown'; phases.push({phase, wall}); },
    go: () => { ride.begin({t: 0, source: 'demo', world}); phase = 'riding'; phases.push({phase, wall}); director.requestFlash(wall * 1000, 'go'); },
    reading: f => { frames.push({...f, wall}); ride.ingest(f); },
    cue: c => { if (c.type === 'world') { world = nextWorld(world); ride.setWorld(world); } },
    pause: () => { ride.pause(ride.rideT); phase = 'paused'; phases.push({phase, wall}); },
    resume: () => { ride.resume(ride.rideT); phase = 'riding'; phases.push({phase, wall}); },
    finish: () => { record = ride.finish(ride.rideT); phase = 'done'; phases.push({phase, wall}); },
  });
  ride.onEvent(ev => { events.push({...ev, wall}); const p = director.event(ev, wall * 1000); if (p) plans.push(p); });
  player.start();
  const dt = 1 / fps;
  for (let i = 0; i < 80 * fps && phase !== 'done'; i++) {
    const hidden = hiddenBetween && wall >= hiddenBetween[0] && wall < hiddenBetween[1];
    wall += dt;
    if (hidden) continue; // 页面隐藏：主时钟停止，播放器不推进
    player.advance(dt);
    if (ride.phase === 'riding') ride.tick(player.rideSeconds);
    const active = director.update(wall * 1000);
    if (active && !plans.includes(active)) plans.push(active);
    if (phase === 'riding' || phase === 'paused') shown.push({wall, phase, text: speedText({phase: ride.phase === 'riding' ? 'riding' : 'paused', reading: ride.reading}).text, cutin: !!director.active});
  }
  return {script, frames, events, plans: [...new Set(plans)], shown, phases, record, limiter, director, wall, player};
}
