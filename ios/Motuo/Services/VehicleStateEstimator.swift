import Foundation
import simd

/// Vehicle state estimator (authoritative). prototypes/motuo-v3/core/vehicle-state.js mirrors this logic line by line
/// for the browser replay; both run the same synthetic replay in tests and must produce the same key state sequence.
///
/// Inputs (monotonic seconds): CoreMotion deviceMotion (device frame), GPS speed, optional IMU speed estimate,
/// optional microphone features. Output: a 10 Hz snapshot plus state-change / corner / suspected-shift events.
/// Every output is inferred (or simulated in demo rides), never measured. Lean only drives visuals — never shown as a number.
/// - Turns: yaw rate about the true vertical (−gravity), two cascaded low-passes (≈0.45 Hz) so 1.7 Hz mount wobble is ignored.
/// - Longitudinal: GPS speed slope (2.6 s regression) plus, once the mount axis converged, the IMU forward component as a
///   high-frequency complement. Never the acceleration magnitude.
/// - Engine: at standstill IMU high-frequency vibration decides off/idle (off ≈0.003 g, idle ≥0.02 g); the microphone only
///   fills in while the phone is being handled, and detects revving.
enum VS {
    static let g0 = 9.80665
    static let tickS = 0.1
    static let yawTauS = 0.35, upSlowTauS = 8.0
    static let gpsMaxAgeS = 2.5, gpsMaxSpeedAcc = 2.5, gpsSlopeSpanS = 2.6
    static let aGpsTauS = 0.5, aImuTauS = 0.25, aImuSlowTauS = 1.4, aImuNoGpsTauS = 5.0
    static let vibTauS = 0.4, vibSampleS = 0.035
    static let handlingRotRad = 0.25
    static let vibOnG = 0.016, vibOffG = 0.009, engineOnHoldS = 1.5, engineOffHoldS = 2.5
    static let micOnAboveFloorDb = 6.0, revRiseDb = 4.0, revFallDb = 1.5, revMaxS = 4.0, revSettleS = 4.0, revOnsetDb = 3.0
    static let stopEnterMps = 0.8, stopExitMps = 1.6
    static let launchMaxMps = 6.0, launchMaxS = 5.0
    static let accelOnG = 0.055, accelOffG = 0.03, brakeOnG = -0.065, brakeOffG = -0.035, hardOnG = -0.25, hardOffG = -0.17
    static let coastOnG = -0.025, imuComplementMaxG = 0.12
    /// A wanted state must persist this long before switching (minimum duration on top of the threshold hysteresis).
    static let holdS: [VehicleMotion: Double] = [.hardBraking: 0.25, .braking: 0.35, .accelerating: 0.4, .launching: 0, .coasting: 1.0, .cruising: 0.6, .stopped: 0.6]
    static let handlingSettleS = 2.0, movingNoGpsVibG = 0.15, movingNoGpsHoldS = 5.0, leaveMaxS = 1.2, aStateTauS = 0.3, imuOnlyThresholdScale = 1.5
    static let turnMinMps = 2.5, turnOnDegS = 8.0, turnOffDegS = 4.5, turnOnHoldS = 0.3, turnOffHoldS = 0.4
    static let cornerMinDeg = 20.0, cornerMinS = 0.8
    static let leanMaxDeg = 45.0, remountCos = cos(25 * Double.pi / 180)
    static let mountForget = 160.0, mountMinInformative = 10.0, mountMinR = 0.45, mountStraightDegS = 6.0, mountMinMps = 3.0
    static let shiftCooldownS = 2.5, shiftMinAccelS = 0.4, shiftCandFrac = 0.6, shiftDeepFrac = 0.45, shiftSoundDipDb = 2.0
}

enum VehicleEngine: String, Sendable { case unknown, off, idle, running, revving }
enum VehicleMotion: String, Sendable { case stopped, launching, accelerating, cruising, braking, hardBraking, coasting }
enum VehicleTurn: String, Sendable { case none, left, right }
enum CornerPhase: String, Sendable { case none, entry, apex, exit }
enum MountStatus: String, Sendable { case learning, calibrated, converged }

struct VehicleStateEvent: Sendable, Equatable {
    enum Kind: String, Sendable { case state, corner, suspectedShift, mountReset }
    var t: Double
    var kind: Kind
    var field: String? = nil, from: String? = nil, to: String? = nil
    var confidence: Double = 0
    var dir: String? = nil, start: Double? = nil, end: Double? = nil, angleDeg: Double? = nil, peakDegS: Double? = nil
    var dipG: Double? = nil, soundDipDb: Double? = nil
    var source: String
}

