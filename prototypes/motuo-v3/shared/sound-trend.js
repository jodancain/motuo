/* Copied unchanged from prototypes/motuo-v2/sound-trend.js (2026-10-20) so v3 keeps the same data semantics and serves from its own root. */
/* Relative sound strength only. This does not identify an engine or estimate its speed. */
(function (global) {
  'use strict';

  const LEVEL_TAU_SECONDS = 0.4;
  const QUIET_THRESHOLD = 0.035;
  const TREND_RATE_THRESHOLD = 0.08;
  const TREND_HOLD_SECONDS = 0.2;
  const MAX_GAP_SECONDS = 2;
  const clamp = value => Math.max(0, Math.min(1, value));

  function soundLevel(energy, spectrum) {
    // Frequency-bin magnitudes affect relative strength, not a supposed pitch-to-speed ratio.
    const bins = spectrum && typeof spectrum[Symbol.iterator] === 'function'
      ? Array.from(spectrum).filter(Number.isFinite).map(clamp) : [];
    const average = bins.length ? bins.reduce((sum, value) => sum + value, 0) / bins.length : clamp(energy);
    const strength = 0.85 * clamp(energy) + 0.15 * average;
    return strength < QUIET_THRESHOLD ? 0 : strength;
  }

  function create() {
    let previousTime = null;
    let level = 0;
    let trend = 'waiting';
    let sourceQuality = 'unavailable';
    let candidate = 'steady';
    let candidateSeconds = 0;
    let candidateSamples = 0;

    function reset() {
      previousTime = null;
      level = 0;
      trend = 'waiting';
      sourceQuality = 'unavailable';
      candidate = 'steady';
      candidateSeconds = 0;
      candidateSamples = 0;
    }

    function result() {
      return { level, trend, sourceQuality };
    }

    function baseline(time, target) {
      previousTime = time;
      level = target;
      trend = target === 0 ? 'quiet' : 'steady';
      sourceQuality = 'unvalidated';
      candidate = 'steady';
      candidateSeconds = 0;
      candidateSamples = 0;
      return result();
    }

    function sample(input = {}) {
      if (input.valid !== true || input.paused === true || !Number.isFinite(input.time) ||
          input.time < 0 || !Number.isFinite(input.energy)) {
        reset();
        return result();
      }
      const target = soundLevel(input.energy, input.spectrum);
      if (previousTime === null) return baseline(input.time, target);
      const dt = input.time - previousTime;
      if (dt < 0 || dt > MAX_GAP_SECONDS) return baseline(input.time, target);
      if (dt === 0) return result();

      const oldLevel = level;
      level = clamp(level + (target - level) * (1 - Math.exp(-dt / LEVEL_TAU_SECONDS)));
      previousTime = input.time;
      if (target === 0 && level < QUIET_THRESHOLD) {
        level = 0;
        trend = 'quiet';
        candidate = 'steady';
        candidateSeconds = 0;
        candidateSamples = 0;
        return result();
      }

      const rate = (level - oldLevel) / dt;
      const next = rate > TREND_RATE_THRESHOLD ? 'rising' : rate < -TREND_RATE_THRESHOLD ? 'falling' : 'steady';
      if (next !== candidate) {
        candidate = next;
        candidateSeconds = dt;
        candidateSamples = 1;
      } else {
        candidateSeconds += dt;
        candidateSamples += 1;
      }
      // A lone noisy frame may move the meter slightly, but cannot announce a direction.
      if (candidateSamples >= 2 && candidateSeconds >= TREND_HOLD_SECONDS) trend = candidate;
      else if (trend === 'quiet') trend = 'steady';
      return result();
    }

    return { sample, reset };
  }

  global.MotuoSoundTrend = Object.freeze({ create });
})(window);
