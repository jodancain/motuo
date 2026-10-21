/* 演示驾驶剧本：约 60 秒的完整剧情，全部数据为 DEMO。
 * 读数是 1Hz 离散帧（与 iPhone GPS 速率一致），播放器只在跨过帧时刻时整帧发出，
 * 绝不在两帧之间插值；页面隐藏时播放器不推进（由主时钟驱动）。
 *
 * 时间轴（墙钟）：倒计时 4.0s → 骑行 53.5s（突破 20…100、过弯、换关卡、急刹）→ 暂停 4s → 继续（回归突破）→ 结束 → 漫画。
 */

export const DEMO_COUNTDOWN_S = 4.0;
export const DEMO_PAUSE_HOLD_S = 4.0;

// [骑行秒, km/h, 运动状态]。运动状态与 v2 / 原生 motion 取值一致。
const TRACK = [
  // 第一段：起步，依次突破 20 / 30 / 40 / 50 / 60（每个阈值间隔约 3s，留给“突破剧场”）
  [0, 0, 'ready'], [1, 5, 'launch'], [2, 12, 'accelerate'], [3, 18, 'accelerate'], [4, 22, 'accelerate'],
  [5, 26, 'accelerate'], [6, 29, 'accelerate'], [7, 33, 'accelerate'], [8, 36, 'accelerate'], [9, 39, 'accelerate'],
  [10, 43, 'accelerate'], [11, 46, 'accelerate'], [12, 49, 'accelerate'], [13, 53, 'accelerate'], [14, 56, 'accelerate'],
  [15, 59, 'accelerate'], [16, 63, 'cruise'],
  // 过弯（换关卡在弯后）
  [17, 61, 'turn'], [18, 57, 'turn'], [19, 55, 'turn'], [20, 56, 'turn'],
  // 第二段：再加速突破 80，并冲到 100+（大事件）
  [21, 60, 'accelerate'], [22, 66, 'accelerate'], [23, 71, 'accelerate'], [24, 76, 'accelerate'], [25, 81, 'accelerate'],
  [26, 86, 'accelerate'], [27, 90, 'accelerate'], [28, 94, 'accelerate'], [29, 98, 'accelerate'], [30, 102, 'accelerate'],
  [31, 104, 'cruise'], [32, 105, 'cruise'], [33, 105, 'cruise'], [34, 104, 'cruise'],
  // 急刹到停，暂停在 43.2s
  [35, 92, 'brake'], [36, 76, 'brake'], [37, 60, 'brake'], [38, 44, 'brake'], [39, 30, 'brake'],
  [40, 18, 'brake'], [41, 9, 'brake'], [42, 3, 'stop'], [43, 0, 'stop'],
  // 继续：再起步，再次突破 20 / 30（“回归”演出），然后停下结束
  [44, 0, 'ready'], [45, 7, 'launch'], [46, 15, 'accelerate'], [47, 22, 'accelerate'], [48, 28, 'accelerate'],
  [49, 33, 'cruise'], [50, 28, 'brake'], [51, 18, 'brake'], [52, 8, 'brake'], [53, 0, 'stop'],
];

// 声浪 DEMO：合成特征随剧本走（明确标 DEMO，不冒充发动机声音）。
function demoSound(speed, prev, motion) {
  const accel = Math.max(0, speed - prev) / 8;
  const level = motion === 'stop' || motion === 'ready' ? .18 : Math.min(1, .28 + speed / 140 + accel * .35);
  return Math.round(level * 100) / 100;
}

export function buildDemoScript() {
  const frames = TRACK.map(([t, speedKmh, motion], i) => ({
    t, speedKmh, motion, source: 'gps', simulated: true,
    soundLevel: demoSound(speedKmh, i ? TRACK[i - 1][1] : 0, motion),
  }));
  const cues = [
    {t: 20.4, type: 'world', world: 'next', note: '换关卡 · 演示'},
    {t: 43.2, type: 'pause', holdS: DEMO_PAUSE_HOLD_S},
    {t: 53.5, type: 'finish'},
  ];
  return Object.freeze({countdownS: DEMO_COUNTDOWN_S, frames: Object.freeze(frames), cues: Object.freeze(cues), simulated: true, rateHz: 1});
}

/* 播放器：advance(dtSeconds) 由主时钟调用；hidden 时调用方不调用 advance。
 * handlers: countdown(), go(), reading(frame), cue(cue), pause(), resume(), finish() */
export function createDemoPlayer(script, handlers = {}) {
  let wall = 0, ride = 0, phase = 'idle', frameIndex = 0, cueIndex = 0, pauseLeft = 0, skipRequested = false;
  const call = (name, arg) => handlers[name]?.(arg);
  function start() {
    wall = 0; ride = 0; frameIndex = 0; cueIndex = 0; pauseLeft = 0; skipRequested = false;
    phase = 'countdown'; call('countdown');
  }
  function go() {
    phase = 'riding'; ride = 0; call('go');
    emitDue();
  }
  function emitDue() {
    while (phase === 'riding' && frameIndex < script.frames.length && script.frames[frameIndex].t <= ride + 1e-9) {
      call('reading', script.frames[frameIndex++]);
    }
    while (phase === 'riding' && cueIndex < script.cues.length && script.cues[cueIndex].t <= ride + 1e-9) {
      const cue = script.cues[cueIndex++];
      if (cue.type === 'pause') { phase = 'paused'; pauseLeft = cue.holdS; call('pause', cue); return; }
      if (cue.type === 'finish') { phase = 'done'; call('finish', cue); return; }
      call('cue', cue);
    }
  }
  function advance(dt) {
    if (!(dt > 0)) return phase;
    dt = Math.min(dt, .25);
    wall += dt;
    if (phase === 'countdown') {
      if (skipRequested || wall >= script.countdownS) go();
      return phase;
    }
    if (phase === 'paused') {
      pauseLeft -= dt;
      if (pauseLeft <= 0) { phase = 'riding'; call('resume'); emitDue(); }
      return phase;
    }
    if (phase === 'riding') { ride += dt; emitDue(); }
    return phase;
  }
  return {
    start, advance,
    skipCountdown() { if (phase === 'countdown') { skipRequested = true; go(); } },
    // 用户手动暂停 / 继续（剧本内的暂停到时自动继续，手动暂停需手动继续）。
    hold() { if (phase === 'riding') { phase = 'paused'; pauseLeft = Infinity; call('pause', {type: 'pause', manual: true}); } },
    release() { if (phase === 'paused') { phase = 'riding'; pauseLeft = 0; call('resume'); emitDue(); } },
    stop() { phase = 'idle'; },
    get phase() { return phase; }, get rideSeconds() { return ride; }, get wallSeconds() { return wall; },
    get countdownLeft() { return phase === 'countdown' ? Math.max(0, script.countdownS - wall) : 0; },
  };
}