struct MountState: Sendable, Equatable {
    var status: MountStatus, confidence: Double, forward: SIMD3<Double>?, up: SIMD3<Double>?, r: Double, gain: Double, informative: Double, samples: Int
}

struct VehicleStateSnapshot: Sendable {
    var t: Double?
    var source: String
    var engine: VehicleEngine, engineConfidence: Double
    var motion: VehicleMotion, motionConfidence: Double
    var longitudinalG: Double, longitudinalSource: String
    var accelIntensity: Double, brakeIntensity: Double
    var speedMps: Double?, speedSource: String
    var turn: VehicleTurn, yawRateDegS: Double, leanEstimateDeg: Double, cornerPhase: CornerPhase, turnConfidence: Double
    var mount: MountState
    var shiftAt: Double?, shiftConfidence: Double
    var soundLevelDb: Double?, soundFloorDb: Double?
    var vibrationG: Double

    /// The compact `vehicle` object of the cockpit snapshot (docs/CONTRACT.md · 车辆状态). Lean is a visual driver only.
    func json(now: Double? = nil) -> [String: Any] {
        let r2 = { (v: Double) in (v * 100).rounded() / 100 }
        var out: [String: Any] = [
            "source": source, "engine": engine.rawValue, "engineConf": r2(engineConfidence),
            "motion": motion.rawValue, "motionConf": r2(motionConfidence),
            "longG": (longitudinalG * 1000).rounded() / 1000, "accel": r2(accelIntensity), "brake": r2(brakeIntensity),
            "turn": turn.rawValue, "yawDegS": (yawRateDegS * 10).rounded() / 10, "lean": (leanEstimateDeg * 10).rounded() / 10, "leanSource": "inferred",
            "phase": cornerPhase.rawValue, "turnConf": r2(turnConfidence),
            "mount": mount.status.rawValue, "mountConf": r2(mount.confidence),
        ]
        if let shiftAt, let now { out["shiftAgo"] = (max(0, now - shiftAt) * 100).rounded() / 100; out["shiftConf"] = shiftConfidence }
        return out
    }
}

/// Automatic mount estimate: exponentially-forgotten least squares of straight-line GPS longitudinal acceleration on
/// horizontal user acceleration gives the phone-frame forward axis.
struct MountEstimator {
    private var S = [Double](repeating: 0, count: 6), b = SIMD3<Double>.zero
    private var saa = 0.0, spp = 0.0, spa = 0.0, n = 0.0, informative = 0.0
    private(set) var up: SIMD3<Double>?
    private(set) var forward: SIMD3<Double>?
    private var gainValue = 0.0, r = 0.0, seeded = false
    private(set) var status = MountStatus.learning
    mutating func reset() { let u = up; self = MountEstimator(); up = u }
    /// A manual calibration (SensorCalibrationService) seeds the axis with medium confidence until the estimate converges.
    mutating func seed(_ f: SIMD3<Double>) { guard let u = unit(f) else { return }; forward = u; status = .calibrated; seeded = true; gainValue = 1 }
    mutating func setUp(_ u: SIMD3<Double>) { up = u }
    /// h: mean horizontal user acceleration over the GPS interval (m/s², device frame); a: GPS speed slope (m/s²).
    mutating func sample(_ h: SIMD3<Double>, _ a: Double) {
        let lam = exp(-1 / VS.mountForget)
        for i in 0..<6 { S[i] *= lam }
        b *= lam; saa *= lam; spp *= lam; spa *= lam; n = n * lam + 1
        S[0] += h.x * h.x; S[1] += h.x * h.y; S[2] += h.x * h.z; S[3] += h.y * h.y; S[4] += h.y * h.z; S[5] += h.z * h.z
        b += h * a
        informative = abs(a) >= 0.45 ? informative * lam + 1 : informative * lam
        guard let w = Self.solve3(S, b, eps: 0.05 * (n == 0 ? 1 : n) * 0.01 + 1e-3), let up else { return }
        let wh = w - up * simd_dot(w, up)
        let g = simd_length(wh)
        let p = simd_dot(w, h)
        saa += a * a; spp += p * p; spa += p * a
        r = saa > 0 && spp > 0 ? spa / sqrt(saa * spp) : 0
        guard g >= 1e-6 else { return }
        let ok = informative >= VS.mountMinInformative && r >= VS.mountMinR && g >= 0.4 && g <= 2.5
        if ok { forward = wh / g; gainValue = g; status = .converged; seeded = false }
        else if status == .converged && r < VS.mountMinR * 0.7 { status = .learning }
    }
    var gain: Double { gainValue > 0 ? gainValue : 1 }
    var confidence: Double {
        if status == .converged {
            return min(1, max(0.4, 0.4 + 0.6 * (r - VS.mountMinR) / (1 - VS.mountMinR))) * min(1, max(0.5, informative / (VS.mountMinInformative * 2)))
        }
        return seeded ? 0.5 : 0
    }
    var state: MountState { .init(status: status, confidence: confidence, forward: forward, up: up, r: r, gain: gainValue, informative: (informative * 10).rounded() / 10, samples: Int(n.rounded())) }
    /// (S + εI) w = b by Cramer's rule.
    static func solve3(_ S: [Double], _ b: SIMD3<Double>, eps: Double) -> SIMD3<Double>? {
        let m = simd_double3x3(rows: [SIMD3(S[0] + eps, S[1], S[2]), SIMD3(S[1], S[3] + eps, S[4]), SIMD3(S[2], S[4], S[5] + eps)])
        let d = m.determinant
        guard d.isFinite, abs(d) >= 1e-12 else { return nil }
        func col(_ k: Int) -> Double { var c = m; c[k] = b; return c.determinant }
        return SIMD3(col(0) / d, col(1) / d, col(2) / d)
    }
}

