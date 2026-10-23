import XCTest
import CoreLocation
import SwiftData
@testable import Motuo

private func tempRoot() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("roadlog-" + UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
private func session(_ id: UUID = UUID(), simulated: Bool = true) -> [String: Any] {
    ["rideId": id.uuidString, "provenance": simulated ? "simulated" : "measured", "app": ["version": "test"], "device": ["model": "test"],
     "settings": ["rawAudioEnabled": false, "requestedRatesHz": ["motion": 100]]]
}
private func motionRow(_ t: Double) -> [Double?] {
    [t, 0.01, -0.02, 0.03, 0, -1, 0, 0.1, 0.2, 0.3, 1, 0, 0, 0, nil, nil, nil, -1, nil]
}
private func csv(_ directory: URL, _ chunk: [String: Any]) throws -> [String] {
    let data = try RoadlogGzip.decompress(Data(contentsOf: directory.appendingPathComponent(chunk["file"] as! String)))
    return String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
}
private func streams(_ manifest: [String: Any]) -> [String: [String: Any]] { manifest["streams"] as! [String: [String: Any]] }

final class RoadlogFormatTests: XCTestCase {
    func testGzipIsAStandardMemberAndRoundTrips() throws {
        let text = Data(("t_mono,x\n" + (0..<5000).map { "\($0).000000,\(Double($0) * 0.001)" }.joined(separator: "\n") + "\n").utf8)
        let gz = try RoadlogGzip.compress(text)
        XCTAssertEqual(Array(gz.prefix(3)), [0x1f, 0x8b, 0x08], "gzip magic + deflate")
        XCTAssertLessThan(gz.count, text.count / 3)
        XCTAssertEqual(try RoadlogGzip.decompress(gz), text)
        // ISIZE trailer = uncompressed length mod 2^32 (what Python's gzip checks)
        let size = gz.suffix(4).enumerated().reduce(0) { $0 | Int($1.element) << (8 * $1.offset) }
        XCTAssertEqual(size, text.count)
    }
    func testCSVKeepsMissingValuesEmptyAndUsesPlainDecimals() {
        let columns = RoadlogStreams.location.columns
        let line = RoadlogCSV.row([12.5, 1_790_000_000.25, 31.23045678, 121.47371234, nil, nil, 5, nil, 0, nil, nil, nil, nil, 0, 1], columns: columns)
        XCTAssertEqual(line, "12.500000,1790000000.250000,31.23045678,121.47371234,,,5,,0,,,,,0,1\n")
        XCTAssertEqual(RoadlogCSV.compact(0.000012345), "0.000012345")
        XCTAssertEqual(RoadlogCSV.compact(-9.80665), "-9.80665")
        XCTAssertEqual(RoadlogStreams.all.map(\.name).count, Set(RoadlogStreams.all.map(\.name)).count)
        for spec in RoadlogStreams.all { XCTAssertEqual(spec.columns.first?.name, "t_mono", spec.name) }
    }
    func testClockMappingConvertsWallClockBothWays() {
        let map = RoadlogClockMapping(mono: 100, unix: 1_790_000_000)
        XCTAssertEqual(map.mono(forUnix: 1_790_000_005.5), 105.5, accuracy: 1e-9)
        XCTAssertEqual(map.unix(forMono: 90), 1_789_999_990, accuracy: 1e-9)
        XCTAssertEqual(Roadlog.packageName(start: Date(timeIntervalSince1970: 1_792_658_130), rideId: UUID(uuidString: "6C3B0D7E-3C11-4D0A-9F59-0D1C4C6A1E01")!),
                       "2026-10-22T08-35-30Z_6C3B0D7E-3C11-4D0A-9F59-0D1C4C6A1E01")
    }
    func testDecimatorKeepsLegacyFiftyHertzFromHundredHertzFeed() {
        let legacy = MotionDecimator(sourceHz: 100, targetHz: 50)
        var t = 1000.0, accepted = 0
        for i in 0..<1000 { t += 0.01 + (i % 3 == 0 ? 0.0004 : -0.0002); if legacy.accept(t) { accepted += 1 } }
        XCTAssertEqual(accepted, 500, accuracy: 1)
        let passthrough = MotionDecimator(sourceHz: 50, targetHz: 50)
        XCTAssertEqual((0..<100).filter { passthrough.accept(Double($0) * 0.02) }.count, 100)
    }
    func testAcousticFeaturesMatchAFullScaleSine() throws {
        let root = tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let writer = try RoadlogPackageWriter(root: root, session: session(), packageId: "a", mapping: .init(mono: 0, unix: 0))
        let processor = RoadlogAudioProcessor(writer: writer, rawAudio: false)
        let frame = (0..<1024).map { Float(sin(2 * Double.pi * 1000 * Double($0) / 48000)) }
        let row = processor.features(frame, sampleRate: 48000, t: 1)
        XCTAssertEqual(row.count, RoadlogStreams.acoustic.columns.count)
        XCTAssertEqual(row[1]!, -3.01, accuracy: 0.1)          // RMS of a unit sine
        XCTAssertEqual(row[2]!, 0, accuracy: 0.05)              // peak
        let bands = row[4...].map { $0 ?? -200 }
        let edges = RoadlogStreams.acousticBandEdgesHz
        let expected = (0..<16).first { edges[$0] <= 1000 && 1000 < edges[$0 + 1] }!
        XCTAssertEqual(bands.firstIndex(of: bands.max()!), expected)
        XCTAssertEqual(bands[expected], -3, accuracy: 1.5)
    }
}

final class RoadlogWriterTests: XCTestCase {
    func testChunksBySpanSealsWithChecksumsAndCompleteManifest() throws {
        let root = tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let writer = try RoadlogPackageWriter(root: root, session: session(), packageId: "p", mapping: .init(mono: 0, unix: 1_790_000_000))
        XCTAssertEqual(RoadlogManifestBuilder.status(of: writer.directory), "recording")
        for i in 0...1500 { writer.append("motion", motionRow(Double(i) * 0.1)) }   // 150 s at 10 Hz
        writer.log(.events, ["type": "ride_start", "t_mono": 0.0])
        let manifest = try writer.seal(end: .init(mono: 150, unix: 1_790_000_150))
        let motion = streams(manifest)["motion"]!
        let chunks = motion["chunks"] as! [[String: Any]]
        XCTAssertEqual(chunks.count, 3)
        XCTAssertEqual(chunks.map { $0["rows"] as! Int }.reduce(0, +), 1501)
        XCTAssertEqual(motion["rows"] as? Int, 1501)
        XCTAssertEqual(motion["measuredHz"] as! Double, 10, accuracy: 0.001)
        XCTAssertEqual(motion["status"] as? String, "recorded")
        XCTAssertEqual(motion["source"] as? String, "simulated")
        for chunk in chunks {
            let data = try Data(contentsOf: writer.directory.appendingPathComponent(chunk["file"] as! String))
            XCTAssertEqual(Roadlog.sha256(data), chunk["sha256"] as? String); XCTAssertEqual(data.count, chunk["bytes"] as? Int)
            XCTAssertLessThanOrEqual((chunk["t_end"] as! Double) - (chunk["t_start"] as! Double), 60)
        }
        let lines = try csv(writer.directory, chunks[0])
        XCTAssertEqual(lines[0], RoadlogStreams.motion.header)
        XCTAssertEqual(lines[1], "0.000000,0.01,-0.02,0.03,0,-1,0,0.1,0.2,0.3,1,0,0,0,,,,-1,")
        for key in ["schema", "schemaVersion", "packageId", "rideId", "status", "provenance", "simulated", "startedAtUTC", "endedAtUTC", "durationS",
                    "clock", "app", "device", "vehicle", "settings", "calibration", "capabilities", "streams", "files", "audio", "gaps",
                    "degradations", "integrity", "manifestRebuilt", "dataVolume"] { XCTAssertNotNil(manifest[key], key) }
        XCTAssertEqual(manifest["status"] as? String, "sealed"); XCTAssertEqual(manifest["durationS"] as! Double, 150, accuracy: 1e-6)
        XCTAssertEqual(Set(streams(manifest).keys), Set(RoadlogStreams.all.map(\.name)))
        XCTAssertEqual(streams(manifest)["location"]?["status"] as? String, "unavailable")
        XCTAssertEqual((manifest["integrity"] as! [String: Any])["problems"] as! [String], [])
        XCTAssertEqual(RoadlogVerifier.problems(writer.directory), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: writer.directory.appendingPathComponent("streams/motion/000003.csv.part").path))
    }
    func testChunkByteLimitAndGapAndPauseRecording() throws {
        let root = tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let writer = try RoadlogPackageWriter(root: root, session: session(), packageId: "b", mapping: .init(mono: 0, unix: 0), chunkLimit: 4096)
        for i in 0..<200 { writer.append("accel_raw", [Double(i) * 0.01, 0.1, 0.2, 0.3]) }
        writer.append("accel_raw", [5.0, 0, 0, 1])                        // 3 s stall → gap
        writer.append("accel_raw", [4.0, 0, 0, 1])                        // older sample dropped, never reordered
        writer.pause(t: 6); writer.resume(t: 20)
        writer.append("accel_raw", [20.0, 0, 0, 1])                       // after pause: no stall gap, a "paused" gap instead
        let manifest = try writer.seal(end: .init(mono: 21, unix: 21))
        let accel = streams(manifest)["accel_raw"]!
        XCTAssertGreaterThan((accel["chunks"] as! [Any]).count, 1)
        XCTAssertEqual(accel["rows"] as? Int, 202)
        let gaps = manifest["gaps"] as! [[String: Any]]
        XCTAssertEqual(gaps.map { $0["reason"] as! String }, ["sensor_stall", "paused"])
        XCTAssertEqual(gaps[0]["tStart"] as! Double, 1.99, accuracy: 1e-9)
    }
    func testRecoveryTruncatesHalfLinesSealsPartsAndRebuildsManifest() throws {
        let root = tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
        var writer: RoadlogPackageWriter? = try RoadlogPackageWriter(root: root, session: session(), packageId: "c", mapping: .init(mono: 0, unix: 1_790_000_000))
        for i in 0..<700 { writer!.append("motion", motionRow(Double(i) * 0.1)) }   // 70 s: one sealed chunk + an open part
        writer!.log(.events, ["type": "ride_start", "t_mono": 0.0])
        writer!.drain()
        let directory = writer!.directory
        writer = nil   // the process "dies" here: no seal
        let part = directory.appendingPathComponent("streams/motion/000002.csv.part")
        XCTAssertTrue(FileManager.default.fileExists(atPath: part.path))
        let handle = try FileHandle(forWritingTo: part); try handle.seekToEnd(); try handle.write(contentsOf: Data("69.912345,0.0".utf8)); try handle.close()
        let events = try FileHandle(forWritingTo: directory.appendingPathComponent("events.jsonl")); try events.seekToEnd(); try events.write(contentsOf: Data("{\"type\":\"trunc".utf8)); try events.close()
        try FileManager.default.removeItem(at: directory.appendingPathComponent("manifest.json"))

        XCTAssertTrue(try RoadlogRecovery.recoverIfNeeded(directory))
        XCTAssertFalse(try RoadlogRecovery.recoverIfNeeded(directory), "idempotent")
        let manifest = RoadlogJSON.object(try Data(contentsOf: directory.appendingPathComponent("manifest.json")))!
        XCTAssertEqual(manifest["status"] as? String, "recovered"); XCTAssertEqual(manifest["manifestRebuilt"] as? Bool, true)
        let chunks = streams(manifest)["motion"]!["chunks"] as! [[String: Any]]
        XCTAssertEqual(chunks.count, 2); XCTAssertEqual(chunks[1]["recovered"] as? Bool, true)
        XCTAssertEqual(streams(manifest)["motion"]!["rows"] as? Int, 700, "half line dropped, complete rows kept")
        XCTAssertEqual(try csv(directory, chunks[1]).last, "69.900000,0.01,-0.02,0.03,0,-1,0,0.1,0.2,0.3,1,0,0,0,,,,-1,")
        let types = RoadlogJSON.lines(directory.appendingPathComponent("events.jsonl")).map { $0["type"] as? String }
        XCTAssertEqual(types, ["ride_start", "recovered_after_termination"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path))
        XCTAssertEqual(RoadlogVerifier.problems(directory), [])
    }
    func testRecoveryPrefersPartWhenSealWasInterruptedBeforeIndexLine() throws {
        let root = tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
        var writer: RoadlogPackageWriter? = try RoadlogPackageWriter(root: root, session: session(), packageId: "d", mapping: .init(mono: 0, unix: 0))
        for i in 0..<10 { writer!.append("gyro_raw", [Double(i) * 0.01, 1, 2, 3]) }
        writer!.drain(); let directory = writer!.directory; writer = nil
        try Data("garbage".utf8).write(to: directory.appendingPathComponent("streams/gyro_raw/000001.csv.gz"))   // orphan, no index line
        XCTAssertTrue(try RoadlogRecovery.recoverIfNeeded(directory))
        let manifest = RoadlogJSON.object(try Data(contentsOf: directory.appendingPathComponent("manifest.json")))!
        XCTAssertEqual(streams(manifest)["gyro_raw"]!["rows"] as? Int, 10)
        XCTAssertEqual(RoadlogVerifier.problems(directory), [])
    }
}

