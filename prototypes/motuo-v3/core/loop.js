/* 单一 rAF 主时钟 + 三档性能调度（高 / 中 / 低，带滞回，可手动固定）。
 * 所有渲染任务共用这一个时钟；页面隐藏即停，恢复时不补帧。
 * 依赖全部注入，便于 node 测试。
 */

export const TIERS = Object.freeze(['high', 'mid', 'low']);
export const TIER_CONFIG = Object.freeze({
  high: Object.freeze({key: 'high', label: '高', dpr: 2, bikeDpr: 1.5, bikeFps: 12, fxFps: 30, particles: 1, misprint: true, grain: true}),
  mid: Object.freeze({key: 'mid', label: '中', dpr: 1.5, bikeDpr: 1.25, bikeFps: 12, fxFps: 30, particles: .6, misprint: true, grain: false}),
  low: Object.freeze({key: 'low', label: '低', dpr: 1, bikeDpr: 1, bikeFps: 8, fxFps: 20, particles: .3, misprint: false, grain: false}),
});

/* 帧间隔 EMA 超过 slowMs 持续 downAfterMs 降一档；低于 fastMs 持续 upAfterMs 升一档。
 * 升档要求更久（滞回），避免在临界处来回跳。 */
export function createPerfGovernor({slowMs = 22, fastMs = 17.5, downAfterMs = 1500, upAfterMs = 6000, onChange = null} = {}) {
  let mode = 'auto', tier = 'high', ema = 1000 / 60, slowFor = 0, fastFor = 0, cap = null;
  const listeners = new Set(onChange ? [onChange] : []);
  const set = (next, reason) => {
    if (cap && TIERS.indexOf(next) < TIERS.indexOf(cap)) next = cap;
    if (next === tier) return;
    tier = next;
    for (const fn of [...listeners]) fn(tier, reason);
  };
  return {
    feed(delta) {
      if (mode !== 'auto') return tier;
      // 切后台、调试器断点产生的超长间隔不计入。
      if (!(delta > 0) || delta > 250) return tier;
      ema += (delta - ema) * .1;
      if (ema > slowMs) { slowFor += delta; fastFor = 0; }
      else if (ema < fastMs) { fastFor += delta; slowFor = 0; }
      else { slowFor = 0; fastFor = 0; }
      const i = TIERS.indexOf(tier);
      if (slowFor >= downAfterMs && i < TIERS.length - 1) { slowFor = 0; set(TIERS[i + 1], 'slow-frames'); }
      else if (fastFor >= upAfterMs && i > 0) { fastFor = 0; set(TIERS[i - 1], 'recovered'); }
      return tier;
    },
    setMode(next) {
      mode = TIERS.includes(next) ? next : 'auto';
      slowFor = fastFor = 0;
      if (mode !== 'auto') set(mode, 'manual');
    },
    // 原生热压力等外部提示：自动模式下不高于给定档位。
    setCap(next) { cap = TIERS.includes(next) ? next : null; if (cap && mode === 'auto') set(tier, 'cap'); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get tier() { return tier; }, get mode() { return mode; }, get ema() { return ema; },
    get config() { return TIER_CONFIG[tier]; },
  };
}

/* 任务：fn(now, dt)；fps 指定时按该帧率步进（“一拍二”）。返回 false 自动移除。 */
export function createLoop({raf, caf, now, hidden = () => false, governor = null, onFrame = null} = {}) {
  const tasks = new Set();
  let handle = 0, running = false, last = 0, frames = 0;
  function tick() {
    handle = 0;
    if (!running) return;
    if (hidden()) { running = false; last = 0; return; }
    const t = now(), delta = last ? t - last : 1000 / 60;
    last = t; frames++;
    governor?.feed(delta);
    onFrame?.(t, delta);
    for (const task of [...tasks]) {
      if (!tasks.has(task)) continue;
      const fps = typeof task.fps === 'function' ? task.fps() : task.fps;
      if (fps && task.lastRun && t - task.lastRun < 1000 / fps - 2) continue;
      const dt = task.lastRun ? Math.min(.1, (t - task.lastRun) / 1000) : 1 / 60;
      task.lastRun = t;
      let keep;
      try { keep = task.fn(t, dt); } catch (error) { tasks.delete(task); setTimeout(() => { throw error; }, 0); continue; }
      if (keep === false) tasks.delete(task);
    }
    if (tasks.size) handle = raf(tick); else { running = false; last = 0; }
  }
  function start() {
    if (running || hidden() || !tasks.size) return;
    running = true; handle = raf(tick);
  }
  function stop() { if (handle) caf?.(handle); handle = 0; running = false; last = 0; }
  return {
    add(fn, {fps = 0, name = ''} = {}) {
      const task = {fn, fps, name, lastRun: 0};
      tasks.add(task); start();
      return () => tasks.delete(task);
    },
    visibilityChanged() { if (hidden()) stop(); else { last = 0; for (const t of tasks) t.lastRun = 0; start(); } },
    start, stop,
    get running() { return running; }, get taskCount() { return tasks.size; }, get frames() { return frames; },
  };
}
