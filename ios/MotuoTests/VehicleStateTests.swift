import XCTest
import simd
@testable import Motuo

/// Deterministic generator so randomized inputs are reproducible (SplitMix64).
struct SeededRNG: RandomNumberGenerator {
    var state: UInt64
    init(_ seed: UInt64) { state = seed }
    mutating func next() -> UInt64 { state &+= 0x9E3779B97F4A7C15; var z = state; z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9; z = (z ^ (z >> 27)) &* 0x94D049BB133111EB; return z ^ (z >> 31) }
}

/// VehicleStateEstimator on the parameter-generated synthetic replay (bundled), cross-checked against the JS estimator's
/// key state sequence, plus behaviour checks. The real-ride fixture is only read from MOTUO_REPLAY_FIXTURE (never in Git).
final class VehicleStateTests: XCTestCase {
    struct Run { var snaps: [VehicleStateSnapshot]; var events: [VehicleStateEvent] }
    static func run(_ replay: VehicleReplay, simulated: Bool = true, withMic: Bool = true) -> Run {
        var estimator = VehicleStateEstimator(simulated: simulated)
        var snaps: [VehicleStateSnapshot] = [], events: [VehicleStateEvent] = []
        var next = ((replay.samples.first?.t ?? 0) * 10).rounded(.up) / 10
        for sample in replay.samples {
            if !withMic, case .acoustic = sample { continue }
            while sample.t >= next { let s = estimator.snapshot(); if s.t != nil { snaps.append(s) }; next += 0.1 }
            VehicleReplay.feed(sample, into: &estimator)
            events += estimator.drainEvents()
        }
        return .init(snaps: snaps, events: events)
    }
    static func synthetic() throws -> (VehicleReplay, [String: Any]) {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "synthetic-ride", withExtension: "json"), "synthetic replay bundled with the app")
        let data = try Data(contentsOf: url)
        return (try VehicleReplay(data: data), try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]))
    }
    static func expected() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: VehicleStateTests.self).url(forResource: "synthetic-expected", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    static let r1 = { (v: Double) in (v * 10).rounded() / 10 }

    /// Cross-consistency: the same synthetic replay gives the same key state sequence in Swift and JS.
    func testSyntheticReplayMatchesJavaScriptKeySequence() throws {
        let (replay, _) = try Self.synthetic(), expected = try Self.expected()
        let run = Self.run(replay)
        let states = run.events.filter { $0.kind == .state }
        let exp = try XCTUnwrap(expected["states"] as? [[String: Any]])
        XCTAssertEqual(states.map { "\($0.field!)→\($0.to!)" }, exp.map { "\($0["field"]!)→\($0["to"]!)" }, "state sequence differs from the JS estimator")
        for (s, e) in zip(states, exp) { XCTAssertEqual(Self.r1(s.t), (e["t"] as! NSNumber).doubleValue, accuracy: 0.11, "\(s.field!)→\(s.to!)") }
        let corners = run.events.filter { $0.kind == .corner }, expCorners = try XCTUnwrap(expected["corners"] as? [[String: Any]])
        XCTAssertEqual(corners.map { $0.dir! }, expCorners.map { $0["dir"] as! String })
        for (c, e) in zip(corners, expCorners) {
            XCTAssertEqual(Self.r1(c.start!), (e["start"] as! NSNumber).doubleValue, accuracy: 0.11)
            XCTAssertEqual(c.angleDeg!, (e["angleDeg"] as! NSNumber).doubleValue, accuracy: 1)
        }
        let shifts = run.events.filter { $0.kind == .suspectedShift }.map { Self.r1($0.t) }
        XCTAssertEqual(shifts, (expected["shifts"] as? [NSNumber])?.map(\.doubleValue))
    }

    /// Every state is acted out by the synthetic replay; the estimator recognises each within its truth segments.
    func testSyntheticStatesAreRecognised() throws {
        let (replay, json) = try Self.synthetic()
        let run = Self.run(replay)
        let truth = try XCTUnwrap(json["truth"] as? [[String: Any]])
        func accuracy(_ field: String, _ value: (VehicleStateSnapshot) -> String) -> Double {
            var n = 0, ok = 0
            for seg in truth {
                guard let want = seg[field] else { continue }
                let allowed = (want as? [String]) ?? [want as! String]
                let t0 = (seg["t0"] as! NSNumber).doubleValue + ((seg["settle"] as? NSNumber)?.doubleValue ?? 1), t1 = (seg["t1"] as! NSNumber).doubleValue
                for s in run.snaps where s.t! >= t0 && s.t! < t1 { n += 1; if allowed.contains(value(s)) { ok += 1 } }
            }
            return n > 0 ? Double(ok) / Double(n) : 0
        }
        let engine = accuracy("engine") { $0.engine.rawValue }, motion = accuracy("motion") { $0.motion.rawValue }, turn = accuracy("turn") { $0.turn.rawValue }
        print("synthetic accuracy engine \(engine) motion \(motion) turn \(turn)")
        XCTAssertGreaterThanOrEqual(engine, 0.95); XCTAssertGreaterThanOrEqual(motion, 0.88); XCTAssertGreaterThanOrEqual(turn, 0.95)
        for state in ["off", "idle", "running", "revving"] { XCTAssertTrue(run.events.contains { $0.field == "engine" && $0.to == state }, "engine \(state)") }
        for state in ["launching", "accelerating", "cruising", "braking", "hardBraking", "coasting", "stopped"] { XCTAssertTrue(run.events.contains { $0.field == "motion" && $0.to == state }, "motion \(state)") }
        let corners = run.events.filter { $0.kind == .corner }
        for seg in truth { if let dir = seg["corner"] as? String { let t0 = (seg["t0"] as! NSNumber).doubleValue, t1 = (seg["t1"] as! NSNumber).doubleValue
            XCTAssertTrue(corners.contains { $0.dir == dir && $0.start! >= t0 - 1 && $0.start! <= t1 }, "corner \(dir) at \(t0)") } }
        XCTAssertTrue(run.snaps.contains { $0.cornerPhase == .entry } && run.snaps.contains { $0.cornerPhase == .apex } && run.snaps.contains { $0.cornerPhase == .exit })
        XCTAssertTrue(run.snaps.contains { $0.mount.status == .converged }, "mount converges on straight accelerations")
        // Lean is a bounded visual driver with the turn's sign (left positive).
        XCTAssertLessThanOrEqual(run.snaps.map { abs($0.leanEstimateDeg) }.max()!, VS.leanMaxDeg)
        for s in run.snaps where s.turn == .left && s.cornerPhase == .apex { XCTAssertGreaterThan(s.leanEstimateDeg, 0) }
        for s in run.snaps where s.turn == .right && s.cornerPhase == .apex { XCTAssertLessThan(s.leanEstimateDeg, 0) }
    }

    /// GPS outage: longitudinal falls back to the IMU (converged mount) with lower confidence; no turn without speed.
    func testGPSLossUsesIMUOnlyWithLowerConfidence() throws {
        let (replay, json) = try Self.synthetic()
        let run = Self.run(replay)
        let gap = try XCTUnwrap(((json["script"] as? [String: Any])?["gpsLost"] as? [[NSNumber]])?.first).map(\.doubleValue)
        let inside = run.snaps.filter { $0.t! > gap[0] + 3 && $0.t! < gap[1] }
        XCTAssertFalse(inside.isEmpty)
        for s in inside {
            XCTAssertNil(s.speedMps); XCTAssertEqual(s.longitudinalSource, "imu")
            XCTAssertLessThanOrEqual(s.motionConfidence, 0.35); XCTAssertEqual(s.turn, .none); XCTAssertEqual(s.engine, .running)
            XCTAssertNotEqual(s.motion, .stopped)
        }
    }

    /// Hysteresis + minimum duration: a steady acceleration just under the accelerate threshold, with GPS and IMU noise,
    /// settles instead of flickering between states.
    func testHysteresisPreventsFlicker() {
        for a in [0.045, -0.06, 0.06] {   // just below "accelerating" on, inside "coasting", just above "accelerating" on
            var estimator = VehicleStateEstimator(), rng = SeededRNG(20261023)
            let up = SIMD3<Double>(0, 0.7071, 0.7071)
            var v = 15.0
            for i in 0..<6000 {   // 120 s at 50 Hz
                let t = Double(i) * 0.02
                v = max(3, v + a * 9.80665 * 0.02)
                estimator.motion(t: t, userAcceleration: SIMD3(Double.random(in: -0.3...0.3, using: &rng), Double.random(in: -0.3...0.3, using: &rng), 0), gravity: -up, rotation: .zero)
                if i % 50 == 0 { estimator.gps(t: t, speed: v + Double.random(in: -0.2...0.2, using: &rng), accuracy: 0.4, horizontalAccuracy: 4) }
            }
            let changes = estimator.drainEvents().filter { $0.field == "motion" && $0.t > 10 }
            XCTAssertLessThanOrEqual(changes.count, 6, "a=\(a) g: ≥18 s average dwell: \(changes.map { "\($0.to!)@\(Int($0.t))" })")
        }
    }

    /// The suspected shift no longer fires on a timer: a 10-minute vibrating cruise produces none, with or without mic.
    func testSuspectedShiftDoesNotSaturate() throws {
        let (replay, _) = try Self.synthetic()
        for mic in [true, false] {
            let run = Self.run(replay, withMic: mic)
            let shifts = run.events.filter { $0.kind == .suspectedShift }
            XCTAssertTrue(shifts.allSatisfy { e in run.snaps.contains { abs($0.t! - e.t) < 0.11 && ($0.motion == .accelerating || $0.motion == .launching) } }, "only while accelerating")
            if mic { XCTAssertLessThanOrEqual(shifts.count, 6) } else { XCTAssertEqual(shifts.count, 0, "no microphone, no shift candidates") }
            let gaps = zip(shifts.dropFirst(), shifts).map { $0.t - $1.t }
            XCTAssertTrue(gaps.allSatisfy { $0 >= VS.shiftCooldownS })
        }
        var estimator = VehicleStateEstimator(), rng = SeededRNG(20261023)
        let up = SIMD3<Double>(0.22, 0.74, 0.64) / simd_length(SIMD3<Double>(0.22, 0.74, 0.64))
        for i in 0..<30000 {   // 600 s cruise at 80 km/h: heavy vibration, 1.7 Hz wobble, mic at wind level
            let t = Double(i) * 0.02, n = { Double.random(in: -1...1, using: &rng) }
            estimator.motion(t: t, userAcceleration: SIMD3(n(), n(), n()) * 0.5, gravity: -up, rotation: up * 0.3 * sin(2 * .pi * 1.7 * t) + SIMD3(n(), n(), n()) * 0.2)
            if i % 50 == 0 { estimator.gps(t: t, speed: 22.2 + 0.15 * n(), accuracy: 0.4, horizontalAccuracy: 4) }
            if i % 2 == 0 { estimator.acoustic(t: t, rmsDbfs: -11 + 1.2 * n()) }
        }
        let events = estimator.drainEvents()
        XCTAssertEqual(events.filter { $0.kind == .suspectedShift }.count, 0, "constant-speed cruise: never a shift")
        XCTAssertEqual(events.filter { $0.kind == .corner }.count, 0, "1.7 Hz wobble is not a turn")
    }

    /// Real ride (only when MOTUO_REPLAY_FIXTURE points at a local file; never copied into the repo).
    func testRealReplayFixtureMetrics() throws {
        guard let path = ProcessInfo.processInfo.environment["MOTUO_REPLAY_FIXTURE"], FileManager.default.fileExists(atPath: path) else {
            throw XCTSkip("MOTUO_REPLAY_FIXTURE 未设置或文件不存在：跳过真实回放")
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let run = Self.run(try VehicleReplay(data: data), simulated: false)
        let notes = json["groundTruthNotes"] as? [String: Any] ?? [:]
        let text = notes["corners_from_desk_analysis"] as? String ?? ""
        let list = text.split(separator: "：").last.map { String($0).split(separator: "s").first.map(String.init) ?? "" } ?? ""
        let reference = list.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        var corners = run.events.filter { $0.kind == .corner }, matched = 0
        for r in reference { if let i = corners.indices.filter({ r >= corners[$0].start! - 3 && r <= corners[$0].end! + 1.5 }).min(by: { abs(r - corners[$0].start!) < abs(r - corners[$1].start!) }) { matched += 1; corners.remove(at: i) } }
        let stops = (notes["stops_s"] as? [[NSNumber]] ?? []).map { ($0[0].doubleValue + 1, $0[1].doubleValue - 1) }
        let inStop = { (t: Double) in stops.contains { t >= $0.0 && t < $0.1 } }
        let falseActive = run.snaps.filter { inStop($0.t!) && ($0.motion != .stopped || $0.turn != .none) }.count
        let red = (notes["red_light_idle_s"] as? [NSNumber])?.map(\.doubleValue) ?? [350, 396]
        let redSnaps = run.snaps.filter { $0.t! >= red[0] + 3 && $0.t! < red[1] - 3 }
        let idle = Double(redSnaps.filter { $0.engine == .idle || $0.engine == .revving }.count) / Double(max(1, redSnaps.count))
        let early = run.snaps.filter { $0.t! < 100 }, off = Double(early.filter { $0.engine == .off }.count) / Double(max(1, early.count))
        let hw = (notes["highway_segment_s"] as? [NSNumber])?.map(\.doubleValue) ?? [190, 350]
        let hwSnaps = run.snaps.filter { $0.t! >= hw[0] + 3 && $0.t! < hw[1] - 5 }
        let none = Double(hwSnaps.filter { $0.turn == .none }.count) / Double(max(1, hwSnaps.count))
        let shifts = run.events.filter { $0.kind == .suspectedShift }.count
        let summary = "真实回放：参考弯 \(matched)/\(reference.count)，检测弯 \(run.events.filter { $0.kind == .corner }.count)，静止段误报快照 \(falseActive)，红灯 idle \(Int(idle * 1000) / 10)%，0–100 s off \(Int(off * 1000) / 10)%，高速 turn=none \(Int(none * 1000) / 10)%，疑似换挡 \(shifts)"
        print(summary); XCTContext.runActivity(named: summary) { _ in }
        XCTAssertGreaterThanOrEqual(matched, 9); XCTAssertEqual(falseActive, 0); XCTAssertGreaterThanOrEqual(idle, 0.95)
        XCTAssertGreaterThanOrEqual(none, 0.85); XCTAssertLessThan(shifts, 30, "not saturating (old rule: every 12 s)")
    }
}

/// D5: the real ride lost ≈288 MB of free space while its package was 4 MB. This measures what the app itself writes per
/// ride hour (legacy TelemetryJournal at 50 Hz + a 100 Hz roadlog) and how the app container's folders change, so a
/// device-side drop of that size can be attributed (or not) to the app.
@MainActor final class RideStorageBudgetTests: XCTestCase {
    static func size(_ url: URL) -> Int {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey]) else { return 0 }
        var total = 0
        for case let f as URL in e { let v = try? f.resourceValues(forKeys: [.totalFileAllocatedSizeKey, .isRegularFileKey]); if v?.isRegularFile == true { total += v?.totalFileAllocatedSize ?? 0 } }
        return total
    }
    func testAppWritesPerRideHourAndContainerFolders() async throws {
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let folders = ["Documents", "Library/Application Support", "Library/Caches", "Library/WebKit", "Library/Preferences", "tmp"]
        let before = Dictionary(uniqueKeysWithValues: folders.map { ($0, Self.size(home.appendingPathComponent($0))) })
        // 10 simulated minutes: journal (motion 50 Hz + location 1 Hz) and roadlog (motion/accel/gyro 100 Hz, mag 50 Hz, location, acoustic 47 Hz).
        let rideId = UUID(), root = home.appendingPathComponent("tmp/budget-" + rideId.uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let journal = try TelemetryJournal(rideId: rideId, root: root.appendingPathComponent("Rides"))
        let start = Date(), seg = UUID().uuidString
        for i in 0..<30_000 {
            let t = Double(i) / 50
            journal.append(.init(timestamp: start.addingTimeInterval(t), monotonicS: t, source: "measured", stream: "motion", segmentId: seg,
                                 accelerationX: 0.123456, accelerationY: -0.234567, accelerationZ: 0.345678, rotationX: 0.01234, rotationY: -0.02345, rotationZ: 0.03456, quality: "valid", calibrationId: seg))
            if i % 50 == 0 { journal.append(.init(timestamp: start.addingTimeInterval(t), monotonicS: t, source: "measured", stream: "location", segmentId: seg, speedMPS: 12.3, latitude: 31.2, longitude: 121.4, horizontalAccuracyM: 4, speedAccuracyMPS: 0.4, quality: "valid", calibrationId: seg)) }
        }
        try journal.flush()
        let recorder = RoadlogRecorder(root: root.appendingPathComponent("Roadlog")); recorder.freeBytes = { 50 << 30 }
        XCTAssertTrue(recorder.begin(.init(rideId: rideId, simulated: true)))
        let sink = try XCTUnwrap(recorder.sink), name = try XCTUnwrap(recorder.packageId), base = sink.mapping.mono
        var phase = 0.0
        for i in 0..<60_000 {
            let t = base + Double(i) / 100, s = sin(Double(i) / 37)
            sink.feed("motion", [t, 0.01 * s, -0.02, 0.03, 0.1, -0.7, -0.6, 0.1 * s, 0.2, 0.3, 0.9, 0.1, 0.2, 0.3, 20, -5, 40, 2, 180])
            sink.feed("accel_raw", [t, 0.1 * s, -0.7, -0.6]); sink.feed("gyro_raw", [t, 0.1 * s, 0.2, 0.3])
            if i % 2 == 0 { sink.feed("mag_raw", [t, 20, -5, 40]) }
            if i % 10 == 0 { sink.feed("vehicle_state", [t, 3, 3, 0.01, 0, 0, 0, 0.5, 0.1, 0, 20, 2, 0.8, 0.9, 0.8, 0, 0.3, -12]) }
            if i % 100 == 0 { sink.feed("location", [t, sink.mapping.unix(forMono: t), 31.2, 121.4, 12, 15, 4, 3, 20, 0.4, 90, 5, nil, 0, 0]) }
            if i % 2 == 0 { var frame = [Float](repeating: 0, count: 1024); for n in 0..<1024 { phase += 0.013; frame[n] = Float(0.2 * sin(phase)) }; sink.audio.receive(frame, sampleRate: 48000, endUptime: t) }
        }
        recorder.finish(); await recorder.waitForSeal(name)
        let journalBytes = Self.size(root.appendingPathComponent("Rides")), roadlogBytes = Self.size(root.appendingPathComponent("Roadlog"))
        let after = Dictionary(uniqueKeysWithValues: folders.map { ($0, Self.size(home.appendingPathComponent($0))) })
        let delta = folders.map { "\($0) \((after[$0]! - before[$0]!) / 1000) kB" }.joined(separator: "，")
        let summary = "D5 每骑行小时写入：旧遥测 \(journalBytes * 6 / 1_000_000) MB/h，路谱 \(roadlogBytes * 6 / 1_000_000) MB/h；10 分钟容器变化：\(delta)"
        print(summary); XCTContext.runActivity(named: summary) { _ in }
        XCTAssertLessThan((journalBytes + roadlogBytes) * 6, 200_000_000, "the app writes well under 200 MB per ride hour")
        XCTAssertLessThan(journalBytes + roadlogBytes, 40_000_000, "10 minutes ≪ 288 MB")
    }
}
