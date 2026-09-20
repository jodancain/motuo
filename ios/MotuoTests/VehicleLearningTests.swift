import XCTest
@testable import Motuo

final class VehicleLearningTests: XCTestCase {
    private let calibration = UUID()
    private let vehicle = UUID()
    private func fixture() -> LearningCollection {
        let start = Date(timeIntervalSince1970: 1_789_400_000)
        let inputs = (0..<4).map { index in
            LearningRideInput(id: UUID(), vehicleId: vehicle, calibrationId: calibration, startedAt: start.addingTimeInterval(Double(index) * 86400), source: "measured", finished: true, dataVersion: 2, events: [])
        }
        let examples = inputs.flatMap { ride in (0..<4).map { index in
            LearningExample(rideId: ride.id, eventId: UUID(), calibrationId: calibration, windowStart: start, windowEnd: start.addingTimeInterval(4), confirmed: index % 2 == 0, peakJerk: index % 2 == 0 ? 32 : 24, vibrationRMS: 1.2, samples: 200)
        } }
        return .init(examples: examples, inputs: inputs, skippedRides: 0)
    }
    func testNewestWholeRideIsHeldOutAndCandidateDoesNotActivateItself() throws {
        let data = fixture()
        let candidate = try VehicleLearningMath.candidate(data, vehicleId: vehicle, calibrationId: calibration, version: 1)
        XCTAssertEqual(candidate.trainingRideIds.count, 3); XCTAssertEqual(candidate.holdoutRideIds, [data.inputs.last!.id])
        XCTAssertTrue(Set(candidate.trainingRideIds).isDisjoint(with: candidate.holdoutRideIds))
        XCTAssertEqual(candidate.trainingExamples, 12); XCTAssertEqual(candidate.holdoutExamples, 4)
        XCTAssertEqual(candidate.jerkThreshold, 24); XCTAssertEqual(candidate.vibrationRMS, 1.2)
        // Changing only the holdout never changes the fitted threshold.
        var changed = data
        for index in changed.examples.indices where changed.examples[index].rideId == data.inputs.last!.id && changed.examples[index].confirmed { changed.examples[index].peakJerk = 38 }
        XCTAssertEqual(try VehicleLearningMath.candidate(changed, vehicleId: vehicle, calibrationId: calibration, version: 2).jerkThreshold, candidate.jerkThreshold)
    }
    func testInsufficientSimulatedDifferentCalibrationAndFailedHoldoutStayCollecting() throws {
        let original = fixture()
        var data = original; data.inputs[0].source = "simulated"
        XCTAssertThrowsError(try VehicleLearningMath.candidate(data, vehicleId: vehicle, calibrationId: calibration, version: 1))
        data = original; data.inputs[0].calibrationId = UUID()
        XCTAssertThrowsError(try VehicleLearningMath.candidate(data, vehicleId: vehicle, calibrationId: calibration, version: 1))
        data = original; data.examples.removeAll { $0.rideId == original.inputs.last!.id && !$0.confirmed }
        XCTAssertThrowsError(try VehicleLearningMath.candidate(data, vehicleId: vehicle, calibrationId: calibration, version: 1))
        data = original
        for index in data.examples.indices where data.examples[index].rideId == original.inputs.last!.id && data.examples[index].confirmed { data.examples[index].peakJerk = 23 }
        XCTAssertThrowsError(try VehicleLearningMath.candidate(data, vehicleId: vehicle, calibrationId: calibration, version: 1))
    }
    func testWindowFeaturesIgnoreTapTimeSimulationUnconfirmedAndOtherMounts() throws {
        let start = Date(timeIntervalSince1970: 1_789_400_000), ride = UUID()
        var event = RideEvent(kind: "suspectedShift", timestamp: start.addingTimeInterval(1), windowStart: start, windowEnd: start.addingTimeInterval(2), confidence: 0.45, source: "inferred", feedback: "confirmed")
        let samples = (0..<101).map { index in
            TelemetrySample(timestamp: start.addingTimeInterval(Double(index) * 0.02), monotonicS: Double(index) * 0.02, source: "measured", stream: "motion", segmentId: "segment", accelerationX: index == 50 ? 2 : 0.2, accelerationY: 0, accelerationZ: 0, rotationX: 0, rotationY: 0, rotationZ: 0, quality: "valid", calibrationId: calibration.uuidString)
        }
        let feature = try XCTUnwrap(VehicleLearningMath.features(samples: samples, event: event, rideId: ride, calibrationId: calibration))
        XCTAssertEqual(feature.windowStart, event.windowStart); XCTAssertEqual(feature.windowEnd, event.windowEnd)
        XCTAssertEqual(feature.peakJerk, 90, accuracy: 0.001)
        XCTAssertNil(VehicleLearningMath.features(samples: samples, event: event, rideId: ride, calibrationId: UUID()))
        var simulated = samples; for i in simulated.indices { simulated[i].source = "simulated" }
        XCTAssertNil(VehicleLearningMath.features(samples: simulated, event: event, rideId: ride, calibrationId: calibration))
        event.feedback = nil
        XCTAssertNil(VehicleLearningMath.features(samples: samples, event: event, rideId: ride, calibrationId: calibration))
        event.feedback = "confirmed"; event.source = "ai"
        XCTAssertNil(VehicleLearningMath.features(samples: samples, event: event, rideId: ride, calibrationId: calibration))
    }
    func testMissingSegmentsCannotCreateJerkAcrossRecordingGap() {
        let start = Date(); let ride = UUID()
        let event = RideEvent(kind: "suspectedShift", timestamp: start.addingTimeInterval(1), windowStart: start, windowEnd: start.addingTimeInterval(2), confidence: 0.45, source: "inferred", feedback: "rejected")
        let samples: [TelemetrySample] = (0..<101).map { index in
            let timestamp = start.addingTimeInterval(Double(index) * 0.02)
            let elapsed = Double(index % 50) * 0.02
            let acceleration: Double = index >= 50 ? 5 : 0
            return TelemetrySample(timestamp: timestamp, monotonicS: elapsed, source: "measured", stream: "motion", segmentId: String(index / 50), accelerationX: acceleration, accelerationY: 0, accelerationZ: 0, rotationX: 0, rotationY: 0, rotationZ: 0, quality: "valid", calibrationId: calibration.uuidString)
        }
        XCTAssertEqual(VehicleLearningMath.features(samples: samples, event: event, rideId: ride, calibrationId: calibration)?.peakJerk, 0)
    }
    func testCorruptedChunkCannotBecomeLearningEvidence() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let ride = UUID(), date = Date()
        let event = RideEvent(kind: "suspectedShift", timestamp: date, windowStart: date.addingTimeInterval(-2), windowEnd: date.addingTimeInterval(2), confidence: 0.45, source: "inferred", feedback: "confirmed")
        let input = LearningRideInput(id: ride, vehicleId: vehicle, calibrationId: calibration, startedAt: date, source: "measured", finished: true, dataVersion: 2, events: [event])
        let journal = try TelemetryJournal(rideId: ride, root: root)
        journal.append(.init(timestamp: date, monotonicS: 0, source: "measured", stream: "motion", segmentId: "first", quality: "valid", calibrationId: calibration.uuidString)); try journal.flush()
        try Data("changed\n".utf8).write(to: journal.directory.appendingPathComponent("0.jsonl"))
        let result = VehicleLearningMath.collect(inputs: [input], calibrationId: calibration, root: root)
        XCTAssertTrue(result.examples.isEmpty); XCTAssertEqual(result.skippedRides, 1)
    }
    @MainActor func testVersionRollbackLabelInvalidationRideAndAccountErasure() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("learning.json")
        let first = try VehicleLearningMath.candidate(fixture(), vehicleId: vehicle, calibrationId: calibration, version: 1)
        var second = first; second.id = UUID(); second.version = 2
        struct Seed: Encodable { var versions: [VehicleLearningVersion]; var active: [String: UUID] }
        try JSONEncoder().encode(Seed(versions: [first,second], active: [:])).write(to: file)
        let service = VehicleLearningService(file: file)
        XCTAssertNil(service.active(vehicleId: vehicle, calibrationId: calibration))
        try service.use(second); XCTAssertEqual(service.active(vehicleId: vehicle, calibrationId: calibration)?.id, second.id)
        try service.use(first); XCTAssertEqual(service.active(vehicleId: vehicle, calibrationId: calibration)?.id, first.id)
        XCTAssertNil(service.active(vehicleId: vehicle, calibrationId: UUID()))
        try service.useDefault(calibrationId: calibration); XCTAssertNil(service.active(vehicleId: vehicle, calibrationId: calibration))
        try service.use(first); try service.invalidate(rideId: first.trainingRideIds[0])
        XCTAssertNil(service.active(vehicleId: vehicle, calibrationId: calibration)); XCTAssertTrue(service.versions.allSatisfy(\.invalidated))
        try service.use(first); XCTAssertNil(service.active(vehicleId: vehicle, calibrationId: calibration))
        try service.invalidate(rideId: first.trainingRideIds[0], remove: true); XCTAssertTrue(service.versions.isEmpty)
        try service.eraseAll(); XCTAssertFalse(FileManager.default.fileExists(atPath: file.path)); XCTAssertTrue(service.versions.isEmpty)
    }
    func testPersonalThresholdAffectsDetectorAndResetsSafely() {
        func event(threshold: Double?) -> RideEvent? {
            var processor = RideSignalProcessor(); processor.setThreshold(threshold); processor.reset()
            _ = processor.process(acceleration: 0, rotation: 0, speed: 10, timestamp: Date(), monotonic: 0, simulated: false)
            return processor.process(acceleration: 2, rotation: 0, speed: 10, timestamp: Date(), monotonic: 0.1, simulated: false)
        }
        XCTAssertNil(event(threshold: nil)); XCTAssertNotNil(event(threshold: 18)); XCTAssertNil(event(threshold: 40))
        XCTAssertNil(event(threshold: .nan)); XCTAssertNil(event(threshold: 0))
    }
}
