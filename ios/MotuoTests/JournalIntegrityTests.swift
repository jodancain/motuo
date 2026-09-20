import XCTest
@testable import Motuo

final class JournalIntegrityTests: XCTestCase {
    private func sample(speed: Double = 10) -> TelemetrySample { .init(timestamp: Date(timeIntervalSince1970: 1_789_400_000), monotonicS: 1, source: "simulated", stream: "simulation", segmentId: "test", speedMPS: speed, quality: "valid") }
    func testFreshJournalRejectsChangedConfirmedBlockWithoutRewritingManifest() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID(), journal = try TelemetryJournal(rideId: id, root: root)
        journal.append(sample()); let committed = try journal.flush()
        let manifest = journal.directory.appendingPathComponent("manifest.json"), original = try Data(contentsOf: journal.directory.appendingPathComponent("manifest.json"))
        let altered = try MotuoJSON.encoder().encode(sample(speed: 11)) + Data([10])
        let block = journal.directory.appendingPathComponent("0.jsonl"); try altered.write(to: block)
        XCTAssertNotEqual(TelemetryJournal.hash(altered), committed[0].sha256)
        XCTAssertThrowsError(try TelemetryJournal(rideId: id, root: root))
        XCTAssertEqual(try Data(contentsOf: manifest), original); XCTAssertEqual(try Data(contentsOf: block), altered)
    }
    func testFreshJournalRejectsMissingConfirmedBlockAndPreservesRemainingFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID(), journal = try TelemetryJournal(rideId: id, root: root)
        journal.append(sample()); try journal.flush(); journal.append(sample(speed: 12)); try journal.flush()
        let manifest = journal.directory.appendingPathComponent("manifest.json"), original = try Data(contentsOf: manifest)
        let second = try Data(contentsOf: journal.directory.appendingPathComponent("1.jsonl"))
        try FileManager.default.removeItem(at: journal.directory.appendingPathComponent("0.jsonl"))
        XCTAssertThrowsError(try TelemetryJournal(rideId: id, root: root))
        XCTAssertEqual(try Data(contentsOf: manifest), original)
        XCTAssertEqual(try Data(contentsOf: journal.directory.appendingPathComponent("1.jsonl")), second)
    }
    func testMalformedManifestRemainsUntouchedInsteadOfBeingRecreated() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID(), journal = try TelemetryJournal(rideId: id, root: root)
        journal.append(sample()); try journal.flush()
        let manifest = journal.directory.appendingPathComponent("manifest.json"), invalid = Data("{truncated".utf8)
        let originalBlock = try Data(contentsOf: journal.directory.appendingPathComponent("0.jsonl"))
        try invalid.write(to: manifest)
        XCTAssertThrowsError(try TelemetryJournal(rideId: id, root: root))
        XCTAssertEqual(try Data(contentsOf: manifest), invalid)
        XCTAssertEqual(try Data(contentsOf: journal.directory.appendingPathComponent("0.jsonl")), originalBlock)
    }
    func testCompleteUnmanifestedTailIsRecoveredButMalformedTailIsPreservedAndRejected() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at: root) }
        let id = UUID(), journal = try TelemetryJournal(rideId: id, root: root)
        journal.append(sample()); let known = try journal.flush()
        let tail = try MotuoJSON.encoder().encode(sample(speed: 12)) + Data([10])
        try tail.write(to: journal.directory.appendingPathComponent("1.jsonl"))
        let recovered = try TelemetryJournal(rideId: id, root: root)
        XCTAssertEqual(recovered.committedChunks.count, 2); XCTAssertEqual(recovered.committedChunks[0].sha256, known[0].sha256)
        XCTAssertEqual(recovered.committedChunks[1].sha256, TelemetryJournal.hash(tail))
        let malformed = Data("not a telemetry row\n".utf8), malformedURL = journal.directory.appendingPathComponent("2.jsonl")
        try malformed.write(to: malformedURL)
        let manifestBefore = try Data(contentsOf: journal.directory.appendingPathComponent("manifest.json"))
        XCTAssertThrowsError(try TelemetryJournal(rideId: id, root: root))
        XCTAssertEqual(try Data(contentsOf: malformedURL), malformed)
        XCTAssertEqual(try Data(contentsOf: journal.directory.appendingPathComponent("manifest.json")), manifestBefore)
    }
}