private func unit(_ v: SIMD3<Double>) -> SIMD3<Double>? { let l = simd_length(v); return l > 1e-9 ? v / l : nil }
private func alpha(_ dt: Double, _ tau: Double) -> Double { dt <= 0 ? 0 : 1 - exp(-dt / tau) }
private func clamp(_ v: Double, _ a: Double, _ b: Double) -> Double { max(a, min(b, v)) }
private func deg(_ r: Double) -> Double { r * 180 / Double.pi }
private func signum(_ v: Double) -> Int { v > 0 ? 1 : v < 0 ? -1 : 0 }

struct VehicleStateEstimator {
    let source: String
    private(set) var mount = MountEstimator()
    /// Called for every event (main-actor owners forward them to the roadlog / ride events).
    var onEvent: ((VehicleStateEvent) -> Void)?
    private(set) var recentEvents: [VehicleStateEvent] = []

    // motion
    private var lastMotionT: Double?, upSlow: SIMD3<Double>?, upRef: SIMD3<Double>?
    private var yaw1 = 0.0, yaw2 = 0.0, prevAcc: (t: Double, v: SIMD3<Double>)?, vibMs = 0.0, rotMs = 0.0
    private var aImuLp = 0.0, aImuSlow = 0.0, aImuVerySlow = 0.0, hAccSum = SIMD3<Double>.zero, hAccN = 0, yawAbsSum = 0.0
    // GPS
    private struct Fix { var t: Double; var v: Double; var acc: Double }
    private struct Window { var t0: Double; var t1: Double; var v0: Double; var v1: Double; var h: SIMD3<Double>; var yaw: Double; var acc: Double }
    private var fixes: [Fix] = [], lastFix: Fix?, aGps: Double?, aGpsLp = 0.0, windows: [Window] = []
    private var imu: (t: Double, v: Double)?
    // acoustic
    private var acT: Double?, level: Double?, levelFast: Double?, levelSlow: Double?, floor: Double?, micStart = 0.0
    // output
    private var nextTick: Double?, lastTickT: Double?
    private var engine = VehicleEngine.unknown, engineConf = 0.0, engineSince = 0.0, onEvidenceSince: Double?, offEvidenceSince: Double?
    private var motion = VehicleMotion.stopped, motionConf = 0.3, motionSince = 0.0
    private var pending: (since: Double, state: VehicleMotion, stateSince: Double)?, launchAt: Double?, handlingUntil: Double?, noGpsMoveSince: Double?
    private var longG = 0.0, aState = 0.0, longSource = "none", speed: Double?, speedSource = "none"
    private var turn = VehicleTurn.none, rise: (t: Double, sign: Int, angle: Double)?, lastCornerEnd = -Double.infinity, micOnSince: Double?
    private var lfHist: [Double] = [], turnCandSince: Double?, turnCandSign = 0, turnOffSince: Double?
    private struct Corner { var t0: Double; var sign: Int; var angle: Double; var peak: Double; var last: Double }
    private var corner: Corner?, phase = CornerPhase.none, lean = 0.0, yawDegS = 0.0
    private var revSince: Double?, revBase = 0.0, shift: (t: Double, confidence: Double)?
    private struct ShiftCand { var t0: Double; var peak: Double; var min: Double; var lvl0: Double?; var lvlMin: Double? }
    private var shiftCand: ShiftCand?, accelPeak = 0.0, lastShiftT = -Double.infinity, accelSince: Double?
    private var vibration: Double { sqrt(max(0, vibMs)) }

    init(simulated: Bool = false, calibrationForward: SIMD3<Double>? = nil) {
        source = simulated ? "simulated" : "inferred"
        if let calibrationForward { mount.seed(calibrationForward) }
    }