@MainActor final class RoadlogRecorderTests: XCTestCase {
    func testLocationRowsUseClockMappingAndKeepInvalidFieldsEmpty() async throws {
        let root = tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let recorder = RoadlogRecorder(root: root); recorder.freeBytes = { 50 << 30 }
        XCTAssertTrue(recorder.begin(.init(rideId: UUID(), simulated: true)))
        let sink = try XCTUnwrap(recorder.sink), name = try XCTUnwrap(recorder.packageId)
        let mapping = RoadlogClockMapping(mono: 500, unix: 1_790_000_000)
        sink.updateMapping(mapping, reason: "test")
        let fix = CLLocation(coordinate: .init(latitude: 31.2304, longitude: 121.4737), altitude: 12, horizontalAccuracy: 4.5, verticalAccuracy: -1,
                             course: -1, courseAccuracy: -1, speed: 8.25, speedAccuracy: 0.6, timestamp: Date(timeIntervalSince1970: 1_790_000_002.5))
        sink.location(fix)
        recorder.finish(); await recorder.waitForSeal(name)
        let directory = root.appendingPathComponent(name)
        let manifest = RoadlogJSON.object(try Data(contentsOf: directory.appendingPathComponent("manifest.json")))!
        let chunk = (streams(manifest)["location"]!["chunks"] as! [[String: Any]])[0]
        XCTAssertEqual(try csv(directory, chunk)[1], "502.500000,1790000002.500000,31.23040000,121.47370000,,,4.5,,8.25,0.6,,,,0,0")
        XCTAssertEqual(streams(manifest)["batched_accel"]?["status"] as? String, "unsupported")
        XCTAssertEqual(streams(manifest)["acoustic"]?["status"] as? String, "disabled")
        XCTAssertEqual(manifest["simulated"] as? Bool, true)
    }
    func testStorageDegradesInThreeStepsAndFinallySealsWithoutTouchingBaseRecording() async throws {
        let root = tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let recorder = RoadlogRecorder(root: root)
        recorder.freeBytes = { 100 << 20 }
        XCTAssertFalse(recorder.begin(.init(rideId: UUID(), simulated: true)), "below 300 MiB: no roadlog at all")
        XCTAssertNotNil(recorder.lastError)
        recorder.freeBytes = { 50 << 30 }
        XCTAssertTrue(recorder.begin(.init(rideId: UUID(), simulated: true)))
        let sink = try XCTUnwrap(recorder.sink), name = try XCTUnwrap(recorder.packageId)
        recorder.applyStorage(free: 1536 << 20)                 // < 2 GiB
        XCTAssertEqual(sink.level, 1)
        recorder.applyStorage(free: 3 << 30)                    // never goes back up during a ride
        XCTAssertEqual(sink.level, 1)
        recorder.applyStorage(free: 512 << 20)                  // < 1 GiB
        XCTAssertEqual(sink.level, 2)
        for i in 0..<100 { sink.feed("motion", motionRow(10 + Double(i) * 0.01)); sink.feed("accel_raw", [10 + Double(i) * 0.01, 0, 0, 1]) }
        recorder.applyStorage(free: 100 << 20)                  // < 300 MiB → roadlog stopped and sealed
        XCTAssertFalse(recorder.active)
        await recorder.waitForSeal(name)
        let manifest = RoadlogJSON.object(try Data(contentsOf: root.appendingPathComponent(name).appendingPathComponent("manifest.json")))!
        let degradations = manifest["degradations"] as! [[String: Any]]
        XCTAssertEqual(degradations.map { $0["action"] as! String }, ["raw_audio_stopped", "imu_rate_reduced", "roadlog_stopped"])
        XCTAssertEqual(streams(manifest)["accel_raw"]!["status"] as? String, "degraded")
        XCTAssertEqual(streams(manifest)["accel_raw"]!["rows"] as? Int, 0)
        XCTAssertEqual(streams(manifest)["motion"]!["rows"] as? Int, 25, "100 Hz input thinned to 25 Hz")
        XCTAssertEqual(manifest["status"] as? String, "sealed")
    }
    func testDemoRideCreatesNoPackageButRealRideDoes() async throws {
        let defaults = UserDefaults.standard
        let keys = ["demoMode", "watchHaptics", "activeRideID", "motuo.watch.lastSummary", "roadlogEnabled"]
        let old = Dictionary(uniqueKeysWithValues: keys.map { ($0, defaults.object(forKey: $0)) })
        defer { for key in keys { if let value = old[key] ?? nil { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) } } }
        defaults.removeObject(forKey: "activeRideID")
        let root = tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let container = try ModelContainer(for: Vehicle.self, Ride.self, MaintenanceEntry.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none))
        let context = ModelContext(container); context.autosaveEnabled = false
        let settings = AppSettings(); settings.watchHaptics = false; settings.roadlogEnabled = true; settings.demoMode = false
        let recorder = RoadlogRecorder(root: root); recorder.freeBytes = { 50 << 30 }
        let engine = RideEngine(saveChanges: { try $0.save() }, roadlog: recorder)
        engine.configure(context: context, settings: settings)
        let vehicle = Vehicle(); context.insert(vehicle)
        engine.start(vehicle: vehicle, simulated: true)
        XCTAssertTrue(engine.isSimulated); XCTAssertFalse(recorder.active)
        engine.finish()
        XCTAssertEqual(RoadlogLibrary.packages(root: root).count, 0, "DEMO never writes a roadlog")
        engine.start(vehicle: vehicle, simulated: false)
        let ride = try XCTUnwrap(engine.currentRide)
        defer { try? FileManager.default.removeItem(at: TelemetryJournal.root.appendingPathComponent(ride.id.uuidString)) }
        XCTAssertTrue(recorder.active)
        let name = try XCTUnwrap(recorder.packageId)
        XCTAssertTrue(name.hasSuffix(ride.id.uuidString))
        engine.pause(); engine.resume()
        XCTAssertEqual(recorder.packageId, name, "pause/resume keeps one package")
        engine.finish()
        XCTAssertFalse(recorder.active)
        await recorder.waitForSeal(name)
        let manifest = RoadlogJSON.object(try Data(contentsOf: root.appendingPathComponent(name).appendingPathComponent("manifest.json")))!
        XCTAssertEqual(manifest["provenance"] as? String, "measured")
        XCTAssertEqual(manifest["rideId"] as? String, ride.id.uuidString)
        XCTAssertNotNil((manifest["vehicle"] as? [String: Any])?["model"]); XCTAssertNil((manifest["vehicle"] as? [String: Any])?["plate"])
        let types = RoadlogJSON.lines(root.appendingPathComponent(name).appendingPathComponent("events.jsonl")).compactMap { $0["type"] as? String }
        for type in ["ride_start", "ride_pause", "ride_resume", "ride_finish"] { XCTAssertTrue(types.contains(type), type) }
    }
    func testInfoPlistDeclaresFilesICloudContainerAndBackgroundTask() {
        let info = Bundle.main.infoDictionary ?? [:]
        XCTAssertEqual(info["UIFileSharingEnabled"] as? Bool, true); XCTAssertEqual(info["LSSupportsOpeningDocumentsInPlace"] as? Bool, true)
        XCTAssertEqual(info["BGTaskSchedulerPermittedIdentifiers"] as? [String], [RoadlogBackground.identifier])
        XCTAssertTrue((info["UIBackgroundModes"] as? [String] ?? []).contains("processing"))
        let container = (info["NSUbiquitousContainers"] as? [String: Any])?[Roadlog.containerIdentifier] as? [String: Any]
        XCTAssertEqual(container?["NSUbiquitousContainerIsDocumentScopePublic"] as? Bool, true)
        XCTAssertEqual(container?["NSUbiquitousContainerName"] as? String, "Motuo")
    }
    func testSettingsDefaultRoadlogOnRawAudioOffRetention() {
        let defaults = UserDefaults.standard
        let keys = ["roadlogEnabled", "roadlogRawAudio", "roadlogKeepCount", "roadlogKeepDays"]
        let old = Dictionary(uniqueKeysWithValues: keys.map { ($0, defaults.object(forKey: $0)) })
        defer { for key in keys { if let value = old[key] ?? nil { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) } } }
        for key in keys { defaults.removeObject(forKey: key) }
        let settings = AppSettings()
        XCTAssertTrue(settings.roadlogEnabled); XCTAssertFalse(settings.roadlogRawAudio)
        XCTAssertEqual(settings.roadlogKeepCount, 10); XCTAssertEqual(settings.roadlogKeepDays, 7)
    }
}

