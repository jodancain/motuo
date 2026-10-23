import Foundation

/// Ride candidate events from VehicleStateEstimator. Heuristics are candidates, never gear or vehicle-health ground truth.
/// The former acceleration-magnitude jerk rule fired every cooldown on a vibrating handlebar mount (real ride: every 12 s)
/// and its rotation-magnitude turn rule found 1 of ~11 corners; both now come from the estimator.
struct RideSignalProcessor {
    private(set) var jerkThreshold: Double = VehicleLearningMath.defaultThreshold
    mutating func setThreshold(_ value: Double?) { jerkThreshold = value.flatMap { $0.isFinite && (18...40).contains($0) ? $0 : nil } ?? VehicleLearningMath.defaultThreshold }
    mutating func reset() { let threshold = jerkThreshold; self = Self(); jerkThreshold = threshold }
    /// Personal sensitivity: the learned threshold (default 22) scales how deep the acceleration dip must be —
    /// a lower threshold accepts shallower dips. Clamped to 0.3…0.6 of the recent peak.
    var shiftDeepFraction: Double { min(0.6, max(0.3, VS.shiftDeepFrac * VehicleLearningMath.defaultThreshold / jerkThreshold)) }
    /// corner → "turn", suspectedShift → "suspectedShift" (only while moving ≥ 3 m/s). State changes are not ride events.
    /// `wall` maps estimator (uptime) seconds to wall-clock dates.
    func rideEvent(_ e: VehicleStateEvent, wall: (Double) -> Date?, speed: Double?, simulated: Bool) -> RideEvent? {
        let source = simulated ? "simulated" : "inferred"
        switch e.kind {
        case .corner:
            guard let start = e.start.flatMap(wall), let end = e.end.flatMap(wall), end >= start, end.timeIntervalSince(start) <= 10 else { return nil }
            return RideEvent(kind: "turn", timestamp: start.addingTimeInterval(end.timeIntervalSince(start) / 2), windowStart: start, windowEnd: end, confidence: e.confidence, source: source)
        case .suspectedShift:
            guard let speed, speed >= 3, let at = wall(e.t) else { return nil }
            return RideEvent(kind: "suspectedShift", timestamp: at, windowStart: at.addingTimeInterval(-2), windowEnd: at.addingTimeInterval(2), confidence: e.confidence, source: source)
        default: return nil
        }
    }
}

struct SpeedQuality {
    static func accepted(speed: Double, accuracy: Double, timestamp: Date, now: Date) -> Double? {
        guard speed.isFinite, accuracy.isFinite, speed >= 0, accuracy >= 0, accuracy <= 5,
              abs(now.timeIntervalSince(timestamp)) <= 4 else { return nil }
        return speed
    }
}

/// Uptime stays in memory; serialized elapsed values reveal only this recording segment.
/// GPS has no monotonic clock. Its relative time is explicitly wall-anchor derived.
struct TelemetrySegmentClock {
    let id: UUID
    let wallAnchor: Date
    private let uptimeAnchor: TimeInterval
    init(wall: Date = Date(), uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        id = UUID(); wallAnchor = wall; uptimeAnchor = uptime
    }
    func motion(uptime: TimeInterval) -> (timestamp: Date, elapsed: Double)? {
        let elapsed = uptime - uptimeAnchor
        guard elapsed.isFinite, elapsed >= 0 else { return nil }
        return (wallAnchor.addingTimeInterval(elapsed), elapsed)
    }
    func location(timestamp: Date) -> Double? {
        let elapsed = timestamp.timeIntervalSince(wallAnchor)
        return elapsed.isFinite && elapsed >= 0 ? elapsed : nil
    }
}

/// Directional trend comes from successive valid GPS speeds, not acceleration magnitude.
struct GPSSpeedTrend {
    private var previous: (speed: Double, accuracy: Double, timestamp: Date)?
    private var candidate = 0
    private var consecutive = 0
    mutating func reset() { self = Self() }
    mutating func update(speed: Double?, accuracy: Double, timestamp: Date, now: Date) -> Int {
        guard let speed, speed.isFinite, (0...80).contains(speed), accuracy.isFinite,
              (0...1.5).contains(accuracy), now.timeIntervalSince(timestamp) >= -1,
              now.timeIntervalSince(timestamp) <= 3 else { reset(); return 0 }
        let prior = previous
        previous = (speed, accuracy, timestamp)
        guard let prior else { return 0 }
        let dt = timestamp.timeIntervalSince(prior.timestamp)
        guard (0.5...3).contains(dt), speed >= 1.1 else { candidate = 0; consecutive = 0; return 0 }
        let delta = speed - prior.speed
        let acceleration = delta / dt
        // Require a change greater than the reported uncertainty and reject implausible jumps.
        guard abs(acceleration) >= 0.6, abs(acceleration) <= 7,
              abs(delta) > max(0.5, (accuracy + prior.accuracy) * 0.6) else { candidate = 0; consecutive = 0; return 0 }
        let sign = acceleration > 0 ? 1 : -1
        consecutive = candidate == sign ? consecutive + 1 : 1; candidate = sign
        return consecutive >= 2 ? sign : 0
    }
}