    private var undrained: [VehicleStateEvent] = []
    private mutating func emit(_ e: VehicleStateEvent) {
        recentEvents.append(e); if recentEvents.count > 400 { recentEvents.removeFirst() }
        undrained.append(e); if undrained.count > 400 { undrained.removeFirst() }
        onEvent?(e)
    }
    /// Events since the last call (owners poll after each input).
    mutating func drainEvents() -> [VehicleStateEvent] { defer { undrained.removeAll(keepingCapacity: true) }; return undrained }
    private mutating func setMotion(_ t: Double, _ next: VehicleMotion, _ conf: Double) {
        if next == motion { motionConf = conf; return }
        emit(.init(t: t, kind: .state, field: "motion", from: motion.rawValue, to: next.rawValue, confidence: conf, source: source))
        motion = next; motionSince = t; motionConf = conf
    }
    private mutating func setEngine(_ t: Double, _ next: VehicleEngine, _ conf: Double) {
        if next == engine { engineConf = conf; return }
        emit(.init(t: t, kind: .state, field: "engine", from: engine.rawValue, to: next.rawValue, confidence: conf, source: source))
        engine = next; engineSince = t; engineConf = conf
    }
    private mutating func setTurn(_ t: Double, _ next: VehicleTurn) {
        if next == turn { return }
        emit(.init(t: t, kind: .state, field: "turn", from: turn.rawValue, to: next.rawValue, confidence: turnConfidence, source: source))
        turn = next
    }

    /// userAcceleration and gravity in g, rotationRate in rad/s, all in the CoreMotion device frame.
    mutating func motion(t: Double, userAcceleration ua: SIMD3<Double>, gravity grav: SIMD3<Double>, rotation rot: SIMD3<Double>) {
        guard t.isFinite, [ua.x, ua.y, ua.z, grav.x, grav.y, grav.z, rot.x, rot.y, rot.z].allSatisfy(\.isFinite) else { return }
        let dt = lastMotionT.map { t - $0 } ?? 0
        if lastMotionT != nil, dt <= 0 || dt > 0.5 { lastMotionT = t; prevAcc = nil; if dt <= 0 { return } }
        lastMotionT = t
        guard let u = unit(-grav) else { return }
        if let slow = upSlow { upSlow = unit(slow + (u - slow) * alpha(dt, VS.upSlowTauS)) ?? slow } else { upSlow = u }
        let up = upSlow!
        // Phone turned in the mount (slow vertical moved > 25° from where the mount was learned): relearn.
        if let ref = upRef {
            if simd_dot(up, ref) < VS.remountCos { mount.reset(); upRef = up; emit(.init(t: t, kind: .mountReset, to: "orientationChanged", source: source)) }
        } else { upRef = up }
        mount.setUp(up)
        // Yaw about the true vertical; two low-pass stages remove the 1.7 Hz mount wobble.
        let yaw = simd_dot(rot, u), ky = alpha(dt, VS.yawTauS)
        yaw1 += (yaw - yaw1) * ky; yaw2 += (yaw1 - yaw2) * ky
        // Vibration: first difference of user acceleration sampled at ≈25 Hz (rate-independent), mean square in g².
        if prevAcc == nil || t - prevAcc!.t >= VS.vibSampleS {
            if let p = prevAcc { let d = ua - p.v, kv = alpha(t - p.t, VS.vibTauS); vibMs += (simd_dot(d, d) / 2 - vibMs) * kv; rotMs += (simd_dot(rot, rot) - rotMs) * kv }
            prevAcc = (t, ua)
        }
        // Horizontal user acceleration (m/s²) for the mount estimate and the IMU forward component.
        let am = ua * VS.g0, h = am - up * simd_dot(am, up)
        hAccSum += h; hAccN += 1; yawAbsSum += abs(deg(yaw2))
        let af = mount.forward.map { simd_dot(h, $0) } ?? 0
        aImuLp += (af - aImuLp) * alpha(dt, VS.aImuTauS)
        aImuSlow += (aImuLp - aImuSlow) * alpha(dt, VS.aImuSlowTauS)
        aImuVerySlow += (aImuLp - aImuVerySlow) * alpha(dt, VS.aImuNoGpsTauS)
        advance(t)
    }

