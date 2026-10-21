import Foundation

/// The saved speed timeline of one ride, for the cockpit's end-of-ride comic.
/// Built only from telemetry already written to the journal (measured GPS or explicitly simulated demo samples, ~1 Hz);
/// inertial estimates are never recorded, so they never appear here. Time base is ride-elapsed seconds without pauses,
/// the same base as `RideEngine.elapsedSeconds` and the cockpit's `speedSampleElapsed`.
struct RideTimeline: Equatable, Sendable {
    struct Point: Equatable, Sendable { var t: Double; var kmh: Double? }
    struct Event: Equatable, Sendable { var t: Double; var kind: String }
    var points: [Point]
    var events: [Event]
    static let maxPoints = 1200

    /// `samples` in journal order. Each recording segment restarts monotonicS at zero; segments are laid end to end.
    static func build(samples: [TelemetrySample], events rideEvents: [RideEvent] = [], maxPoints: Int = maxPoints) -> RideTimeline {
        var points: [Point] = [], stamps: [(Date, Double)] = []
        var offset = 0.0, last: Double?, lastSegment: String?
        for sample in samples where sample.stream != "motion" {
            // A new segment (resume, crash recovery, clock change) restarts monotonicS; continue one reading interval later.
            if let previous = last, sample.monotonicS < previous || (sample.segmentId != nil && lastSegment != nil && sample.segmentId != lastSegment) { offset += max(0, previous) + 1 }
            last = sample.monotonicS; lastSegment = sample.segmentId
            let t = offset + max(0, sample.monotonicS)
            let kmh = sample.speedMPS.flatMap { $0.isFinite && $0 >= 0 ? $0 * 3.6 : nil }
            points.append(Point(t: (t * 10).rounded() / 10, kmh: kmh.map { ($0 * 10).rounded() / 10 }))
            stamps.append((sample.timestamp, t))
        }
        if points.count > maxPoints {
            // Keep whole readings (no averaging): every kept value is one that was recorded. Always keep the peak.
            let stride = Int((Double(points.count) / Double(maxPoints)).rounded(.up))
            let peak = points.indices.max { (points[$0].kmh ?? -1) < (points[$1].kmh ?? -1) }
            points = points.enumerated().filter { $0.offset % stride == 0 || $0.offset == peak || $0.offset == points.count - 1 }.map(\.element)
        }
        // Events carry wall-clock times; place each at the ride time of the nearest saved sample.
        let mapped: [Event] = rideEvents.compactMap { event in
            guard let nearest = stamps.min(by: { abs($0.0.timeIntervalSince(event.timestamp)) < abs($1.0.timeIntervalSince(event.timestamp)) }),
                  abs(nearest.0.timeIntervalSince(event.timestamp)) <= 5 else { return nil }
            return Event(t: (nearest.1 * 10).rounded() / 10, kind: event.kind)
        }
        return RideTimeline(points: points, events: mapped)
    }

    var json: [String: Any] {
        ["timeline": points.map { ["t": $0.t, "v": $0.kmh.map { $0 as Any } ?? NSNull()] },
         "events": events.map { ["t": $0.t, "kind": $0.kind] }]
    }
}