private final class FakeCloud: RoadlogCloudProvider, @unchecked Sendable {
    let lock = NSLock()
    var available: RoadlogCloudAvailability
    var failPlacement = false
    var uploaded = false
    var placed: [String] = []
    init(_ available: RoadlogCloudAvailability) { self.available = available }
    func availability() -> RoadlogCloudAvailability { lock.lock(); defer { lock.unlock() }; return available }
    func place(package: URL, into folder: URL) throws -> URL {
        lock.lock(); let fail = failPlacement; lock.unlock()
        if fail { throw NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError) }
        try ICloudDriveProvider.copyManifestLast(from: package, to: folder.appendingPathComponent(package.lastPathComponent))
        lock.lock(); placed.append(package.lastPathComponent); lock.unlock()
        return folder.appendingPathComponent(package.lastPathComponent)
    }
    func uploadStatus(of placed: URL) -> (uploaded: Bool, error: String?) { lock.lock(); defer { lock.unlock() }; return (uploaded, uploaded ? nil : nil) }
}

@MainActor final class RoadlogUploadTests: XCTestCase {
    private func sealedPackage(_ root: URL, simulated: Bool = false, start: Date = Date()) throws -> String {
        let id = UUID(), name = Roadlog.packageName(start: start, rideId: id)
        let writer = try RoadlogPackageWriter(root: root, session: session(id, simulated: simulated), packageId: name, mapping: .init(mono: 0, unix: start.timeIntervalSince1970))
        for i in 0..<20 { writer.append("motion", motionRow(Double(i) * 0.01)) }
        try writer.seal(end: .init(mono: 1, unix: start.timeIntervalSince1970 + 1))
        return name
    }
    func testUnavailableICloudKeepsLocalThenResumesAndConfirmsUpload() async throws {
        let root = tempRoot(), cloud = tempRoot(); defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: cloud) }
        let provider = FakeCloud(.unavailable("未登录 iCloud"))
        let queue = RoadlogUploadQueue(localRoot: root, store: root.appendingPathComponent("q.json"), provider: provider)
        let name = try sealedPackage(root)
        queue.enqueue(name, simulated: false)
        await queue.process()
        XCTAssertEqual(queue.item(name)?.state, .localOnly); XCTAssertTrue(queue.item(name)?.reason?.contains("未登录 iCloud") == true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path))
        provider.lock.lock(); provider.available = .available(cloud); provider.lock.unlock()
        await queue.retryNow()
        XCTAssertEqual(queue.item(name)?.state, .placedInCloud)
        XCTAssertEqual(RoadlogVerifier.problems(cloud.appendingPathComponent(name)), [], "copy is complete and verifiable")
        await queue.process()
        XCTAssertEqual(queue.item(name)?.state, .placedInCloud, "not yet uploaded by iCloud")
        provider.lock.lock(); provider.uploaded = true; provider.lock.unlock()
        await queue.process()
        XCTAssertEqual(queue.item(name)?.state, .uploaded); XCTAssertNotNil(queue.item(name)?.uploadedAt)
        let reloaded = RoadlogUploadQueue(localRoot: root, store: root.appendingPathComponent("q.json"), provider: provider)
        XCTAssertEqual(reloaded.item(name)?.state, .uploaded, "state persists")
    }
    func testPlacementFailureBacksOffThenRetries() async throws {
        let root = tempRoot(), cloud = tempRoot(); defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: cloud) }
        let provider = FakeCloud(.available(cloud)); provider.failPlacement = true
        let queue = RoadlogUploadQueue(localRoot: root, store: root.appendingPathComponent("q.json"), provider: provider)
        var clock = Date(timeIntervalSince1970: 1_790_000_000); queue.now = { clock }
        let name = try sealedPackage(root); queue.enqueue(name, simulated: false)
        await queue.process()
        XCTAssertEqual(queue.item(name)?.state, .failed); XCTAssertEqual(queue.item(name)?.retryCount, 1)
        XCTAssertEqual(queue.item(name)!.nextRetryAt!.timeIntervalSince(clock), 60, accuracy: 0.001)
        provider.lock.lock(); provider.failPlacement = false; provider.lock.unlock()
        await queue.process()
        XCTAssertEqual(queue.item(name)?.state, .failed, "waits for the backoff")
        clock = clock.addingTimeInterval(61)
        await queue.process()
        XCTAssertEqual(queue.item(name)?.state, .placedInCloud)
        XCTAssertEqual(queue.backoff(5).timeIntervalSince(clock), 960, accuracy: 0.001)
        XCTAssertEqual(queue.backoff(40).timeIntervalSince(clock), 6 * 3600, accuracy: 0.001)
    }
    func testSimulatedTamperedAndUnsealedPackagesAreNotUploaded() async throws {
        let root = tempRoot(), cloud = tempRoot(); defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: cloud) }
        let provider = FakeCloud(.available(cloud))
        let queue = RoadlogUploadQueue(localRoot: root, store: root.appendingPathComponent("q.json"), provider: provider)
        let simulated = try sealedPackage(root, simulated: true)
        queue.enqueue(simulated, simulated: true)
        let tampered = try sealedPackage(root, start: Date().addingTimeInterval(-60))
        let chunk = root.appendingPathComponent(tampered).appendingPathComponent("streams/motion/000001.csv.gz")
        try Data("x".utf8).write(to: chunk)
        queue.enqueue(tampered, simulated: false)
        let open = try RoadlogPackageWriter(root: root, session: session(simulated: false), packageId: "open", mapping: .init(mono: 0, unix: 0))
        queue.enqueue("open", simulated: false, state: .pendingSeal)
        await queue.process()
        XCTAssertEqual(queue.item(simulated)?.state, .rejected)
        XCTAssertEqual(queue.item(tampered)?.state, .failed); XCTAssertTrue(queue.item(tampered)?.reason?.contains("校验") == true)
        XCTAssertEqual(queue.item("open")?.state, .pendingSeal)
        XCTAssertEqual(provider.placed, [])
        try open.seal(end: .init(mono: 1, unix: 1))
        await queue.process()
        XCTAssertEqual(queue.item("open")?.state, .sealed)
        await queue.process()
        XCTAssertEqual(queue.item("open")?.state, .placedInCloud)
        XCTAssertEqual(provider.placed, ["open"])
    }
    /// The real iCloud Drive provider on this simulator: reports what it actually sees and must degrade, not crash.
    func testRealICloudProviderOnThisDeviceDegradesToLocalOnly() async throws {
        let root = tempRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let availability = await Task.detached { ICloudDriveProvider().availability() }.value
        print("ROADLOG_ICLOUD_AVAILABILITY \(availability)")
        let queue = RoadlogUploadQueue(localRoot: root, store: root.appendingPathComponent("q.json"), provider: ICloudDriveProvider())
        let name = try sealedPackage(root); queue.enqueue(name, simulated: false)
        await queue.process()
        switch availability {
        case .unavailable:
            XCTAssertEqual(queue.item(name)?.state, .localOnly)
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(name).appendingPathComponent("manifest.json").path))
        case let .available(folder):
            XCTAssertEqual(queue.item(name)?.state, .placedInCloud)
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
    }
    func testCleanupDeletesOnlyUploadedCopiesOutsideRetention() async throws {
        let root = tempRoot(), cloud = tempRoot(); defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: cloud) }
        let provider = FakeCloud(.available(cloud)); provider.uploaded = true
        let queue = RoadlogUploadQueue(localRoot: root, store: root.appendingPathComponent("q.json"), provider: provider)
        var clock = Date(); queue.now = { clock }; queue.retention = { (1, 7) }
        let older = try sealedPackage(root, start: Date().addingTimeInterval(-7200)), newer = try sealedPackage(root, start: Date().addingTimeInterval(-3600))
        queue.enqueue(older, simulated: false); queue.enqueue(newer, simulated: false)
        await queue.process(); await queue.process()
        XCTAssertEqual(queue.item(older)?.state, .uploaded); XCTAssertEqual(queue.item(newer)?.state, .uploaded)
        provider.lock.lock(); provider.available = .unavailable("off"); provider.lock.unlock()
        let pending = try sealedPackage(root, start: Date().addingTimeInterval(-10800)); queue.enqueue(pending, simulated: false)
        await queue.process()
        XCTAssertEqual(queue.item(pending)?.state, .localOnly)
        clock = clock.addingTimeInterval(8 * 86400)
        queue.cleanup()
        XCTAssertTrue(queue.item(older)!.localDeleted); XCTAssertFalse(queue.item(newer)!.localDeleted, "newest N kept")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(older).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(newer).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(pending).path), "never deletes unconfirmed packages")
    }
}