    mutating func gps(t: Double, speed: Double?, accuracy acc: Double = 0.5, horizontalAccuracy hAcc: Double = 5) {
        guard t.isFinite else { return }
        guard let speed, speed.isFinite, speed >= 0, speed < 90, acc.isFinite, acc >= 0, acc <= VS.gpsMaxSpeedAcc, !hAcc.isFinite || hAcc <= 65 else { advance(t); return }
        let fix = Fix(t: t, v: speed, acc: acc)
        // Mount sample: interval to the previous fix (0.5–1.6 s), straight, fast enough; two adjacent intervals ≈ 2 s window.
        if let last = lastFix, t - last.t >= 0.5, t - last.t <= 1.6, hAccN > 0 {
            windows.append(.init(t0: last.t, t1: t, v0: last.v, v1: speed, h: hAccSum / Double(hAccN), yaw: yawAbsSum / Double(hAccN), acc: max(acc, last.acc)))
            if windows.count > 3 { windows.removeFirst() }
            if windows.count >= 2 {
                let a = windows[windows.count - 2], c = windows[windows.count - 1]
                if abs(a.t1 - c.t0) < 1e-6 {
                    let slope = (c.v1 - a.v0) / (c.t1 - a.t0), hm = (a.h + c.h) * 0.5
                    if min(a.v0, c.v1) >= VS.mountMinMps, (a.yaw + c.yaw) / 2 < VS.mountStraightDegS, max(a.acc, c.acc) <= 1.2, abs(slope) < 6 { mount.sample(hm, slope) }
                }
            }
        } else { windows = [] }
        hAccSum = .zero; hAccN = 0; yawAbsSum = 0
        fixes.append(fix); lastFix = fix
        while let first = fixes.first, t - first.t > VS.gpsSlopeSpanS { fixes.removeFirst() }
        if fixes.count >= 2, fixes[fixes.count - 1].t - fixes[0].t >= 1.4 {
            let n = Double(fixes.count), mt = fixes.reduce(0) { $0 + $1.t } / n, mv = fixes.reduce(0) { $0 + $1.v } / n
            var num = 0.0, den = 0.0
            for x in fixes { num += (x.t - mt) * (x.v - mv); den += (x.t - mt) * (x.t - mt) }
            aGps = den > 0 ? clamp(num / den, -9, 7) : nil
        } else if fixes.count < 2 { aGps = nil }
        advance(t)
    }
    mutating func imuSpeed(t: Double, speed: Double?) { imu = speed.flatMap { $0.isFinite && $0 >= 0 ? (t, $0) : nil }; advance(t) }

    mutating func acoustic(t: Double, rmsDbfs rms: Double) {
        guard t.isFinite, rms.isFinite else { return }
        let dt = acT.map { clamp(t - $0, 0, 1) } ?? 0; acT = t
        if level == nil { micStart = t; level = rms; levelFast = rms; levelSlow = rms; floor = rms }
        level! += (rms - level!) * alpha(dt, 0.5)
        levelFast! += (rms - levelFast!) * alpha(dt, 0.12)
        levelSlow! += (rms - levelSlow!) * alpha(dt, 3)
        floor = min(level!, floor! + 0.05 * dt)
        advance(t)
    }

    mutating func advance(_ t: Double) {
        if nextTick == nil { nextTick = t }
        while t >= nextTick! { tick(nextTick!); nextTick! += VS.tickS }
    }

    private func currentSpeed(_ t: Double) -> (v: Double, src: String)? {
        if let f = lastFix, t - f.t <= VS.gpsMaxAgeS { return (max(0, f.v + clamp(longG * VS.g0, -9, 7) * clamp(t - f.t, 0, 1.2) * 0.5), "gps") }
        if let imu, t - imu.t <= 1 { return (imu.v, "imu") }
        return nil
    }
    private var turnConfidence: Double {
        clamp(0.35 + (abs(yawDegS) - VS.turnOffDegS) / 30 + (speedSource == "gps" ? 0.2 : 0) + ((speed ?? 0) > 5 ? 0.1 : 0), 0.2, 0.9)
    }

