/* Copied unchanged from prototypes/motuo-v2/game-events.js (2026-10-20) so v3 keeps the same data semantics and serves from its own root. */
/* Motuo game layer logic: events, combo, game score, rhythm judgement, flash budget.
 * Everything here is a GAME score derived from readings the page already shows.
 * It never produces or alters a measurement, and nothing here is a driving assessment.
 */
(function (global) {
  'use strict';
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));

  // Effect intensity is independent of the performance tier and of reduced motion.
  const INTENSITY = Object.freeze({
    restrained: Object.freeze({key: 'restrained', label: '克制', world: false, cinematic: false, shake: 0, flash: 0, particles: .35, callout: .55, speedScale: 1, ca: 0, bloom: .35}),
    standard: Object.freeze({key: 'standard', label: '标准', world: true, cinematic: true, shake: 7, flash: .3, particles: .6, callout: .8, speedScale: 1.18, ca: .5, bloom: .7}),
    extreme: Object.freeze({key: 'extreme', label: '夸张', world: true, cinematic: true, shake: 15, flash: .5, particles: 1, callout: 1, speedScale: 1.36, ca: 1, bloom: 1}),
  });
  const INTENSITY_ORDER = ['restrained', 'standard', 'extreme'];
  const DEFAULT_INTENSITY = 'extreme';
  const normalizeIntensity = v => INTENSITY[v] ? v : DEFAULT_INTENSITY;

  // WCAG 2.3.1: no more than three flashes in any one-second period. We keep a margin.
  function createFlashLimiter({maxPerSecond = 2, windowMs = 1000} = {}) {
    let stamps = [];
    return {
      allow(now) {
        stamps = stamps.filter(t => now - t < windowMs);
        if (stamps.length >= maxPerSecond) return false;
        stamps.push(now); return true;
      },
      countIn(now) { return stamps.filter(t => now - t < windowMs).length; },
      reset() { stamps = []; },
    };
  }

  // Speed colour temperature from a real reading: cold cyan → white → amber → red.
  function heat(speedKmh, top = 120) {
    if (!Number.isFinite(speedKmh)) return null;
    const h = clamp(speedKmh / top);
    const stops = [[0, [110, 230, 255]], [.33, [235, 248, 255]], [.66, [255, 196, 92]], [1, [255, 72, 64]]];
    let i = 1; while (i < stops.length - 1 && h > stops[i][0]) i++;
    const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (h - a) / (b - a);
    const rgb = ca.map((c, k) => Math.round(c + (cb[k] - c) * f));
    return {level: h, rgb, css: `rgb(${rgb.join(',')})`};
  }

  const MILESTONES = Object.freeze([30, 40, 60, 100]);
  const EVENT_COPY = Object.freeze({
    launch: {word: 'LAUNCH!', sub: '起步 · 演示', bonus: 100, tone: 'cyan'},
    boost: {word: 'BOOST', sub: '强加速 · 演示', bonus: 150, tone: 'magenta'},
    brake: {word: 'BRAKE', sub: '急减速 · 演示', bonus: 80, tone: 'red'},
    corner: {word: 'CORNER', sub: '过弯 · 演示', bonus: 200, tone: 'violet'},
    milestone: {word: '', sub: '速度里程碑 · 演示', bonus: 300, tone: 'amber'},
  });

  /* Detector: fed every render tick (~100 ms) with already-validated readings.
   * speedKmh is null when unknown; estimated (≈) readings never trigger milestones. */
  function createGame({milestones = MILESTONES} = {}) {
    let s;
    function reset() {
      s = {score: 0, combo: 0, maxCombo: 0, events: [], counts: {launch: 0, boost: 0, brake: 0, corner: 0, milestone: 0, perfect: 0, great: 0, good: 0},
        lastT: null, lastAccel: null, boostSince: null, brakeSince: null, smoothSince: null, invalidSince: null,
        cooldown: {}, lastSpeed: null, lastMotion: null, armed: new Set(milestones), launched: false, lastEnergy: 0, beatLatch: false, maxSpeed: 0};
    }
    reset();
    const ready = (key, t, gap) => !(s.cooldown[key] > t - gap) ;
    function emit(out, kind, t, extra = {}) {
      const copy = EVENT_COPY[kind];
      const bonus = Math.round(copy.bonus * (1 + s.combo * .1));
      s.score += bonus; s.counts[kind]++; s.cooldown[kind] = t;
      const event = {kind, t, word: extra.word || copy.word, sub: copy.sub, tone: copy.tone, bonus, combo: s.combo, ...extra};
      s.events.push(event); out.push(event);
    }
    function update({t, active = true, paused = false, speedKmh = null, estimated = false, accel = null, motion = '', sound = null, beatT = 0} = {}) {
      const out = [];
      if (!active || paused || !Number.isFinite(t)) { s.lastT = Number.isFinite(t) ? t : s.lastT; return out; }
      const speedOk = Number.isFinite(speedKmh), accelOk = Number.isFinite(accel);
      if (speedOk && !estimated) s.maxSpeed = Math.max(s.maxSpeed, speedKmh);
      // LAUNCH: leaving standstill under positive acceleration, once per stop.
      if (speedOk && s.lastSpeed !== null && s.lastSpeed < 2 && speedKmh >= 2 && accelOk && accel > .2 && ready('launch', t, 4)) emit(out, 'launch', t);
      if (speedOk && speedKmh < 1) s.launched = false;
      // BOOST / BRAKE: sustained, with cooldowns so they stay special.
      if (accelOk && accel >= .7) { s.boostSince ??= t; if (t - s.boostSince >= 1 && ready('boost', t, 6) && ready('launch', t, 2)) emit(out, 'boost', t); } else s.boostSince = null;
      if (accelOk && accel <= -.6) { s.brakeSince ??= t; if (t - s.brakeSince >= .6 && ready('brake', t, 6)) emit(out, 'brake', t); } else s.brakeSince = null;
      // CORNER: the (simulated or native) motion state enters a turn.
      if (motion === 'turn' && s.lastMotion !== 'turn' && ready('corner', t, 5)) emit(out, 'corner', t);
      // Milestones: upward crossings of a real, non-estimated reading; re-armed 10 km/h below.
      if (speedOk && !estimated) {
        for (const m of milestones) {
          if (s.armed.has(m) && speedKmh >= m && (s.lastSpeed ?? 0) < m) { s.armed.delete(m); emit(out, 'milestone', t, {word: `${m} KM/H`, value: m}); }
          else if (!s.armed.has(m) && speedKmh < m - 10) s.armed.add(m);
        }
      }
      // COMBO: every 2 s of smooth, valid acceleration; a harsh change or a gap resets it.
      if (accelOk) {
        s.invalidSince = null;
        const jerk = s.lastAccel === null ? 0 : Math.abs(accel - s.lastAccel);
        if (Math.abs(accel) > 1.1 || jerk > .6) { s.combo = 0; s.smoothSince = t; }
        else {
          s.smoothSince ??= t;
          if (t - s.smoothSince >= 2) { s.combo++; s.maxCombo = Math.max(s.maxCombo, s.combo); s.score += 10 * s.combo; s.smoothSince = t; out.push({kind: 'combo', t, combo: s.combo, bonus: 10 * s.combo}); }
        }
      } else {
        s.invalidSince ??= t;
        if (t - s.invalidSince > 1) { s.combo = 0; s.smoothSince = null; }
      }
      // Rhythm: a sound hit (energy rising edge) judged against a 120 BPM visual grid.
      if (sound && sound.valid) {
        const e = clamp(sound.energy);
        if (!s.beatLatch && e >= .55 && s.lastEnergy < .55) {
          s.beatLatch = true;
          const offset = Math.abs(beatT - Math.round(beatT / .5) * .5);
          const grade = offset <= .06 ? 'perfect' : offset <= .14 ? 'great' : 'good';
          const bonus = {perfect: 50, great: 25, good: 5}[grade];
          s.counts[grade]++; s.score += bonus;
          out.push({kind: 'rhythm', t, grade, offset, bonus});
        }
        if (e < .4) s.beatLatch = false;
        s.lastEnergy = e;
      } else { s.lastEnergy = 0; s.beatLatch = false; }
      s.lastAccel = accelOk ? accel : null;
      s.lastSpeed = speedOk ? speedKmh : s.lastSpeed;
      s.lastMotion = motion; s.lastT = t;
      return out;
    }
    function summary() {
      const rating = s.score >= 3000 ? 'S' : s.score >= 1500 ? 'A' : s.score >= 600 ? 'B' : 'C';
      return {score: s.score, combo: s.combo, maxCombo: s.maxCombo, rating, counts: {...s.counts}, events: s.events.length, maxSpeed: s.maxSpeed, label: '游戏分 · 演示，非驾驶评价'};
    }
    return {update, reset, summary, get score() { return s.score; }, get combo() { return s.combo; }};
  }

  global.MotuoGame = Object.freeze({INTENSITY, INTENSITY_ORDER, DEFAULT_INTENSITY, normalizeIntensity, createFlashLimiter, heat, createGame, MILESTONES, EVENT_COPY, clamp});
})(typeof window !== 'undefined' ? window : globalThis);
