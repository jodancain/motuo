import XCTest
import simd
@testable import Motuo

final class MotuoTests:XCTestCase {
    @MainActor func testSummaryDistinguishesMissingSpeedFromMeasuredStationary() {
        let ride=Ride(vehicle:Vehicle(),simulated:false);ride.durationS=30
        XCTAssertTrue(RideEngine.localSummary(for:ride).contains("速度统计未知"))
        ride.validSpeedSamples=1
        XCTAssertTrue(RideEngine.localSummary(for:ride).contains("均速 0 km/h"))
        XCTAssertFalse(RideEngine.localSummary(for:ride).contains("速度统计未知"))
    }
    func testTelemetryClockKeepsSamplingTimeAndSeparatesResumeSegments() throws {
        let start = Date(timeIntervalSince1970: 1789400000)
        let clock = TelemetrySegmentClock(wall: start, uptime: 123456)
        let motion = try XCTUnwrap(clock.motion(uptime: 123458.02))
        XCTAssertEqual(motion.elapsed, 2.02, accuracy: 0.000001)
        XCTAssertEqual(motion.timestamp.timeIntervalSince(start), 2.02, accuracy: 0.000001)
        // A GPS fix arriving after this IMU callback retains its older capture time.
        let gps = try XCTUnwrap(clock.location(timestamp: start.addingTimeInterval(1)))
        XCTAssertEqual(gps, 1); XCTAssertLessThan(gps, motion.elapsed)
        XCTAssertNil(clock.location(timestamp: start.addingTimeInterval(-1)))
        XCTAssertNil(clock.motion(uptime: 123455))
        let resumed = TelemetrySegmentClock(wall: start.addingTimeInterval(60), uptime: 123516)
        XCTAssertNotEqual(clock.id, resumed.id)
        XCTAssertEqual(try XCTUnwrap(resumed.motion(uptime: 123516.1)).elapsed, 0.1, accuracy: 0.000001)
        let sample = TelemetrySample(timestamp: motion.timestamp, monotonicS: motion.elapsed, source: "measured", stream: "motion", segmentId: clock.id.uuidString, quality: "valid")
        let data = try MotuoJSON.encoder().encode(sample)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String:Any])
        XCTAssertEqual(json["stream"] as? String, "motion")
        XCTAssertEqual(json["segmentId"] as? String, clock.id.uuidString)
        XCTAssertLessThan(try XCTUnwrap(json["monotonicS"] as? Double), 3)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("123456"))
    }
    func testGPSTrendRequiresConsistentChangesAndResetsAcrossUncertaintyAndGaps() {
        var trend = GPSSpeedTrend(); let start = Date()
        func time(_ value: Double) -> Date { start.addingTimeInterval(value) }
        XCTAssertEqual(trend.update(speed:10,accuracy:0.2,timestamp:time(0),now:time(0)),0)
        XCTAssertEqual(trend.update(speed:11,accuracy:0.2,timestamp:time(1),now:time(1)),0)
        XCTAssertEqual(trend.update(speed:12,accuracy:0.2,timestamp:time(2),now:time(2)),1)
        XCTAssertEqual(trend.update(speed:11,accuracy:0.2,timestamp:time(3),now:time(3)),0)
        XCTAssertEqual(trend.update(speed:10,accuracy:0.2,timestamp:time(4),now:time(4)),-1)
        XCTAssertEqual(trend.update(speed:nil,accuracy:0.2,timestamp:time(5),now:time(5)),0)
        XCTAssertEqual(trend.update(speed:9,accuracy:0.2,timestamp:time(6),now:time(6)),0)
        XCTAssertEqual(trend.update(speed:8,accuracy:0.2,timestamp:time(15),now:time(15)),0)
        XCTAssertEqual(trend.update(speed:7,accuracy:2,timestamp:time(16),now:time(16)),0)
        XCTAssertEqual(trend.update(speed:6,accuracy:0.2,timestamp:time(17),now:time(22)),0)
        XCTAssertEqual(trend.update(speed:40,accuracy:0.2,timestamp:time(23),now:time(23)),0)
        XCTAssertEqual(trend.update(speed:2,accuracy:0.2,timestamp:time(24),now:time(24)),0)
    }
    func testWatchSummaryOptionalFieldsRemainCompatible() throws {
        let context = WatchRideContext(isRiding:false,isSimulated:true,speedKPH:nil,distanceKM:12.5,elapsedSeconds:1234,status:"骑行完成",updatedAt:Date(),isSummary:true,navTitle:"测试目的地",navInstruction:"请在高德查看摩托路线")
        let data = try JSONEncoder().encode(context)
        let value = try JSONDecoder().decode(WatchRideContext.self,from:data)
        XCTAssertEqual(value.distanceKM,12.5); XCTAssertEqual(value.elapsedSeconds,1234)
        XCTAssertEqual(value.isSummary,true); XCTAssertNil(value.speedKPH)
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        legacy.removeValue(forKey:"isSummary");legacy.removeValue(forKey:"navTitle");legacy.removeValue(forKey:"navInstruction")
        XCTAssertNil(try JSONDecoder().decode(WatchRideContext.self,from:JSONSerialization.data(withJSONObject:legacy)).isSummary)
    }
    func testInvalidAndStaleSpeedsRemainUnknown() {
        let now=Date()
        XCTAssertNil(SpeedQuality.accepted(speed:-1,accuracy:1,timestamp:now,now:now))
        XCTAssertNil(SpeedQuality.accepted(speed:12,accuracy:-1,timestamp:now,now:now))
        XCTAssertNil(SpeedQuality.accepted(speed:12,accuracy:1,timestamp:now.addingTimeInterval(-5),now:now))
        XCTAssertNil(SpeedQuality.accepted(speed:12,accuracy:6,timestamp:now,now:now))
        XCTAssertEqual(SpeedQuality.accepted(speed:0,accuracy:1,timestamp:now,now:now),0)
    }
    func testTelemetryOmitsUnknownFieldsAndPreservesSubsecondTime() throws {
        let sample=TelemetrySample(timestamp:Date(timeIntervalSince1970:1789400000.123),monotonicS:10.123,source:"measured",quality:"unavailable")
        let data=try MotuoJSON.encoder().encode(sample)
        let json=try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        XCTAssertNil(json["speedMPS"]);XCTAssertNil(json["rollRad"])
        let decoded=try MotuoJSON.decoder().decode(TelemetrySample.self,from:data)
        XCTAssertEqual(decoded.timestamp.timeIntervalSince1970,sample.timestamp.timeIntervalSince1970,accuracy:0.001)
    }
    func testJournalCommitsIdempotentlyAndRecoversIncompleteTail() throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:root)}
        let id=UUID();let journal=try TelemetryJournal(rideId:id,root:root,chunkLimit:1024)
        let sample=TelemetrySample(timestamp:Date(),monotonicS:10,source:"measured",speedMPS:10,quality:"valid")
        for _ in 0..<20 { journal.append(sample) }
        let first=try journal.flush();XCTAssertFalse(first.isEmpty)
        let again=try journal.flush();XCTAssertEqual(first.map(\.sha256),again.map(\.sha256))
        XCTAssertEqual(first.reduce(0){$0+$1.samples},20)
        XCTAssertTrue(first.allSatisfy{$0.bytes<=1024})
        for chunk in first { XCTAssertEqual(TelemetryJournal.hash(try journal.data(for:chunk)),chunk.sha256) }
        let valid=try MotuoJSON.encoder().encode(sample)+Data([10])
        try (valid+Data("{\"truncated\":".utf8)).write(to:journal.directory.appendingPathComponent("pending.partial"))
        let recovered=try TelemetryJournal(rideId:id,root:root)
        XCTAssertEqual(recovered.committedChunks.reduce(0){$0+$1.samples},21)
        XCTAssertEqual(recovered.committedChunks.count,first.count+1)
        XCTAssertFalse(FileManager.default.fileExists(atPath:journal.directory.appendingPathComponent("pending.partial").path))
        let reopened=try TelemetryJournal(rideId:id,root:root)
        XCTAssertEqual(reopened.committedChunks.map(\.sha256),recovered.committedChunks.map(\.sha256))
    }
    func testHapticGateDropsExpiredDuplicateInactiveAndBurstEvents() {
        let now=Date();var gate=HapticGate()
        let first=RideHapticEvent(kind:.start,now:now)
        XCTAssertTrue(gate.accept(first,now:now,isActive:true))
        XCTAssertFalse(gate.accept(first,now:now.addingTimeInterval(4),isActive:true))
        XCTAssertFalse(gate.accept(.init(kind:.pause,now:now),now:now,isActive:true))
        XCTAssertFalse(gate.accept(.init(kind:.finish,now:now.addingTimeInterval(-20)),now:now,isActive:true))
        let inactive=RideHapticEvent(kind:.finish,now:now.addingTimeInterval(5))
        XCTAssertFalse(gate.accept(inactive,now:now.addingTimeInterval(5),isActive:false))
        XCTAssertFalse(gate.accept(inactive,now:now.addingTimeInterval(6),isActive:true))
        XCTAssertTrue(gate.accept(.init(kind:.finish,now:now.addingTimeInterval(10)),now:now.addingTimeInterval(10),isActive:true))
    }
    /// Rewritten 2026-10-23: the old magnitude-jerk rule this test pinned is the saturating heuristic that was removed.
    /// Candidates now come from VehicleStateEstimator; standstill and data gaps still never produce a gear candidate.
    func testCandidateDetectorDoesNotInferGearAtStandstillOrAcrossDataGaps() {
        var estimator = VehicleStateEstimator()
        let up = SIMD3<Double>(0.2, 0.74, 0.64) / simd_length(SIMD3<Double>(0.2, 0.74, 0.64))
        var rng = SeededRNG(7)
        // 30 s standstill with violent vibration and rotation (phone handled / engine shaking) and a loud microphone.
        for i in 0..<1500 {
            let t = Double(i) * 0.02, n = { Double.random(in: -1...1, using: &rng) }
            estimator.motion(t: t, userAcceleration: SIMD3(n(), n(), n()) * 0.6, gravity: -up, rotation: SIMD3(n(), n(), n()) * 1.5)
            if i % 50 == 0 { estimator.gps(t: t, speed: 0, accuracy: 0.3, horizontalAccuracy: 4) }
            if i % 2 == 0 { estimator.acoustic(t: t, rmsDbfs: -10 + 8 * n()) }
        }
        let events = estimator.drainEvents()
        XCTAssertFalse(events.contains { $0.kind == .suspectedShift || $0.kind == .corner }, "no candidates at standstill")
        XCTAssertFalse(events.contains { $0.field == "motion" && $0.to != "stopped" }, "standstill stays stopped")
        XCTAssertFalse(events.contains { $0.field == "turn" && $0.to != "none" })
        // The adapter drops candidates below 3 m/s and windows that cannot be placed on the ride clock (data gap).
        let processor = RideSignalProcessor(), now = Date()
        let shift = VehicleStateEvent(t: 10, kind: .suspectedShift, confidence: 0.45, source: "inferred")
        XCTAssertNil(processor.rideEvent(shift, wall: { now.addingTimeInterval($0) }, speed: 0, simulated: false))
        XCTAssertNil(processor.rideEvent(shift, wall: { _ in nil }, speed: 10, simulated: false))
        let event = processor.rideEvent(shift, wall: { now.addingTimeInterval($0) }, speed: 10, simulated: false)
        XCTAssertEqual(event?.kind, "suspectedShift"); XCTAssertEqual(event?.source, "inferred"); XCTAssertNil(event?.feedback)
        XCTAssertEqual(event?.confidence, 0.45)
        let corner = VehicleStateEvent(t: 14, kind: .corner, confidence: 0.6, dir: "left", start: 10, end: 14, angleDeg: 60, source: "inferred")
        let turn = processor.rideEvent(corner, wall: { now.addingTimeInterval($0) }, speed: 8, simulated: true)
        XCTAssertEqual(turn?.kind, "turn"); XCTAssertEqual(turn?.source, "simulated")
        XCTAssertEqual(turn?.windowStart, now.addingTimeInterval(10)); XCTAssertEqual(turn?.windowEnd, now.addingTimeInterval(14))
        XCTAssertNil(processor.rideEvent(.init(t: 1, kind: .state, field: "motion", to: "braking", source: "inferred"), wall: { now.addingTimeInterval($0) }, speed: 10, simulated: false), "state changes are not ride events")
    }
}