    private mutating func tick(_ t: Double) {
        let dt = lastTickT.map { clamp(t - $0, 0, 1) } ?? VS.tickS; lastTickT = t
        let motionFresh = lastMotionT.map { t - $0 <= 0.5 } ?? false
        let sp = currentSpeed(t)
        speed = sp?.v; speedSource = sp?.src ?? "none"
        let vib = vibration, rotRms = sqrt(max(0, rotMs))
        // ---------- longitudinal (complementary) ----------
        let gpsFresh = lastFix.map { t - $0.t <= VS.gpsMaxAgeS } == true && aGps != nil
        let mc = mount.confidence
        if gpsFresh {
            aGpsLp += (aGps! - aGpsLp) * alpha(dt, VS.aGpsTauS)
            let comp = mc > 0 ? clamp(0.85 * min(1, mc + 0.2) * mount.gain * (aImuLp - aImuSlow), -VS.imuComplementMaxG * VS.g0, VS.imuComplementMaxG * VS.g0) : 0
            longG = (aGpsLp + comp) / VS.g0
            longSource = mc > 0 ? "gps+imu" : "gps"
        } else if mc >= 0.4 && motionFresh {
            aGpsLp *= exp(-dt / 2)
            longG = mount.gain * (aImuLp - aImuVerySlow) / VS.g0
            longSource = "imu"
        } else { longG *= exp(-dt / 0.5); longSource = "none"; aGpsLp *= exp(-dt / 2) }
        // ---------- motion ----------
        let handling = rotRms > VS.handlingRotRad
        if handling { handlingUntil = t + VS.handlingSettleS }
        let imuSettled = !handling && t >= (handlingUntil ?? -.infinity)
        let stoppedNow: Bool
        if let speed { stoppedNow = motion == .stopped ? speed < VS.stopExitMps : speed < VS.stopEnterMps }
        else if motion == .stopped {
            // No speed: leaving standstill needs sustained riding-level vibration (≥5 s); handling the phone does not count.
            if motionFresh && vib >= VS.movingNoGpsVibG && imuSettled { noGpsMoveSince = noGpsMoveSince ?? t } else { noGpsMoveSince = nil }
            stoppedNow = noGpsMoveSince == nil || t - noGpsMoveSince! < VS.movingNoGpsHoldS
        } else { stoppedNow = motionFresh && vib < 0.1 && abs(deg(yaw2)) < 3 }
        // Decisions use a further 0.3 s smoothed value (intensities use the raw one); IMU-only thresholds ×1.5.
        aState += (longG - aState) * alpha(dt, VS.aStateTauS)
        let a = longSource == "imu" ? aState / VS.imuOnlyThresholdScale : aState
        let conf = longSource == "gps+imu" ? 0.8 : longSource == "gps" ? 0.65 : longSource == "imu" ? 0.35 : 0.2
        let cur = motion
        let want: VehicleMotion
        if stoppedNow { want = .stopped }
        else if cur == .stopped { want = a > 0.02 || speed == nil ? .launching : .cruising }
        else if cur == .launching, (speed ?? 0) < VS.launchMaxMps, t - (launchAt ?? t) < VS.launchMaxS, a > 0 { want = .launching }
        else if longSource == "none" { want = .cruising }
        else {
            let wasBrake = cur == .braking || cur == .hardBraking, wasAccel = cur == .accelerating || cur == .launching
            if a <= (cur == .hardBraking ? VS.hardOffG : VS.hardOnG) { want = .hardBraking }
            else if a <= (wasBrake ? VS.brakeOffG : VS.brakeOnG) { want = .braking }
            else if a >= (wasAccel ? VS.accelOffG : VS.accelOnG) { want = .accelerating }
            else if a <= VS.coastOnG { want = .coasting }
            else { want = .cruising }
        }
        // The wanted state must persist holdS; if leaving has lasted 1.2 s while the target keeps changing, take the latest (≥0.2 s).
        let stoppedConf = speed != nil ? 0.85 : 0.5
        if want == cur { pending = nil }
        else {
            if pending == nil { pending = (t, want, t) }
            if pending!.state != want { pending!.state = want; pending!.stateSince = t }
            let hold = cur == .stopped && want != .stopped ? 0 : VS.holdS[want] ?? 0.5
            if t - pending!.stateSince >= hold || (t - pending!.since >= VS.leaveMaxS && t - pending!.stateSince >= 0.2) {
                if want == .launching { launchAt = t }
                setMotion(t, want, want == .stopped ? stoppedConf : conf); pending = nil
            }
        }
        if motion == cur { motionConf = motion == .stopped ? stoppedConf : conf }
        let moving = motion != .stopped
        // ---------- engine ----------
        let micLive = acT.map { t - $0 <= 1 } ?? false
        var eng = engine, econf = engineConf
        if moving { eng = .running; econf = speed != nil ? 0.9 : 0.6; onEvidenceSince = nil; offEvidenceSince = nil }
        else if motionFresh && imuSettled {
            if vib >= VS.vibOnG { onEvidenceSince = onEvidenceSince ?? t; offEvidenceSince = nil }
            else if vib < VS.vibOffG { offEvidenceSince = offEvidenceSince ?? t; onEvidenceSince = nil }
            else { onEvidenceSince = nil; offEvidenceSince = nil }
            let micAgrees = micLive && floor != nil && level! - floor! >= VS.micOnAboveFloorDb
            if let on = onEvidenceSince, t - on >= VS.engineOnHoldS, eng != .idle, eng != .revving { eng = .idle; econf = micLive ? (micAgrees ? 0.85 : 0.6) : 0.65 }
            else if let off = offEvidenceSince, t - off >= VS.engineOffHoldS, eng != .off { eng = .off; econf = micLive ? (micAgrees ? 0.45 : 0.85) : 0.7 }
            else if eng == .running { eng = .idle }
        } else if micLive, let floor, let level, !motionFresh || !imuSettled {
            // IMU unusable (no data or phone being handled): only a level clearly above this ride's quietest counts; floor needs ≥5 s.
            let loud = t - micStart >= 5 && level - floor >= VS.micOnAboveFloorDb + 2
            if loud { micOnSince = micOnSince ?? t } else { micOnSince = nil }
            if loud && t - micOnSince! >= 2 { if eng == .off || eng == .unknown || eng == .running { eng = .idle; econf = 0.45 } }
            else if !loud && eng == .running { eng = .idle }
            // A quiet microphone alone never means "off" (the floor may be the idle sound): keep the state.
        } else if eng == .running { eng = .idle }
        if let levelFast { lfHist.append(levelFast); if lfHist.count > 6 { lfHist.removeFirst() } }
        // Revving at standstill: fast level jumps above the 3 s level; the baseline freezes when it starts.
        if !moving, eng == .idle || eng == .revving, micLive, let levelSlow, let levelFast {
            if eng == .idle {
                if t - motionSince >= VS.revSettleS, levelFast - levelSlow >= VS.revRiseDb, levelFast - (lfHist.min() ?? levelFast) >= VS.revOnsetDb { eng = .revving; econf = 0.55; revSince = t; revBase = levelSlow }
            } else if levelFast - revBase <= VS.revFallDb || t - (revSince ?? t) > VS.revMaxS { eng = .idle; econf = 0.6 }
        } else if eng == .revving { eng = moving ? .running : .idle }
        setEngine(t, eng, econf)
        // ---------- turn ----------
        let yawDeg = deg(yaw2)
        yawDegS = yawDeg
        let canTurn = moving && speed != nil && speed! >= VS.turnMinMps
        let s = signum(yawDeg), mag = abs(yawDeg)
        // The corner start is back-dated to when |yaw| crossed the exit threshold (detection adds 0.3 s hold + filter delay).
        if !canTurn || mag < VS.turnOffDegS || (rise != nil && rise!.sign != s) { rise = nil }
        if canTurn && mag >= VS.turnOffDegS { if rise == nil { rise = (t, s, 0) }; rise!.angle += yawDeg * dt }
        if !canTurn { endCorner(t); turnCandSince = nil; turnCandSign = 0; turnOffSince = nil; setTurn(t, .none) }
        else {
            let wanted: VehicleTurn? = mag >= VS.turnOnDegS ? (s > 0 ? .left : .right) : nil
            if turn == .none {
                if let wanted {
                    if turnCandSign != s { turnCandSign = s; turnCandSince = t }
                    if t - turnCandSince! >= VS.turnOnHoldS { setTurn(t, wanted); startCorner(t, s) }
                } else { turnCandSince = nil; turnCandSign = 0 }
            } else {
                let curSign = turn == .left ? 1 : -1
                if let wanted, s != curSign {
                    if turnCandSign != s { turnCandSign = s; turnCandSince = t }
                    if t - turnCandSince! >= VS.turnOnHoldS { endCorner(t); setTurn(t, wanted); startCorner(t, s) }
                } else if mag < VS.turnOffDegS || s != curSign {
                    turnOffSince = turnOffSince ?? t
                    if t - turnOffSince! >= VS.turnOffHoldS { endCorner(t); setTurn(t, .none) }
                } else { turnOffSince = nil; turnCandSign = curSign }
            }
        }
        if var c = corner {
            c.angle += yawDeg * dt; c.peak = max(c.peak, mag)
            let rising = mag > c.last + 0.15
            c.last = mag; corner = c
            phase = t - c.t0 < 0.5 || (rising && mag < c.peak * 0.98) ? (mag >= c.peak * 0.98 && t - c.t0 >= 0.5 ? .apex : .entry) : mag < c.peak * 0.6 ? .exit : .apex
        } else { phase = .none }
        // Lean (visual only): centripetal relation atan(v·ω/g).
        let leanT = canTurn ? clamp(deg(atan(speed! * yaw2 / VS.g0)), -VS.leanMaxDeg, VS.leanMaxDeg) : 0
        lean += (leanT - lean) * alpha(dt, 0.25)
        detectShift(t, micLive: micLive)
    }

