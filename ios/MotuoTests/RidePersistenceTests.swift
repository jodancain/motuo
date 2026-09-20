import XCTest
import SwiftData
@testable import Motuo

@MainActor final class RidePersistenceTests: XCTestCase {
    private struct SimulatedDiskFull: LocalizedError { var errorDescription: String? { "Test disk full" } }
    private func withIsolatedDefaults(_ operation: () throws -> Void) rethrows {
        let defaults = UserDefaults.standard
        let keys = ["demoMode", "watchHaptics", "activeRideID", "motuo.watch.lastSummary"]
        let old = Dictionary(uniqueKeysWithValues: keys.map { ($0, defaults.object(forKey: $0)) })
        defaults.removeObject(forKey: "activeRideID")
        defer { for key in keys { if let value = old[key] ?? nil { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) } } }
        try operation()
    }
    func testFinishSaveFailureKeepsRecoveryAndRetryCompletesOnce() throws {
        try withIsolatedDefaults {
            let container = try ModelContainer(for: Vehicle.self, Ride.self, MaintenanceEntry.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true))
            let context = ModelContext(container); context.autosaveEnabled = false
            let settings = AppSettings(); settings.demoMode = true; settings.watchHaptics = false
            var shouldFail = false
            let engine = RideEngine(saveChanges: { context in if shouldFail { throw SimulatedDiskFull() }; try context.save() })
            engine.configure(context: context, settings: settings)
            let vehicle = Vehicle(); context.insert(vehicle)
            engine.start(vehicle: vehicle)
            let ride = try XCTUnwrap(engine.currentRide), version = ride.dataVersion
            defer { try? FileManager.default.removeItem(at: TelemetryJournal.root.appendingPathComponent(ride.id.uuidString)) }
            shouldFail = true
            engine.finish()
            XCTAssertEqual(engine.currentRide?.id, ride.id)
            XCTAssertEqual(ride.status, "interrupted"); XCTAssertNil(ride.endedAt); XCTAssertNil(ride.segmentStartedAt)
            XCTAssertEqual(ride.dataVersion, version); XCTAssertTrue(ride.summaryText.isEmpty)
            XCTAssertNil(engine.lastFinishedRide); XCTAssertNil(engine.speedMPS)
            XCTAssertEqual(UserDefaults.standard.string(forKey: "activeRideID"), ride.id.uuidString)
            XCTAssertNotNil(engine.errorMessage); XCTAssertTrue(engine.isPaused); XCTAssertFalse(engine.isRecording)
            let duration = ride.durationS
            shouldFail = false
            engine.finish()
            XCTAssertNil(engine.currentRide); XCTAssertEqual(engine.lastFinishedRide?.id, ride.id)
            XCTAssertTrue(ride.isFinished); XCTAssertNotNil(ride.endedAt)
            XCTAssertEqual(ride.durationS, duration); XCTAssertEqual(ride.dataVersion, version + 1)
            XCTAssertNil(UserDefaults.standard.string(forKey: "activeRideID")); XCTAssertNil(engine.errorMessage)
            XCTAssertEqual(try context.fetch(FetchDescriptor<Ride>()).count, 1)
        }
    }
    func testResumeSaveFailureDoesNotRestartSensorsOrMarkRecording() throws {
        try withIsolatedDefaults {
            let container = try ModelContainer(for: Vehicle.self, Ride.self, MaintenanceEntry.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true))
            let context = ModelContext(container); context.autosaveEnabled = false
            let settings = AppSettings(); settings.demoMode = true; settings.watchHaptics = false
            var shouldFail = false
            let engine = RideEngine(saveChanges: { context in if shouldFail { throw SimulatedDiskFull() }; try context.save() })
            engine.configure(context: context, settings: settings)
            let vehicle = Vehicle(); context.insert(vehicle); engine.start(vehicle: vehicle)
            let ride = try XCTUnwrap(engine.currentRide)
            defer { try? FileManager.default.removeItem(at: TelemetryJournal.root.appendingPathComponent(ride.id.uuidString)) }
            engine.pause(); let duration = ride.durationS
            shouldFail = true; engine.resume()
            XCTAssertEqual(ride.status, "interrupted"); XCTAssertNil(ride.segmentStartedAt)
            XCTAssertFalse(engine.isRecording); XCTAssertTrue(engine.isPaused); XCTAssertNil(engine.speedMPS)
            XCTAssertEqual(UserDefaults.standard.string(forKey: "activeRideID"), ride.id.uuidString)
            XCTAssertEqual(ride.durationS, duration)
            shouldFail = false; engine.resume(); XCTAssertTrue(engine.isRecording)
            engine.finish(); XCTAssertTrue(ride.isFinished)
        }
    }
    func testFinishFlushFailureRecoversConfirmedChunksAndCompleteTailOnActualRetry() throws {
        try withIsolatedDefaults {
            let container = try ModelContainer(for: Vehicle.self, Ride.self, MaintenanceEntry.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true))
            let context = ModelContext(container); context.autosaveEnabled = false
            let settings = AppSettings(); settings.demoMode = true; settings.watchHaptics = false
            var causeFailure = true
            var captured: TelemetryJournal?
            let sample = TelemetrySample(timestamp: Date(), monotonicS: 1, source: "simulated", stream: "simulation", segmentId: "test", speedMPS: 5, quality: "valid")
            let engine = RideEngine(saveChanges: { try $0.save() }, flushJournal: { journal in
                captured = journal
                if causeFailure {
                    journal.append(sample); try journal.flush()
                    let manifest = journal.directory.appendingPathComponent("manifest.json")
                    try FileManager.default.removeItem(at: manifest)
                    try FileManager.default.createDirectory(at: manifest, withIntermediateDirectories: false)
                    journal.append(sample)
                }
                try journal.flushRecoveringAfterFailure()
            })
            engine.configure(context: context, settings: settings)
            let vehicle = Vehicle(); context.insert(vehicle); engine.start(vehicle: vehicle)
            let ride = try XCTUnwrap(engine.currentRide)
            defer { try? FileManager.default.removeItem(at: TelemetryJournal.root.appendingPathComponent(ride.id.uuidString)) }
            engine.finish()
            let journal = try XCTUnwrap(captured)
            let confirmed = journal.committedChunks
            XCTAssertEqual(confirmed.count, 2); XCTAssertNotNil(journal.errorMessage)
            XCTAssertEqual(ride.status, "interrupted"); XCTAssertNil(ride.endedAt); XCTAssertNil(engine.lastFinishedRide)
            XCTAssertEqual(UserDefaults.standard.string(forKey: "activeRideID"), ride.id.uuidString)
            let manifest = journal.directory.appendingPathComponent("manifest.json")
            try FileManager.default.removeItem(at: manifest)
            // Model a crash-interrupted final write: one complete row and one incomplete row.
            let complete = try MotuoJSON.encoder().encode(sample) + Data([10])
            try (complete + Data("{\"truncated\":".utf8)).write(to: journal.directory.appendingPathComponent("pending.partial"))
            causeFailure = false; engine.finish()
            XCTAssertNil(engine.currentRide); XCTAssertTrue(ride.isFinished); XCTAssertNil(journal.errorMessage)
            let recovered = journal.committedChunks
            XCTAssertEqual(recovered.count, 3); XCTAssertEqual(recovered.reduce(0) { $0 + $1.samples }, 3)
            XCTAssertEqual(Array(recovered.prefix(2)).map(\.sha256), confirmed.map(\.sha256))
            XCTAssertEqual(try journal.data(for: recovered[2]), complete)
            XCTAssertFalse(FileManager.default.fileExists(atPath: journal.directory.appendingPathComponent("pending.partial").path))
            XCTAssertEqual(try MotuoJSON.decoder().decode([TelemetryChunk].self, from: Data(contentsOf: manifest)).count, 3)
            XCTAssertEqual(ride.events.filter { $0.kind == "dataGap" }.count, 1)
            XCTAssertTrue(ride.notes.contains("未写完"))
        }
    }

}
