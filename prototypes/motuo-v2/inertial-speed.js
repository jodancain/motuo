/*
 * Short GPS-outage velocity bridge for the HTML prototype, not an IMU driver.
 * time: monotonic seconds; GPS speed/accuracy: m/s; forward acceleration: m/s².
 * The caller MUST remove gravity, calibrate the phone mount and project IMU
 * acceleration onto the vehicle's forward axis before setting calibrated=true.
 * No positions or routes are synthesized. Uncertainty is a conservative model
 * budget, not a measured confidence interval or a claim of road-test accuracy.
 */
(function (global) {
  'use strict';

  const DEFAULTS = Object.freeze({
    maxEstimateSeconds: 15,
    maxImuGapSeconds: 0.5,
    maxUncertaintyKmh: 25,
    accelerationBiasMps2: 0.4,
    accelerationNoiseMps2: 0.25,
    maxAccelerationMps2: 30,
    maxSpeedMps: 100
  });

  function create(options = {}) {
    const config = { ...DEFAULTS };
    for (const key of Object.keys(config)) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        if (!Number.isFinite(options[key]) || options[key] <= 0) {
          throw new RangeError(`${key} must be a finite positive number`);
        }
        config[key] = options[key];
      }
    }

    let anchorTime, lastTime, speedMps, previousAcceleration;
    let initialVariance, integrationVariance, terminalReason, lastResult;

    function unavailable(reason, ageSeconds = 0) {
      return {
        speedKmh: null, source: 'unavailable', uncertaintyKmh: null,
        ageSeconds, confidence: 'unavailable', reason
      };
    }

    function reset() {
      anchorTime = null;
      lastTime = null;
      speedMps = null;
      previousAcceleration = null;
      initialVariance = 0;
      integrationVariance = 0;
      terminalReason = null;
      lastResult = unavailable('no_gps_anchor');
    }

    function reject(reason, ageSeconds) {
      terminalReason = reason;
      speedMps = null;
      previousAcceleration = null;
      lastResult = unavailable(reason, ageSeconds);
      return { ...lastResult };
    }

    function validIMU(imu) {
      return imu?.valid === true && imu.calibrated === true &&
        Number.isFinite(imu.accelForwardMps2) &&
        Math.abs(imu.accelForwardMps2) <= config.maxAccelerationMps2;
    }

    function validGPS(gps) {
      return gps?.valid === true && Number.isFinite(gps.speedMps) &&
        gps.speedMps >= 0 && gps.speedMps <= config.maxSpeedMps &&
        Number.isFinite(gps.accuracyMps) && gps.accuracyMps >= 0;
    }

    function update(input = {}) {
      const { time, gps, imu, active, stationaryConfirmed } = input;
      if (active !== true) {
        reset();
        lastResult = unavailable('inactive');
        return { ...lastResult };
      }
      if (!Number.isFinite(time) || time < 0) {
        reset();
        lastResult = unavailable('invalid_time');
        return { ...lastResult };
      }
      if (lastTime !== null && time < lastTime) {
        reset();
        lastResult = unavailable('time_discontinuity');
        return { ...lastResult };
      }

      // A new valid GPS sample always wins, including recovery at the same time
      // as the most recent IMU update. Do not smooth or rewrite measured speed.
      if (validGPS(gps)) {
        anchorTime = time;
        lastTime = time;
        speedMps = gps.speedMps;
        previousAcceleration = validIMU(imu) ? imu.accelForwardMps2 : null;
        initialVariance = gps.accuracyMps ** 2;
        integrationVariance = 0;
        terminalReason = null;
        lastResult = {
          speedKmh: gps.speedMps * 3.6, source: 'gps',
          uncertaintyKmh: gps.accuracyMps * 3.6, ageSeconds: 0,
          confidence: gps.accuracyMps <= 1 ? 'high' : 'medium', reason: 'gps_valid'
        };
        return { ...lastResult };
      }

      // Rendering can read a sample more than once; integrate it only once.
      if (time === lastTime) return { ...lastResult };
      const dt = lastTime === null ? null : time - lastTime;
      const age = anchorTime === null ? 0 : time - anchorTime;
      lastTime = time;
      if (anchorTime === null) return reject('no_gps_anchor', 0);
      if (terminalReason) return reject(terminalReason, age);
      if (age > config.maxEstimateSeconds) return reject('estimate_expired', age);
      if (dt === null || dt > config.maxImuGapSeconds) return reject('imu_gap', age);
      if (imu?.calibrated !== true) return reject('imu_uncalibrated', age);
      if (!validIMU(imu)) return reject('imu_invalid', age);
      if (previousAcceleration === null) return reject('imu_baseline_missing', age);

      const acceleration = (previousAcceleration + imu.accelForwardMps2) / 2;
      const proposedSpeed = speedMps + acceleration * dt;
      if (!Number.isFinite(proposedSpeed) || proposedSpeed > config.maxSpeedMps) {
        return reject('speed_out_of_range', age);
      }
      speedMps = Math.max(0, proposedSpeed);
      previousAcceleration = imu.accelForwardMps2;
      integrationVariance += (config.accelerationNoiseMps2 * dt) ** 2;
      let uncertaintyMps = Math.sqrt(initialVariance + integrationVariance +
        (config.accelerationBiasMps2 * age) ** 2);

      // This flag must be an independent, explicit stationary confirmation.
      // Low vibration/zero accelerometer output alone cannot establish a stop.
      if (stationaryConfirmed === true) {
        speedMps = 0;
        // Preserve the conservative uncertainty and original GPS expiration;
        // an external stop correction does not validate an IMU calibration.
      }
      if (!Number.isFinite(uncertaintyMps) || uncertaintyMps * 3.6 > config.maxUncertaintyKmh) {
        return reject('uncertainty_exceeded', age);
      }
      lastResult = {
        speedKmh: speedMps * 3.6, source: 'inertial',
        uncertaintyKmh: uncertaintyMps * 3.6, ageSeconds: age,
        confidence: age <= 5 && uncertaintyMps * 3.6 <= 6 ? 'medium' : 'low',
        reason: stationaryConfirmed === true ? 'stationary_confirmed' : 'gps_lost_integrating'
      };
      return { ...lastResult };
    }

    reset();
    return Object.freeze({ update, reset });
  }

  global.MotuoInertialSpeed = Object.freeze({ create });
})(window);