    private mutating func startCorner(_ t: Double, _ s: Int) {
        let r = rise.flatMap { $0.sign == s && $0.t >= lastCornerEnd ? $0 : nil }
        corner = Corner(t0: r?.t ?? t, sign: s, angle: r.map { $0.angle - deg(yaw2) * VS.tickS } ?? 0, peak: 0, last: 0)
    }
    private mutating func endCorner(_ t: Double) {
        guard let c = corner else { return }
        corner = nil; lastCornerEnd = t
        if abs(c.angle) >= VS.cornerMinDeg && t - c.t0 >= VS.cornerMinS {
            emit(.init(t: t, kind: .corner, confidence: clamp(0.4 + abs(c.angle) / 200, 0.4, 0.8), dir: c.sign > 0 ? "left" : "right", start: c.t0, end: t,
                       angleDeg: abs(c.angle).rounded(), peakDegS: (c.peak * 10).rounded() / 10, source: source))
        }
    }
    /// Suspected shift: while accelerating, the longitudinal acceleration briefly drops together with
    /// a ≥2 dB sound dip that recovers. Only with the microphone and once the mount axis converged (1 Hz GPS cannot see a 0.2–0.8 s dip).
    private mutating func detectShift(_ t: Double, micLive: Bool) {
        let a = longG
        guard motion == .accelerating || motion == .launching else { accelSince = nil; shiftCand = nil; accelPeak = 0; return }
        if accelSince == nil { accelSince = t }
        guard mount.status == .converged, longSource == "gps+imu", micLive else { return }
        guard var c = shiftCand else {
            accelPeak = max(accelPeak * exp(-VS.tickS / 2), a)
            if t - accelSince! >= VS.shiftMinAccelS, accelPeak >= 0.08, a <= accelPeak * VS.shiftCandFrac, t - lastShiftT >= VS.shiftCooldownS {
                shiftCand = ShiftCand(t0: t, peak: accelPeak, min: a, lvl0: micLive ? lfHist.max() : nil, lvlMin: micLive ? levelFast : nil)
            }
            return
        }
        c.min = min(c.min, a)
        if micLive, let m = c.lvlMin, let lf = levelFast { c.lvlMin = min(m, lf) }
        shiftCand = c
        let dur = t - c.t0
        if dur > 1.0 { shiftCand = nil; return }
        guard a >= c.peak * 0.7, dur >= 0.15 else { return }
        // Longitudinal dip AND a ≥2 dB sound dip that recovers. No microphone, no event: in the synthetic replay IMU-only dips were all mount vibration.
        let deep = c.min <= c.peak * shiftDeepFraction
        let soundDip: Double? = c.lvl0 != nil && c.lvlMin != nil ? c.lvl0! - c.lvlMin! : nil
        let sound = soundDip != nil && soundDip! >= VS.shiftSoundDipDb && (levelFast ?? -.infinity) >= c.lvlMin! + 1
        shiftCand = nil
        guard sound else { return }
        let confidence = deep ? 0.45 : 0.35
        shift = (c.t0, confidence); lastShiftT = t
        emit(.init(t: c.t0, kind: .suspectedShift, confidence: confidence, dipG: ((c.peak - c.min) * 1000).rounded() / 1000,
                   soundDipDb: soundDip.map { ($0 * 10).rounded() / 10 }, source: source))
    }

