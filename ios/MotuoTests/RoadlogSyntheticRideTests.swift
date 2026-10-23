import XCTest
import CoreLocation
@testable import Motuo

/// Synthetic rides through the real recorder → sink → writer pipeline (provenance "simulated"; never uploaded).
/// ROADLOG_EXPORT_DIR (pass TEST_RUNNER_ROADLOG_EXPORT_DIR to xcodebuild) keeps the package and a report on the Mac.
@MainActor final class RoadlogSyntheticRideTests: XCTestCase {
    private var exportDir: URL? { ProcessInfo.processInfo.environment["ROADLOG_EXPORT_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) } }
    private static func cpuSeconds() -> Double { var t = timespec(); clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &t); return Double(t.tv_sec) + Double(t.tv_nsec) / 1e9 }
    private struct Noise { var state: UInt64 = 0x9E3779B97F4A7C15
        mutating func next() -> Double { state ^= state << 13; state ^= state >> 7; state ^= state << 17; return Double(state % 2_000_001) / 1_000_000 - 1 }
    }
    /// km/h along a 10-minute urban/suburban profile (stop, launch, cruise, brake).
    static func speedKmh(_ t: Double) -> Double {
        let cycle = t.truncatingRemainder(dividingBy: 150)
        if cycle < 10 { return 0 }
        if cycle < 30 { return (cycle - 10) * 3 }
        if cycle < 120 { return 60 + 8 * sin(cycle / 9) }
        return max(0, 60 * (1 - (cycle - 120) / 30))
    }

    /// Generates 600 s of every stream at its target rate. `sink == nil` measures generation cost only.
    private func generate(_ sink: RoadlogSink?, base: RoadlogClockMapping, seconds: Int = 600) {
        var noise = Noise(), lat = 31.2304, lon = 121.4737, phase = 0.0
        let audioRate = 48000.0, frame = RoadlogAudioProcessor.frameSize
        var audioClock = 0.0
        for second in 0..<seconds {
            let s = Double(second)
            if second % 10 == 0 { sink?.updateMapping(.init(mono: base.mono + s, unix: base.unix + s), reason: "periodic"); sink?.writer.drain() }   // bound the queue backlog
            for i in 0..<100 {
                let t = base.mono + s + Double(i) / 100, vib = 0.04 * sin(t * 2 * .pi * 37)
                let row: [Double?] = [t, noise.next() * 0.03 + vib, noise.next() * 0.03 + 0.05 * sin(t / 3), noise.next() * 0.03 + vib,
                    0.02 * noise.next(), -0.99 + 0.005 * noise.next(), -0.1 + 0.01 * noise.next(),
                    noise.next() * 0.05, noise.next() * 0.05, 0.1 * sin(t / 4) + noise.next() * 0.02,
                    0.99 + 0.001 * noise.next(), 0.01 * noise.next(), 0.02 * noise.next(), 0.1 * sin(t / 20),
                    22 + noise.next(), -3 + noise.next(), -40 + noise.next(), 2, (t * 3).truncatingRemainder(dividingBy: 360)]
                sink?.feed("motion", row)
                sink?.feed("accel_raw", [t, noise.next() * 0.03 + vib, -1 + noise.next() * 0.03, noise.next() * 0.03])
                sink?.feed("gyro_raw", [t, 0.005 + noise.next() * 0.05, -0.003 + noise.next() * 0.05, noise.next() * 0.05])
                if i % 2 == 0 { sink?.feed("mag_raw", [t, 180 + noise.next() * 2, -60 + noise.next() * 2, -300 + noise.next() * 2]) }
                if i % 20 == 0 { sink?.feed("heading", [t, base.unix + (t - base.mono), (t * 3).truncatingRemainder(dividingBy: 360), nil, 15, 20 + noise.next(), -5 + noise.next(), -40 + noise.next()]) }
                if i % 10 == 0, Self.speedKmh(s) > 0, second % 75 > 70 { sink?.feed("inferred_imu_speed", [t, Self.speedKmh(s) / 3.6, 0.8, Double(second % 75 - 70)]) }
            }
            let kmh = Self.speedKmh(s)
            sink?.feed("altimeter", [base.mono + s + 0.3, 3 * sin(s / 60) + 0.05 * noise.next(), 101.2 - 0.036 * sin(s / 60)])
            sink?.feed("abs_altitude", [base.mono + s + 0.5, 12 + 3 * sin(s / 60), 4, 0.5])
            sink?.feed("inferred_signal", [base.mono + s + 0.7, kmh > 0 && kmh < 60 ? 1 : 0, 0.2 * sin(s / 7), min(1, kmh / 100), 0.1])
            if !(300..<310).contains(second) {           // a 10 s tunnel without GPS
                lat += kmh / 3.6 / 111_320 * 0.8; lon += kmh / 3.6 / 95_000 * 0.6
                let fix = CLLocation(coordinate: .init(latitude: lat, longitude: lon), altitude: 12 + 3 * sin(s / 60), horizontalAccuracy: 4 + abs(noise.next()),
                                     verticalAccuracy: 6, course: 37, courseAccuracy: 5, speed: kmh / 3.6, speedAccuracy: 0.5,
                                     timestamp: Date(timeIntervalSince1970: base.unix + s + 0.95))
                sink?.location(fix)
            }
            if second % 30 == 0 { sink?.writer.log(.device, ["type": "device", "source": "measured", "reason": "periodic", "t_mono": base.mono + s, "battery_level": 0.8 - s / 6000, "thermal_state": "nominal", "app_state": "active"]) }
            if second % 75 == 20 { sink?.event("signal_event", source: "inferred", t: base.mono + s, ["kind": "suspectedShift", "confidence": 0.45]) }
            // ~47 acoustic frames/s from a synthetic engine-like tone (harmonics + noise) through the real FFT path.
            let f0 = 30 + kmh * 1.2
            while audioClock < s + 1 {
                var samples = [Float](repeating: 0, count: frame)
                for n in 0..<frame { phase += 2 * .pi * f0 / audioRate
                    samples[n] = Float(0.2 * sin(phase) + 0.1 * sin(2 * phase) + 0.05 * sin(3.5 * phase) + 0.02 * noise.next()) }
                audioClock += Double(frame) / audioRate
                sink?.audio.receive(samples, sampleRate: audioRate, endUptime: base.mono + audioClock)
            }
        }
    }

    func testTenMinuteSyntheticRideProducesVerifiedPackage() async throws {
        let root = exportDir ?? FileManager.default.temporaryDirectory.appendingPathComponent("roadlog-synth-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { if exportDir == nil { try? FileManager.default.removeItem(at: root) } }
        let recorder = RoadlogRecorder(root: root); recorder.freeBytes = { 50 << 30 }
        let base = RoadlogClockMapping.now()   // synthetic samples run ahead of the real clock but share its mapping
        var cpu = Self.cpuSeconds(), wall = Date()
        generate(nil, base: base)
        let generationCPU = Self.cpuSeconds() - cpu, generationWall = Date().timeIntervalSince(wall)
        let rideId = UUID()
        XCTAssertTrue(recorder.begin(.init(rideId: rideId, startedAt: Date(timeIntervalSince1970: base.unix), simulated: true, vehicle: ["model": "GSX250R", "make": "Suzuki", "odometerKM": 12_345], calibration: nil, rawAudio: false)))
        let sink = try XCTUnwrap(recorder.sink), name = try XCTUnwrap(recorder.packageId)
        sink.updateMapping(base, reason: "start")
        cpu = Self.cpuSeconds(); wall = Date()
        generate(sink, base: base)
        sink.updateMapping(.init(mono: base.mono + 600, unix: base.unix + 600), reason: "end")
        recorder.finish(); await recorder.waitForSeal(name)
        let totalCPU = Self.cpuSeconds() - cpu, totalWall = Date().timeIntervalSince(wall)
        let directory = root.appendingPathComponent(name)
        XCTAssertEqual(RoadlogVerifier.problems(directory), [])
        let manifest = RoadlogJSON.object(try Data(contentsOf: directory.appendingPathComponent("manifest.json")))!
        let streams = manifest["streams"] as! [String: [String: Any]]
        XCTAssertEqual(manifest["simulated"] as? Bool, true)
        XCTAssertEqual(streams["motion"]!["rows"] as? Int, 60_000)
        XCTAssertEqual(streams["motion"]!["measuredHz"] as! Double, 100, accuracy: 0.1)
        XCTAssertEqual(streams["location"]!["rows"] as? Int, 590)
        XCTAssertGreaterThan(streams["acoustic"]!["measuredHz"] as! Double, 40)
        XCTAssertTrue((manifest["gaps"] as! [[String: Any]]).contains { $0["stream"] as? String == "location" && $0["reason"] as? String == "gps_lost" })
        XCTAssertGreaterThanOrEqual((streams["motion"]!["chunks"] as! [Any]).count, 10)
        let volume = manifest["dataVolume"] as! [String: Any]
        var perStream: [String: Any] = [:]
        for (key, value) in streams where (value["rows"] as? Int ?? 0) > 0 {
            let chunks = value["chunks"] as! [[String: Any]]
            perStream[key] = ["rows": value["rows"]!, "measuredHz": value["measuredHz"]!, "bytes": chunks.reduce(0) { $0 + ($1["bytes"] as! Int) },
                              "uncompressedBytes": chunks.reduce(0) { $0 + ($1["uncompressed_bytes"] as! Int) }]
        }
        let report: [String: Any] = ["packageId": name, "simulatedSeconds": 600, "totalBytes": volume["totalBytes"]!, "uncompressedBytes": volume["uncompressedBytes"]!,
            "bytesPerHourEstimate": volume["bytesPerHourEstimate"]!, "streams": perStream,
            "cpu": ["generationOnlyCPU_s": generationCPU, "generationOnlyWall_s": generationWall, "pipelineIncludingGenerationCPU_s": totalCPU,
                    "pipelineIncludingGenerationWall_s": totalWall, "writerAndFeaturesCPU_s": totalCPU - generationCPU,
                    "writerCPUPerRideHour_s": (totalCPU - generationCPU) * 6,
                    "note": "合成 600 s 数据以快于实时的速度灌入；writer CPU ≈ 管线总 CPU − 单独生成数据的 CPU（模拟器，Mac CPU）"],
            "device": RoadlogRecorder.hardwareModel()]
        print("ROADLOG_SYNTHETIC_REPORT " + String(decoding: try RoadlogJSON.data(report, pretty: false), as: UTF8.self))
        if let exportDir { try RoadlogJSON.data(report).write(to: exportDir.appendingPathComponent("synthetic-ride-report.json")) }
    }

    /// 60 s at real-time pacing (100 Hz timer) to measure CPU share and main-thread latency. Opt-in: ROADLOG_REALTIME=1.
    func testRealtimeSixtySecondsCPUAndMainThreadLatency() throws {
        guard ProcessInfo.processInfo.environment["ROADLOG_REALTIME"] == "1" else { throw XCTSkip("set ROADLOG_REALTIME=1 (TEST_RUNNER_ROADLOG_REALTIME) to run the 60 s real-time measurement") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("roadlog-rt-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let recorder = RoadlogRecorder(root: root); recorder.freeBytes = { 50 << 30 }
        XCTAssertTrue(recorder.begin(.init(rideId: UUID(), simulated: true)))
        let sink = try XCTUnwrap(recorder.sink), name = try XCTUnwrap(recorder.packageId)
        let feedQueue = DispatchQueue(label: "rt.feed", qos: .userInitiated)
        let timer = DispatchSource.makeTimerSource(queue: feedQueue)
        var ticks = 0, noise = Noise(), phase = 0.0
        timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(1))
        timer.setEventHandler {
            ticks += 1
            let t = ProcessInfo.processInfo.systemUptime
            sink.feed("motion", [t, noise.next(), noise.next(), noise.next(), 0, -1, 0, noise.next(), noise.next(), noise.next(), 1, 0, 0, 0, 20, -3, -40, 2, 10])
            sink.feed("accel_raw", [t, noise.next(), -1, noise.next()]); sink.feed("gyro_raw", [t, noise.next(), noise.next(), noise.next()])
            if ticks % 2 == 0 { sink.feed("mag_raw", [t, 180, -60, -300 + noise.next()]) }
            if ticks % 2 == 0 {   // 50 Hz × 1024 samples ≈ a 48 kHz microphone tap
                let samples = (0..<1024).map { _ in phase += 0.01; return Float(0.2 * sin(phase) + 0.02 * noise.next()) }
                sink.audio.receive(samples, sampleRate: 51200, endUptime: t)
            }
            if ticks % 100 == 0 { sink.location(CLLocation(coordinate: .init(latitude: 31.23, longitude: 121.47), altitude: 10, horizontalAccuracy: 5, verticalAccuracy: 5, course: 10, courseAccuracy: 5, speed: 10, speedAccuracy: 0.5, timestamp: Date())) }
        }
        var maxLateness = 0.0, last = CACurrentMediaTime()
        let probe = Timer(timeInterval: 0.02, repeats: true) { _ in let now = CACurrentMediaTime(); maxLateness = max(maxLateness, now - last - 0.02); last = now }
        RunLoop.main.add(probe, forMode: .common)
        let cpu0 = Self.cpuSeconds(), wall0 = Date()
        timer.resume()
        let done = expectation(description: "60 s"); DispatchQueue.main.asyncAfter(deadline: .now() + 60) { done.fulfill() }
        wait(for: [done], timeout: 70)
        timer.cancel(); probe.invalidate()
        let cpu = Self.cpuSeconds() - cpu0, wall = Date().timeIntervalSince(wall0)
        let sealed = expectation(description: "seal")
        recorder.finish(); Task { await recorder.waitForSeal(name); sealed.fulfill() }
        wait(for: [sealed], timeout: 30)
        let manifest = RoadlogJSON.object(try Data(contentsOf: root.appendingPathComponent(name).appendingPathComponent("manifest.json")))!
        let motion = (manifest["streams"] as! [String: [String: Any]])["motion"]!
        let report: [String: Any] = ["wall_s": wall, "processCPU_s": cpu, "processCPUPercentOfOneCore": cpu / wall * 100, "mainThreadMaxLatency_ms": maxLateness * 1000,
                                     "motionMeasuredHz": motion["measuredHz"]!, "motionRows": motion["rows"]!, "totalBytes": (manifest["dataVolume"] as! [String: Any])["totalBytes"]!,
                                     "note": "模拟器（Mac CPU）；包含合成数据生成与特征计算，真机需另测"]
        print("ROADLOG_REALTIME_REPORT " + String(decoding: try RoadlogJSON.data(report, pretty: false), as: UTF8.self))
        if let exportDir { try RoadlogJSON.data(report).write(to: exportDir.appendingPathComponent("realtime-60s-report.json")) }
        XCTAssertLessThan(maxLateness, 0.1, "main thread stays responsive")
        XCTAssertEqual(motion["measuredHz"] as! Double, 100, accuracy: 5)
    }
}
