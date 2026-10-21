/* Copied unchanged from prototypes/motuo-v2/drive-signals.js (2026-10-20) so v3 keeps the same data semantics and serves from its own root. */
/* Longitudinal acceleration derived only from consecutive, same-source speed samples. */
(function (global) {
  'use strict';

  const MAX_GAP_SECONDS = 2;
  const KMH_TO_MS = 1 / 3.6;
  const STANDARD_GRAVITY = 9.80665;

  function create() {
    let previous = null;
    let acceleration = null;
    let status = 'idle';

    function reset() {
      previous = null;
      acceleration = null;
      status = 'idle';
    }

    function result() {
      return {
        accelMs2: acceleration,
        accelG: acceleration === null ? null : acceleration / STANDARD_GRAVITY,
        status
      };
    }

    function begin(current, nextStatus) {
      previous = current;
      acceleration = null;
      status = nextStatus;
    }

    function sample(input = {}) {
      if (input.phase !== 'riding') {
        reset();
        status = input.phase === 'paused' ? 'paused' : 'idle';
        return result();
      }

      const source = input.source === undefined ? 'gps' : input.source;
      const valid = Number.isFinite(input.seconds) && input.seconds >= 0 &&
        Number.isFinite(input.speedKmh) && input.speedKmh >= 0 &&
        Number.isFinite(input.scenarioStarted) &&
        (source === 'gps' || source === 'inertial') &&
        (source === 'inertial' || (input.scenario !== 'gps' && input.motion !== 'gps'));
      if (!valid) {
        begin(null, 'gap');
        return result();
      }

      const current = {
        seconds: input.seconds,
        speedKmh: input.speedKmh,
        scenario: input.scenario,
        scenarioStarted: input.scenarioStarted,
        source
      };
      if (!previous || current.scenario !== previous.scenario ||
          current.scenarioStarted !== previous.scenarioStarted || current.source !== previous.source) {
        begin(current, 'warming');
        return result();
      }

      const dt = current.seconds - previous.seconds;
      if (dt < 0 || dt > MAX_GAP_SECONDS) {
        begin(current, 'gap');
        return result();
      }
      // Render and animation loops may read the same sample. Do not consume it twice.
      if (dt === 0) return result();

      const measuredChange = (current.speedKmh - previous.speedKmh) * KMH_TO_MS / dt;
      if (!Number.isFinite(measuredChange)) {
        begin(current, 'gap');
        return result();
      }
      previous = current;
      acceleration = measuredChange === 0 ? 0 : measuredChange;
      status = 'valid';
      return result();
    }

    return { sample, reset };
  }

  global.MotuoDriveSignals = Object.freeze({ create });
})(window);