    mutating func recalibrateMount() { mount.reset(); upRef = upSlow }
    /// Personal sensitivity from VehicleLearningService: how deep a dip counts (0.3…0.6 of the recent peak).
    private(set) var shiftDeepFraction = VS.shiftDeepFrac
    mutating func setShiftSensitivity(_ fraction: Double) { shiftDeepFraction = clamp(fraction.isFinite ? fraction : VS.shiftDeepFrac, 0.3, 0.6) }

    func snapshot() -> VehicleStateSnapshot {
        let moving = motion != .stopped
        let accelOn = motion == .accelerating || motion == .launching, brakeOn = motion == .braking || motion == .hardBraking
        return .init(t: lastTickT, source: source, engine: engine, engineConfidence: engineConf, motion: motion, motionConfidence: motionConf,
                     longitudinalG: moving ? longG : 0, longitudinalSource: longSource,
                     accelIntensity: moving ? clamp((longG - 0.02) / 0.22, 0, 1) * (accelOn ? 1 : 0.4) : 0,
                     brakeIntensity: moving ? clamp((-longG - 0.03) / 0.3, 0, 1) * (brakeOn ? 1 : 0.4) : 0,
                     speedMps: speed, speedSource: speedSource,
                     turn: turn, yawRateDegS: yawDegS, leanEstimateDeg: lean, cornerPhase: phase, turnConfidence: turn == .none ? 0 : turnConfidence,
                     mount: mount.state, shiftAt: shift?.t, shiftConfidence: shift?.confidence ?? 0,
                     soundLevelDb: level, soundFloorDb: floor, vibrationG: vibration)
    }
}
