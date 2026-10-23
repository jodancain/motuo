import XCTest
import UIKit
@testable import Motuo

/// v3 comic cockpit: bridge allowlist, snapshot fields, saved timeline, demo readings, orientations and version.
final class CockpitV3Tests: XCTestCase {
    private func png() -> Data { UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) } }

    func testCommandParsingAllowsOnlyListedActionsAndPayloads() throws {
        XCTAssertEqual(CockpitCommand.parse(["action": "primary"]), CockpitCommand(action: "primary"))
        XCTAssertNil(CockpitCommand.parse(["action": "eval"]))
        XCTAssertNil(CockpitCommand.parse(["action": "primary", "extra": 1]), "plain actions carry no payload")
        XCTAssertNil(CockpitCommand.parse("primary"))
        let appearance = try XCTUnwrap(CockpitCommand.parse(["action": "appearance", "paint": "stealth", "finish": "chrome", "world": "snow"]))
        XCTAssertEqual(appearance.paint, "stealth"); XCTAssertNil(appearance.finish); XCTAssertEqual(appearance.world, "snow")
        XCTAssertNil(CockpitCommand.parse(["action": "appearance", "paint": "gold"]))
        XCTAssertNil(CockpitCommand.parse(["action": "appearance", "paint": "ember", "script": "x"]))
        let data = png()
        let share = try XCTUnwrap(CockpitCommand.parse(["action": "share", "png": "data:image/png;base64," + data.base64EncodedString()]))
        XCTAssertEqual(share.image, data)
        XCTAssertNil(CockpitCommand.parse(["action": "share", "png": "data:image/png;base64," + Data("<html>".utf8).base64EncodedString()]), "not a PNG")
        XCTAssertNil(CockpitCommand.parse(["action": "share", "png": "data:text/html;base64,AAAA"]))
        XCTAssertNil(CockpitCommand.parse(["action": "share", "png": "https://example.com/a.png"]))
        for action in ["countdown", "countdownCancel", "appearance", "share", "wrappedShown", "rideDetail", "wrappedDone", "garage"] { XCTAssertTrue(CockpitCommand.commands.contains(action), action) }
    }

    /// Every action the shipped web bundle posts must be allowlisted (a missed entry once left the recap on its timeout).
    func testAllowlistCoversEveryActionInBundledWebSources() throws {
        let root = try XCTUnwrap(Bundle.main.url(forResource: "Cockpit", withExtension: nil))
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)).compactMap { $0 as? URL }
            .filter { $0.pathExtension == "js" && !$0.path.contains("/vendor/") }
        XCTAssertFalse(files.isEmpty)
        let pattern = try NSRegularExpression(pattern: #"\b(?:send|nativeSend|startNativeCountdown)\(\s*['"]([A-Za-z]+)['"]"#)
        var found = Set<String>()
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)) { found.insert(String(text[Range(match.range(at: 1), in: text)!])) }
            if file.lastPathComponent != "native-adapter.js", CockpitBundle.isV3 { XCTAssertFalse(text.contains("postMessage("), "\(file.lastPathComponent) bypasses the adapter") }
        }
        if CockpitBundle.isV3 {
            let adapter = try String(contentsOf: root.appendingPathComponent("native-adapter.js"), encoding: .utf8)
            let declared = try XCTUnwrap(adapter.range(of: #"NATIVE_ACTIONS = Object\.freeze\(\[[^\]]*\]"#, options: .regularExpression)).map { String(adapter[$0]) } ?? ""
            for match in try NSRegularExpression(pattern: #"'([A-Za-z]+)'"#).matches(in: declared, range: NSRange(declared.startIndex..., in: declared)) { found.insert(String(declared[Range(match.range(at: 1), in: declared)!])) }
        }
        XCTAssertGreaterThanOrEqual(found.count, 10, "scan found too few actions: \(found)")
        for action in found { XCTAssertTrue(CockpitCommand.commands.contains(action), "web posts \(action) but the native allowlist lacks it") }
        XCTAssertEqual(CockpitBundle.variant, "v3", "default build bundles the v3 cockpit")
    }

    func testSnapshotFieldsKeepMeasuredEstimatedAndMissingDistinct() throws {
        var input = CockpitSnapshotInput()
        input.phase = "riding"; input.simulated = true; input.demoMode = false; input.speedMPS = 10; input.speedSampleTime = 500; input.speedSampleElapsed = 12.5
        input.sampleTime = 501; input.seconds = 13; input.distanceM = 140; input.thermalState = "serious"; input.lowPower = true; input.modal = true; input.active = false
        input.appearance = ["paint": "panda"]; let panel = UUID(); input.panel = (panel, "garage")
        var json = input.json()
        XCTAssertEqual(json["speedKmh"] as? Double ?? 0, 36, accuracy: 0.0001); XCTAssertEqual(json["speedSource"] as? String, "gps")
        XCTAssertEqual(json["speedSampleTime"] as? Double, 500); XCTAssertEqual(json["speedSampleElapsed"] as? Double, 12.5)
        XCTAssertEqual(json["thermal"] as? Bool, true); XCTAssertEqual(json["thermalState"] as? String, "serious"); XCTAssertEqual(json["lowPower"] as? Bool, true)
        XCTAssertEqual(json["modal"] as? Bool, true); XCTAssertEqual(json["active"] as? Bool, false); XCTAssertEqual(json["simulated"] as? Bool, true)
        XCTAssertEqual((json["appearance"] as? [String: String])?["paint"], "panda")
        XCTAssertEqual((json["panel"] as? [String: String])?["id"], panel.uuidString)
        XCTAssertNil(json["finishedRide"])
        // GPS missing: a short inertial estimate is marked as such and carries no reading identity.
        input.speedMPS = nil; input.inertial = (speed: 5, uncertainty: 0.5)
        json = input.json()
        XCTAssertEqual(json["speedSource"] as? String, "inertial"); XCTAssertNil(json["speedSampleTime"]); XCTAssertEqual(json["uncertaintyKmh"] as? Double ?? 0, 1.8, accuracy: 0.0001)
        input.inertial = nil; input.thermalState = "fair"
        json = input.json()
        XCTAssertTrue(json["speedKmh"] is NSNull); XCTAssertEqual(json["speedSource"] as? String, "unavailable"); XCTAssertEqual(json["thermal"] as? Bool, false)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(json)); XCTAssertTrue(input.encoded().hasPrefix("{"))
    }

    @MainActor func testRecapPayloadUsesSavedSummaryAndTimelineOnly() throws {
        let ride = Ride(vehicle: Vehicle(), simulated: true); ride.distanceM = 812; ride.durationS = 61; ride.maxSpeedMPS = 20; ride.validSpeedSamples = 60
        let timeline = RideTimeline(points: [.init(t: 0, kmh: 0), .init(t: 1, kmh: nil), .init(t: 2, kmh: 12.3)], events: [.init(t: 1, kind: "turn")])
        let payload = CockpitRecap.payload(ride: ride, timeline: timeline)
        XCTAssertEqual(payload["maxSpeedKmh"] as? Double ?? 0, 72, accuracy: 0.0001); XCTAssertEqual(payload["simulated"] as? Bool, true)
        let points = try XCTUnwrap(payload["timeline"] as? [[String: Any]])
        XCTAssertEqual(points.count, 3); XCTAssertTrue(points[1]["v"] is NSNull); XCTAssertEqual(points[2]["v"] as? Double, 12.3)
        XCTAssertEqual((payload["events"] as? [[String: Any]])?.first?["kind"] as? String, "turn")
        ride.validSpeedSamples = 0
        XCTAssertTrue(CockpitRecap.payload(ride: ride, timeline: nil)["maxSpeedKmh"] is NSNull, "no valid samples → max speed unknown, not 0")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(payload))
    }

    func testTimelineLaysSegmentsEndToEndKeepsGapsAndDownsamplesWithoutAveraging() {
        let wall = Date(timeIntervalSince1970: 1_790_000_000), a = UUID().uuidString, b = UUID().uuidString
        func sample(_ m: Double, _ v: Double?, _ seg: String, stream: String = "location", at: Double) -> TelemetrySample {
            TelemetrySample(timestamp: wall.addingTimeInterval(at), monotonicS: m, source: "measured", stream: stream, segmentId: seg, speedMPS: v, latitude: 31, longitude: 121, quality: v == nil ? "degraded" : "valid")
        }
        let samples = [sample(0, 0, a, at: 0), sample(1, 5, a, at: 1), sample(2, nil, a, at: 2), sample(0.5, 9, a, stream: "motion", at: 2.5), sample(0, 4, b, at: 60), sample(1, 6, b, at: 61)]
        let event = RideEvent(kind: "turn", timestamp: wall.addingTimeInterval(60.2), windowStart: wall, windowEnd: wall, confidence: 0.5, source: "inferred")
        let far = RideEvent(kind: "turn", timestamp: wall.addingTimeInterval(400), windowStart: wall, windowEnd: wall, confidence: 0.5, source: "inferred")
        let timeline = RideTimeline.build(samples: samples, events: [event, far])
        XCTAssertEqual(timeline.points.map(\.t), [0, 1, 2, 3, 4], "pause excluded: second segment continues one reading later")
        XCTAssertEqual(timeline.points.map(\.kmh), [0, 18, nil, 14.4, 21.6])
        XCTAssertEqual(timeline.events, [.init(t: 3, kind: "turn")], "events map to the nearest saved sample; unmatched dropped")
        let long = (0..<3000).map { sample(Double($0), $0 == 1777 ? 30 : 10, a, at: Double($0)) }
        let reduced = RideTimeline.build(samples: long, maxPoints: 1000)
        XCTAssertLessThanOrEqual(reduced.points.count, 1003)
        XCTAssertTrue(reduced.points.contains { $0.kmh == 108 }, "peak reading kept")
        XCTAssertTrue(reduced.points.allSatisfy { $0.kmh == 36 || $0.kmh == 108 }, "kept values are recorded readings, never averages")
    }

    func testDemoProfileGivesDiscreteReadingsThroughEveryThresholdAndStops() {
        let values = (0..<76).map { RideEngine.demoSpeedKmh(at: Double($0)) }
        XCTAssertEqual(values[0], 0); XCTAssertTrue(values.allSatisfy { $0 >= 0 && $0 <= 110 })
        for threshold in [20.0, 30, 40, 50, 60, 80, 100] { XCTAssertTrue(values.contains { $0 >= threshold }, "\(threshold)") }
        XCTAssertTrue(values[53...55].allSatisfy { $0 == 0 }, "a full stop before rolling again")
        XCTAssertEqual(RideEngine.demoSpeedKmh(at: 76 + 9), RideEngine.demoSpeedKmh(at: 9), accuracy: 0.0001, "loops")
        XCTAssertLessThan(values[1...35].enumerated().filter { $0.offset > 0 && $0.element < values[$0.offset] }.count, 1, "monotonic climb to the top speed")
    }

    /// Cold start must not flash white: the launch screen's colour asset exists and matches the cockpit ink.
    func testLaunchScreenUsesDarkColorAssetMatchingCockpit() throws {
        let launch = try XCTUnwrap(Bundle.main.infoDictionary?["UILaunchScreen"] as? [String: Any])
        let name = try XCTUnwrap(launch["UIColorName"] as? String)
        let color = try XCTUnwrap(UIColor(named: name, in: .main, compatibleWith: UITraitCollection(userInterfaceStyle: .light)), "missing colour asset \(name) falls back to white")
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        XCTAssertTrue(color.getRed(&r, green: &g, blue: &b, alpha: &a))
        XCTAssertEqual(r * 255, 0x0B, accuracy: 1); XCTAssertEqual(g * 255, 0x0A, accuracy: 1); XCTAssertEqual(b * 255, 0x12, accuracy: 1); XCTAssertEqual(a, 1)
    }

    func testPortraitAndBothLandscapesSupportedNeverUpsideDownAndVersion() {
        let info = Bundle.main.infoDictionary ?? [:]
        let orientations = Set(info["UISupportedInterfaceOrientations"] as? [String] ?? [])
        XCTAssertEqual(orientations, ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"])
        XCTAssertEqual(info["CFBundleShortVersionString"] as? String, "0.5.0"); XCTAssertEqual(info["CFBundleVersion"] as? String, "5")
    }
}
