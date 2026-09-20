import Foundation

/// Heuristics are candidate events, never gear or vehicle-health ground truth.
struct RideSignalProcessor {
    private(set) var jerkThreshold: Double = VehicleLearningMath.defaultThreshold
    mutating func setThreshold(_ value: Double?) { jerkThreshold = value.flatMap { $0.isFinite && (18...40).contains($0) ? $0 : nil } ?? VehicleLearningMath.defaultThreshold }
    private var lastTimestamp: TimeInterval?
    private var lastAcceleration: Double = 0
    private var lastEventTime: TimeInterval = -.infinity
    private var turnStarted: TimeInterval?
    mutating func reset() { let threshold = jerkThreshold; self = Self(); jerkThreshold = threshold }
    mutating func process(acceleration: Double, rotation: Double, speed: Double?, timestamp: Date, monotonic: Double, simulated: Bool) -> RideEvent? {
        defer { lastTimestamp = monotonic; lastAcceleration = acceleration }
        guard let lastTimestamp, monotonic > lastTimestamp, monotonic - lastTimestamp < 0.25,
              let speed, speed >= 3, monotonic - lastEventTime > 12 else { return nil }
        let jerk = abs(acceleration - lastAcceleration) / (monotonic - lastTimestamp)
        var kind: String?
        if rotation > 0.25 {
            if turnStarted == nil { turnStarted = monotonic }
            if monotonic - (turnStarted ?? monotonic) > 1.5 { kind = "turn" }
        } else { turnStarted = nil }
        if jerk > jerkThreshold, acceleration > 1.3, rotation < 0.18 { kind = "suspectedShift" }
        guard let kind else { return nil }
        lastEventTime = monotonic; turnStarted = nil
        return RideEvent(kind: kind, timestamp: timestamp,
                         windowStart: timestamp.addingTimeInterval(-2), windowEnd: timestamp.addingTimeInterval(2),
                         confidence: 0.45, source: simulated ? "simulated" : "inferred")
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
