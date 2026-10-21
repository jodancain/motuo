/* 旋转 / 改尺寸生命周期。两段式，避免每帧重建缓冲：
 *  - live：每次 resize 合并到下一帧，只做廉价的 DOM 版式（横竖屏类名、速度巨字字号与位置），速度始终可读；
 *    画布保持旧缓冲、由 CSS 拉伸到新尺寸（不清空，所以不黑屏、不闪白）。
 *  - settled：尺寸稳定 settleMs 后才按新尺寸与 devicePixelRatio 重建画布缓冲、重排车/分镜/剧场/倒计时。
 * 依赖注入，便于 node 测试。 */
export function createResizeController({measure, live, settle, schedule = f => requestAnimationFrame(f), setTimer = setTimeout, clearTimer = clearTimeout, settleMs = 160}) {
  let applied = null, pending = null, frame = false, timer = null, liveCount = 0, settleCount = 0;
  const same = (a, b) => !!a && !!b && a.W === b.W && a.H === b.H && a.dpr === b.dpr && a.key === b.key;
  function onFrame() {
    frame = false;
    const size = measure();
    if (same(size, pending ?? applied)) { if (!pending) return; }
    else { pending = size; liveCount++; live(size); }
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      const final = measure();
      if (!same(final, pending)) { pending = final; liveCount++; live(final); }
      if (!same(final, applied)) { applied = final; settleCount++; settle(final); }
      pending = null;
    }, settleMs);
  }
  return {
    request() { if (!frame) { frame = true; schedule(onFrame); } },
    // 首次或需要立即应用（例如画质档位变化）：跳过防抖。
    now() { const s = measure(); if (timer) { clearTimer(timer); timer = null; } pending = null; live(s); applied = s; settleCount++; settle(s); },
    get applied() { return applied; }, get pending() { return pending; },
    get counts() { return {live: liveCount, settle: settleCount}; },
  };
}
