/* 本地合成 UI 音效（Web Audio）：短促、可关、默认开。不加载任何音频文件。
 * AudioContext 在第一次用户手势时创建；页面隐藏时挂起。 */
export function createSfx({enabled = true} = {}) {
  let ctx = null, master = null, on = enabled, noiseBuf = null;
  function ensure() {
    if (!on) return null;
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC(); master = ctx.createGain(); master.gain.value = .32; master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * .6, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(type, f0, f1, dur, gain = .5, delay = 0) {
    const c = ensure(); if (!c) return;
    const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + .008); g.gain.exponentialRampToValueAtTime(.001, t + dur);
    o.connect(g).connect(master); o.start(t); o.stop(t + dur + .02);
  }
  function noise(dur, f, q = 1, gain = .5, delay = 0, sweep = null) {
    const c = ensure(); if (!c) return;
    const t = c.currentTime + delay, s = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
    s.buffer = noiseBuf; bp.type = 'bandpass'; bp.frequency.setValueAtTime(f, t); bp.Q.value = q;
    if (sweep) bp.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(.001, t + dur);
    s.connect(bp).connect(g).connect(master); s.start(t); s.stop(t + dur);
  }
  const sounds = {
    tap: () => tone('square', 880, 660, .06, .18),
    beep: () => tone('square', 660, 660, .14, .25),
    go: () => { tone('sawtooth', 440, 1320, .32, .3); tone('square', 880, 1760, .22, .18, .05); },
    rev: () => { tone('sawtooth', 70, 210, .42, .42); tone('sawtooth', 105, 260, .38, .2, .02); noise(.35, 600, .8, .35, 0, 2400); },
    burnout: () => noise(.5, 1800, .6, .22, 0, 900),
    whoosh: () => noise(.32, 400, .7, .45, 0, 3200),
    impact: () => { tone('triangle', 160, 40, .28, .55); noise(.18, 2600, .5, .4); },
    flip: () => { noise(.22, 1200, 1.5, .25, 0, 300); tone('sine', 300, 180, .12, .1, .12); },
    stamp: () => { tone('square', 220, 90, .12, .35); noise(.08, 3000, .7, .3); },
    screech: () => { tone('sawtooth', 2400, 1700, .4, .12); noise(.4, 3200, 4, .2); },
    shutter: () => { noise(.05, 4000, .6, .5); noise(.05, 2000, .6, .4, .07); },
  };
  return {
    play(name) { if (!on) return; try { sounds[name]?.(); } catch { /* 音效失败不影响画面 */ } },
    unlock() { ensure(); },
    setEnabled(v) { on = !!v; if (!on && ctx) ctx.suspend().catch(() => {}); },
    visibility(hidden) { if (!ctx) return; if (hidden) ctx.suspend().catch(() => {}); else if (on) ctx.resume().catch(() => {}); },
    get enabled() { return on; }, get state() { return ctx?.state || 'none'; },
  };
}
