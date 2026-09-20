/* Local prototype signals. RPM is an explicit animation fixture, never an inference. */
(function (global) {
  'use strict';

  const MAX_GAP_SECONDS = 2;
  const KMH_TO_MS = 1 / 3.6;
  const STANDARD_GRAVITY = 9.80665;

  // Deliberately independent of speed, microphone input, transmission and engine model.
  // Revs rise and settle during the 56-second demonstration journey; no gear is emitted.
  const RPM_JOURNEY = [
    [0, 1400], [3, 1550], [8, 6600], [8.7, 3700],
    [13.4, 8200], [14.2, 4600], [17, 5300], [32, 4700],
    [40, 3400], [49, 1500], [56, 1400]
  ];

  function interpolate(points, seconds) {
    for (let index = 1; index < points.length; index += 1) {
      const [endTime, endValue] = points[index];
      if (seconds <= endTime) {
        const [startTime, startValue] = points[index - 1];
        const progress = (seconds - startTime) / (endTime - startTime);
        return startValue + (endValue - startValue) * progress;
      }
    }
    return points[points.length - 1][1];
  }

  function demoRPM(input) {
    if (input.rpmDemo !== true || input.phase !== 'riding' ||
        !Number.isFinite(input.seconds) || !Number.isFinite(input.scenarioStarted)) return null;

    const elapsed = Math.max(0, input.seconds - input.scenarioStarted);
    let rpm;
    switch (input.scenario) {
      case 'launch':
        rpm = interpolate([[0, 1400], [5, 6600], [5.7, 3800], [10, 7200], [11, 4500], [14, 5100]], elapsed % 14);
        break;
      case 'load':
        rpm = 7500 + Math.sin(elapsed * 1.8) * 180;
        break;
      case 'cruise':
        rpm = 4500 + Math.sin(elapsed * 1.4) * 110;
        break;
      case 'turn':
        rpm = 3400 + Math.sin(elapsed * 1.1) * 180;
        break;
      case 'brake':
        rpm = interpolate([[0, 4800], [4, 3300], [10, 1500], [12, 1400]], elapsed);
        break;
      default:
        rpm = interpolate(RPM_JOURNEY, elapsed % 56);
    }
    return Math.round(Math.max(1400, Math.min(8200, rpm)));
  }

  function create() {
    let previous = null;
    let acceleration = null;
    let status = 'idle';

    function reset() {
      previous = null;
      acceleration = null;
      status = 'idle';
    }

    function result(rpm) {
      return {
        rpm,
        rpmSource: rpm === null ? 'unknown' : 'demo',
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
      const rpm = demoRPM(input);
      if (input.phase !== 'riding') {
        reset();
        status = input.phase === 'paused' ? 'paused' : 'idle';
        return result(rpm);
      }

      const valid = Number.isFinite(input.seconds) && input.seconds >= 0 &&
        Number.isFinite(input.speedKmh) && input.speedKmh >= 0 &&
        Number.isFinite(input.scenarioStarted) &&
        input.scenario !== 'gps' && input.motion !== 'gps';
      if (!valid) {
        begin(null, 'gap');
        return result(rpm);
      }

      const current = {
        seconds: input.seconds,
        speedKmh: input.speedKmh,
        scenario: input.scenario,
        scenarioStarted: input.scenarioStarted
      };
      if (!previous || current.scenario !== previous.scenario ||
          current.scenarioStarted !== previous.scenarioStarted) {
        begin(current, 'warming');
        return result(rpm);
      }

      const dt = current.seconds - previous.seconds;
      if (dt < 0 || dt > MAX_GAP_SECONDS) {
        begin(current, 'gap');
        return result(rpm);
      }
      // Render and animation loops may read the same sample. Do not consume it twice.
      if (dt === 0) return result(rpm);

      const measuredChange = (current.speedKmh - previous.speedKmh) * KMH_TO_MS / dt;
      if (!Number.isFinite(measuredChange)) {
        begin(current, 'gap');
        return result(rpm);
      }
      previous = current;
      acceleration = measuredChange === 0 ? 0 : measuredChange;
      status = 'valid';
      return result(rpm);
    }

    return { sample, reset };
  }

  global.MotuoDriveSignals = Object.freeze({ create });
})(window);
