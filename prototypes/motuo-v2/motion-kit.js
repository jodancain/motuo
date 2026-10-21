/* Motuo motion kit: one rhythm for every decorative transition.
 * Self-written spring / interpolate / easing / stagger / clock / timeline.
 * Motion language borrowed from video tooling (see docs/research/remotion-motion-20261020.md);
 * no third-party code. Nothing here reads or changes telemetry.
 */
(function (global) {
  'use strict';
  const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));

  // Damped harmonic oscillator, analytic solution from 0 to 1 (t in seconds).
  function springValue(t, config = {}) {
    const {stiffness = 100, damping = 10, mass = 1, velocity = 0, overshootClamping = false} = config;
    if (!(t > 0)) return 0;
    const w0 = Math.sqrt(stiffness / mass), zeta = damping / (2 * Math.sqrt(stiffness * mass));
    let y;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      y = Math.exp(-zeta * w0 * t) * (-Math.cos(wd * t) + ((velocity - zeta * w0) / wd) * Math.sin(wd * t));
    } else if (zeta === 1) {
      y = (-1 + (velocity - w0) * t) * Math.exp(-w0 * t);
    } else {
      const s = Math.sqrt(zeta * zeta - 1), r1 = -w0 * (zeta - s), r2 = -w0 * (zeta + s);
      const c2 = (velocity + r1) / (r2 - r1), c1 = -1 - c2;
      y = c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
    }
    const x = 1 + y;
    return overshootClamping ? Math.min(x, 1) : x;
  }

  // Time after which the spring stays within threshold of rest (seconds).
  const settleCache = new Map();
  function springSettle(config = {}, threshold = .004) {
    const key = JSON.stringify([config.stiffness, config.damping, config.mass, config.velocity, threshold]);
    if (settleCache.has(key)) return settleCache.get(key);
    let last = 0;
    for (let t = 0; t <= 12; t += 1 / 240) if (Math.abs(springValue(t, config) - 1) > threshold) last = t;
    const settle = Math.max(1 / 60, last + 1 / 240);
    settleCache.set(key, settle);
    return settle;
  }

  // Cubic Bezier easing matching CSS cubic-bezier().
  function bezier(x1, y1, x2, y2) {
    const ax = 3 * x1 - 3 * x2 + 1, bx = 3 * x2 - 6 * x1, cx = 3 * x1;
    const ay = 3 * y1 - 3 * y2 + 1, by = 3 * y2 - 6 * y1, cy = 3 * y1;
    const sx = t => ((ax * t + bx) * t + cx) * t, sy = t => ((ay * t + by) * t + cy) * t;
    const dx = t => (3 * ax * t + 2 * bx) * t + cx;
    const fn = x => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const err = sx(t) - x, d = dx(t);
        if (Math.abs(err) < 1e-7) return sy(t);
        if (Math.abs(d) < 1e-6) break;
        t -= err / d;
      }
      let lo = 0, hi = 1; t = x;
      for (let i = 0; i < 30; i++) { const v = sx(t); if (Math.abs(v - x) < 1e-7) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
      return sy(t);
    };
    fn.css = `cubic-bezier(${x1},${y1},${x2},${y2})`;
    return fn;
  }
  const linear = x => clamp(x);
  linear.css = 'linear';
  const easing = Object.freeze({
    linear,
    out: bezier(.16, 1, .3, 1),       // arrivals: fast in, long settle
    inOut: bezier(.65, 0, .35, 1),    // camera moves and wipes
    in: bezier(.7, 0, .84, 0),        // exits only
    sweep: bezier(.45, 0, .2, 1),     // light passes
    bezier,
  });

  // Piecewise mapping with explicit extrapolation (default clamp, unlike video tools).
  function interpolate(input, inputRange, outputRange, options = {}) {
    const {easing: ease = linear, extrapolateLeft = 'clamp', extrapolateRight = 'clamp'} = options;
    if (!Array.isArray(inputRange) || inputRange.length < 2 || inputRange.length !== outputRange.length) throw new RangeError('interpolate needs matching ranges of at least two values');
    for (let i = 1; i < inputRange.length; i++) if (!(inputRange[i] > inputRange[i - 1])) throw new RangeError('inputRange must be strictly increasing');
    const v = Number.isFinite(input) ? input : inputRange[0];
    const last = inputRange.length - 1;
    if (v <= inputRange[0] && extrapolateLeft === 'clamp') return outputRange[0];
    if (v >= inputRange[last] && extrapolateRight === 'clamp') return outputRange[last];
    let i = 1;
    while (i < last && v > inputRange[i]) i++;
    const a = inputRange[i - 1], b = inputRange[i];
    const raw = (v - a) / (b - a);
    const eased = raw >= 0 && raw <= 1 ? (Array.isArray(ease) ? ease[i - 1] : ease)(raw) : raw;
    return outputRange[i - 1] + (outputRange[i] - outputRange[i - 1]) * eased;
  }

  // Presets: one vocabulary for the whole HUD. Durations in ms.
  const springs = Object.freeze({
    // Near-critical, no bounce. A damping-200 video spring is only usable when
    // stretched to a fixed length; callers here pass maxMs/minMs for that instead.
    smooth: Object.freeze({stiffness: 140, damping: 24, mass: 1}),    // camera, veils
    glide: Object.freeze({stiffness: 120, damping: 22, mass: 1.1}),   // shared-element flight
    snappy: Object.freeze({stiffness: 260, damping: 26, mass: 1}),    // HUD arrivals
    pop: Object.freeze({stiffness: 320, damping: 18, mass: .9}),      // beat/impact accents, small overshoot
    roll: Object.freeze({stiffness: 520, damping: 40, mass: .8}),     // digit roller; settles < 300 ms
    heavy: Object.freeze({stiffness: 80, damping: 15, mass: 2}),      // freeze / unfreeze weight
  });
  const durations = Object.freeze({micro: 140, short: 260, medium: 480, long: 900, departure: 1550, departureMax: 1600});
  const staggers = Object.freeze({micro: 28, standard: 55, dramatic: 90, maxTotal: 480});

  // Delay for item `index`; the whole cascade never exceeds `maxTotal`.
  function stagger(index, count, {step = staggers.standard, maxTotal = staggers.maxTotal, from = 'start'} = {}) {
    const n = Math.max(1, count | 0), i = clamp(index | 0, 0, n - 1);
    const order = from === 'center' ? Math.abs(i - (n - 1) / 2) : from === 'end' ? n - 1 - i : i;
    const span = from === 'center' ? (n - 1) / 2 : n - 1;
    const effective = span > 0 ? Math.min(step, maxTotal / span) : 0;
    return Math.round(order * effective);
  }

  // Spring normalized to its settle time, usable as a 0..1 easing.
  function springEasing(config) {
    const settle = springSettle(config);
    const fn = x => x >= 1 ? 1 : springValue(clamp(x) * settle, config);
    fn.settleMs = settle * 1000;
    return fn;
  }

  // CSS linear() sampling so compositor animations follow the same spring.
  function cssLinear(fn, samples = 40) {
    const parts = [];
    for (let i = 0; i <= samples; i++) {
      const x = i / samples;
      parts.push(`${Math.round(fn(x) * 10000) / 10000} ${Math.round(x * 10000) / 100}%`);
    }
    return `linear(${parts.join(', ')})`;
  }
  let linearSupport = null;
  function supportsLinear() {
    if (linearSupport === null) {
      try { linearSupport = !!global.CSS?.supports?.('animation-timing-function', 'linear(0, 1)'); } catch { linearSupport = false; }
    }
    return linearSupport;
  }
  // Fallback curves keep roughly the same feel where linear() is unavailable.
  const springFallback = {smooth: easing.out.css, glide: 'cubic-bezier(.22,.9,.24,1)', snappy: 'cubic-bezier(.2,1.1,.3,1)', pop: 'cubic-bezier(.3,1.5,.5,1)', roll: 'cubic-bezier(.2,1,.3,1)', heavy: 'cubic-bezier(.3,1.2,.4,1)'};
  const easingCache = new Map();
  // WAAPI timing for a named spring: duration follows physics unless clamped.
  function springTiming(name, {maxMs = Infinity, minMs = 0} = {}) {
    const config = springs[name] || springs.smooth;
    const fn = springEasing(config);
    const duration = Math.round(clamp(fn.settleMs, minMs, maxMs));
    if (!supportsLinear()) return {duration, easing: springFallback[name] || easing.out.css, fn};
    if (!easingCache.has(name)) easingCache.set(name, cssLinear(fn));
    return {duration, easing: easingCache.get(name), fn};
  }

  // Reduced motion: only required state changes survive.
  function prefersReduced(matchMedia = global.matchMedia) {
    try { return !!matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  /* One rAF for every JS-driven animation on the page.
   * Tasks run each frame; `throttle` tasks are capped to the tier frame rate.
   * The loop stops while hidden or idle and records frame intervals for the tier. */
  function createClock({raf = global.requestAnimationFrame?.bind(global), caf = global.cancelAnimationFrame?.bind(global), now = () => global.performance.now(), hidden = () => !!global.document?.hidden, onTier = null} = {}) {
    const tasks = new Set(), once = new Map(), listeners = new Set(onTier ? [onTier] : []);
    let handle = 0, running = false, last = 0, nextOnce = 1;
    let mode = 'auto', hint = false, tier = 'normal', ema = 1000 / 60, slowFor = 0, fastFor = 0;
    const interval = () => tier === 'eco' ? 1000 / 30 : 1000 / 60;
    function setTier(value, reason) { if (value === tier) return; tier = value; for (const fn of [...listeners]) fn(tier, reason); }
    function evaluate(delta) {
      if (mode !== 'auto') { setTier(mode, 'manual'); return; }
      if (hint) { setTier('eco', 'hint'); return; }
      // Ignore stalls from tab switches or debugger pauses.
      if (delta > 250) return;
      ema += (delta - ema) * .08;
      if (ema > 24) { slowFor += delta; fastFor = 0; } else if (ema < 18.5) { fastFor += delta; slowFor = 0; } else { slowFor = fastFor = 0; }
      if (tier === 'normal' && slowFor > 2000) { setTier('eco', 'slow-frames'); slowFor = 0; }
      if (tier === 'eco' && fastFor > 6000) { setTier('normal', 'recovered'); fastFor = 0; }
    }
    function tick() {
      handle = 0;
      if (!running) return;
      if (hidden()) { running = false; last = 0; return; }
      const t = now(), delta = last ? t - last : 1000 / 60;
      last = t;
      evaluate(delta);
      const due = [...once.values()]; once.clear();
      for (const fn of due) { try { fn(t); } catch (error) { reportError(error); } }
      for (const task of [...tasks]) {
        if (!tasks.has(task)) continue;
        if (task.throttle && task.lastRun && t - task.lastRun < interval() - 2) continue;
        const dt = task.lastRun ? Math.min(.2, (t - task.lastRun) / 1000) : 0;
        task.lastRun = t;
        try { if (task.fn(t, dt) === false) tasks.delete(task); } catch (error) { tasks.delete(task); reportError(error); }
      }
      if (tasks.size || once.size) handle = raf(tick); else { running = false; last = 0; }
    }
    function reportError(error) { setTimeout(() => { throw error; }, 0); }
    function start() {
      if (running || hidden() || !raf) return;
      if (!tasks.size && !once.size) return;
      running = true; handle = raf(tick);
    }
    function stop() { if (handle && caf) caf(handle); handle = 0; running = false; last = 0; }
    function add(fn, {throttle = false} = {}) {
      const task = {fn, throttle, lastRun: 0};
      tasks.add(task); start();
      return () => tasks.delete(task);
    }
    // rAF-compatible one-shot frames for on-demand renderers (3D viewer).
    function requestFrame(fn) { const id = nextOnce++; once.set(id, fn); start(); return id; }
    function cancelFrame(id) { once.delete(id); }
    function visibilityChanged() { if (hidden()) stop(); else { last = 0; start(); } }
    return Object.freeze({
      add, start, stop, requestFrame, cancelFrame, visibilityChanged,
      onTierChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      setMode(value) { mode = ['auto', 'normal', 'eco'].includes(value) ? value : 'auto'; slowFor = fastFor = 0; if (mode !== 'auto') setTier(mode, 'manual'); else setTier(hint ? 'eco' : 'normal', 'auto'); },
      setHint(value) { hint = !!value; if (mode === 'auto') setTier(hint ? 'eco' : 'normal', hint ? 'hint' : 'auto'); },
      get tier() { return tier; }, get mode() { return mode; }, get running() { return running; },
      get frameInterval() { return interval(); }, get averageInterval() { return ema; }, get taskCount() { return tasks.size; },
    });
  }

  // The page and the 3D viewer share one clock, hence one rAF.
  let shared = null;
  function sharedClock() { return shared || (shared = createClock()); }

  /* Small timeline: tracks at absolute ms positions, driven by the clock.
   * Cancelling runs every started track's cleanup so no temporary layer outlives it. */
  function createTimeline(clock, {reduced = false} = {}) {
    const tracks = [];
    let remove = null, started = 0, done = false, resolve;
    const finished = new Promise(r => { resolve = r; });
    function add(track) { tracks.push({at: 0, duration: 0, ...track, state: 'pending'}); return api; }
    function end() { return tracks.reduce((m, t) => Math.max(m, t.at + t.duration), 0); }
    function step(now) {
      const t = now - started;
      for (const track of tracks) {
        if (track.state === 'done') continue;
        if (t < track.at) continue;
        if (track.state === 'pending') { track.state = 'active'; track.start?.(); }
        const p = track.duration > 0 ? clamp((t - track.at) / track.duration) : 1;
        track.update?.(p);
        if (p >= 1) { track.state = 'done'; track.end?.(); }
      }
      if (tracks.every(track => track.state === 'done')) { finish(); return false; }
      return true;
    }
    function finish() { if (done) return; done = true; remove?.(); remove = null; resolve('finished'); }
    function play() {
      if (reduced || !clock) {
        for (const track of tracks) { if (track.state === 'pending') track.start?.(); track.update?.(1); track.state = 'done'; track.end?.(); }
        finish(); return api;
      }
      started = -1;
      remove = clock.add(now => { if (started < 0) started = now; return step(now); });
      return api;
    }
    function cancel() {
      if (done) return;
      for (const track of tracks) if (track.state !== 'pending') track.cancel?.();
      done = true; remove?.(); remove = null; resolve('cancelled');
    }
    const api = {add, play, cancel, finished, get duration() { return end(); }, get done() { return done; }};
    return api;
  }

  global.MotuoMotion = Object.freeze({
    clamp, springValue, springSettle, springEasing, springTiming, cssLinear, supportsLinear,
    bezier, easing, interpolate, stagger, springs, durations, staggers,
    prefersReduced, createClock, createTimeline, sharedClock,
  });
})(typeof window !== 'undefined' ? window : globalThis);
