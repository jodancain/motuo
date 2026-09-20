import Foundation
import Observation

/// Each label belongs to the original inferred event window, never the later feedback tap.
struct LearningRideInput: Sendable {
    var id: UUID; var vehicleId: UUID; var calibrationId: UUID?; var startedAt: Date
    var source: String; var finished: Bool; var dataVersion: Int; var events: [RideEvent]
}
struct LearningExample: Codable, Sendable {
    var rideId: UUID; var eventId: UUID; var calibrationId: UUID
    var windowStart: Date; var windowEnd: Date; var confirmed: Bool
    var peakJerk: Double; var vibrationRMS: Double; var samples: Int
}
struct LearningCheck: Codable, Sendable {
    var truePositive: Int = 0; var trueNegative: Int = 0; var falsePositive: Int = 0; var falseNegative: Int = 0
    var balancedScore: Double {
        let positives = truePositive + falseNegative, negatives = trueNegative + falsePositive
        guard positives > 0, negatives > 0 else { return 0 }
        return (Double(truePositive) / Double(positives) + Double(trueNegative) / Double(negatives)) / 2
    }
}
struct VehicleLearningVersion: Codable, Identifiable, Sendable {
    var id: UUID = UUID(); var vehicleId: UUID; var calibrationId: UUID; var version: Int; var createdAt: Date = Date()
    var jerkThreshold: Double; var vibrationRMS: Double
    var trainingRideIds: [UUID]; var holdoutRideIds: [UUID]; var rideDataVersions: [String: Int]
    var trainingExamples: Int; var holdoutExamples: Int; var check: LearningCheck
    var invalidated = false
}
struct LearningCollection: Sendable { var examples: [LearningExample]; var inputs: [LearningRideInput]; var skippedRides: Int }

enum VehicleLearningMath {
    static let defaultThreshold = 22.0
    /// Offline collection checks recorded chunks and retains only original, human-reviewed windows.
    static func collect(inputs: [LearningRideInput], calibrationId: UUID, root: URL) -> LearningCollection {
        var examples: [LearningExample] = []; var eligible: [LearningRideInput] = []; var skipped = 0
        for input in inputs where input.finished && input.source == "measured" && input.calibrationId == calibrationId {
            let events = input.events.filter { $0.source == "inferred" && $0.kind == "suspectedShift" && ["confirmed", "rejected"].contains($0.feedback ?? "") && $0.windowStart <= $0.timestamp && $0.windowEnd >= $0.timestamp && $0.windowEnd.timeIntervalSince($0.windowStart) <= 10 }
            guard !events.isEmpty else { continue }
            guard Set(events.map(\.id)).count == events.count else { skipped += 1; continue }
            let folder = root.appendingPathComponent(input.id.uuidString, isDirectory: true)
            do {
                let decoder = MotuoJSON.decoder()
                let chunks = try decoder.decode([TelemetryChunk].self, from: Data(contentsOf: folder.appendingPathComponent("manifest.json")))
                guard !chunks.isEmpty, Set(chunks.map(\.sequence)).count == chunks.count else { skipped += 1; continue }
                var windows = Dictionary(uniqueKeysWithValues: events.map { ($0.id, [TelemetrySample]()) })
                for chunk in chunks.sorted(by: { $0.sequence < $1.sequence }) {
                    guard chunk.bytes <= 4 * 1024 * 1024 else { throw LearningError.invalidData }
                    let bytes = try Data(contentsOf: folder.appendingPathComponent("\(chunk.sequence).jsonl"))
                    guard bytes.count == chunk.bytes, TelemetryJournal.hash(bytes) == chunk.sha256 else { throw LearningError.invalidData }
                    for line in bytes.split(separator: 10) {
                        let sample = try decoder.decode(TelemetrySample.self, from: Data(line))
                        guard sample.source == "measured", sample.stream == "motion", sample.quality == "valid", sample.calibrationId == calibrationId.uuidString else { continue }
                        for event in events where sample.timestamp >= event.windowStart && sample.timestamp <= event.windowEnd { windows[event.id, default: []].append(sample) }
                    }
                }
                for event in events {
                    if let feature = features(samples: windows[event.id] ?? [], event: event, rideId: input.id, calibrationId: calibrationId) { examples.append(feature) }
                }
                eligible.append(input)
            } catch { skipped += 1 }
        }
        return .init(examples: examples, inputs: eligible, skippedRides: skipped)
    }
    static func features(samples: [TelemetrySample], event: RideEvent, rideId: UUID, calibrationId: UUID) -> LearningExample? {
        let values = samples.filter { $0.source == "measured" && $0.stream == "motion" && $0.quality == "valid" && $0.calibrationId == calibrationId.uuidString && $0.timestamp >= event.windowStart && $0.timestamp <= event.windowEnd }.sorted { $0.timestamp < $1.timestamp }
        guard event.source == "inferred", event.kind == "suspectedShift", ["confirmed", "rejected"].contains(event.feedback ?? ""), values.count >= 30,
              let first = values.first, let last = values.last, last.timestamp.timeIntervalSince(first.timestamp) >= 1 else { return nil }
        var previous: (Double, Double, String)?; var peak = 0.0; var sum = 0.0; var count = 0; var pairs = 0
        for sample in values {
            guard let segment = sample.segmentId, let ax = sample.accelerationX, let ay = sample.accelerationY, let az = sample.accelerationZ,
                  let rx = sample.rotationX, let ry = sample.rotationY, let rz = sample.rotationZ,
                  [ax,ay,az,rx,ry,rz,sample.monotonicS].allSatisfy(\.isFinite) else { previous = nil; continue }
            let acceleration = sqrt(ax*ax + ay*ay + az*az), rotation = sqrt(rx*rx + ry*ry + rz*rz)
            if let prior = previous, prior.2 == segment {
                let dt = sample.monotonicS - prior.1
                if dt > 0, dt < 0.25 {
                    pairs += 1
                    if acceleration > 1.3, rotation < 0.18 { peak = max(peak, abs(acceleration - prior.0) / dt) }
                }
            }
            previous = (acceleration, sample.monotonicS, segment); sum += acceleration * acceleration; count += 1
        }
        guard count >= 30, pairs >= 25, peak.isFinite else { return nil }
        return .init(rideId: rideId, eventId: event.id, calibrationId: calibrationId, windowStart: event.windowStart, windowEnd: event.windowEnd, confirmed: event.feedback == "confirmed", peakJerk: peak, vibrationRMS: sqrt(sum / Double(count)), samples: count)
    }
    static func check(_ examples: [LearningExample], threshold: Double) -> LearningCheck {
        var result = LearningCheck()
        for example in examples {
            let detected = example.peakJerk > threshold
            switch (detected, example.confirmed) {
            case (true, true): result.truePositive += 1
            case (false, false): result.trueNegative += 1
            case (true, false): result.falsePositive += 1
            case (false, true): result.falseNegative += 1
            }
        }
        return result
    }
    static func candidate(_ collection: LearningCollection, vehicleId: UUID, calibrationId: UUID, version: Int) throws -> VehicleLearningVersion {
        let eligibleInputs = collection.inputs.filter { $0.vehicleId == vehicleId && $0.calibrationId == calibrationId && $0.source == "measured" && $0.finished }
        let rideIDs = Set(eligibleInputs.map(\.id))
        let examples = collection.examples.filter { $0.calibrationId == calibrationId && rideIDs.contains($0.rideId) && $0.peakJerk.isFinite && $0.vibrationRMS.isFinite }
        let usedIDs = Set(examples.map(\.rideId))
        let ordered = eligibleInputs.filter { usedIDs.contains($0.id) }.sorted { $0.startedAt < $1.startedAt }
        guard ordered.count >= 4, examples.count >= 12, let last = ordered.last else { throw LearningError.insufficient }
        // The newest complete ride is never used for fitting or threshold selection.
        let holdout = examples.filter { $0.rideId == last.id }, training = examples.filter { $0.rideId != last.id }
        guard training.filter(\.confirmed).count >= 3, training.filter({ !$0.confirmed }).count >= 3,
              holdout.contains(where: \.confirmed), holdout.contains(where: { !$0.confirmed }) else { throw LearningError.insufficient }
        let thresholds = (18...40).map(Double.init)
        let chosen = thresholds.sorted {
            let a = check(training, threshold: $0).balancedScore, b = check(training, threshold: $1).balancedScore
            return a == b ? abs($0-defaultThreshold) < abs($1-defaultThreshold) : a > b
        }.first ?? defaultThreshold
        let evaluation = check(holdout, threshold: chosen)
        guard evaluation.balancedScore >= check(holdout, threshold: defaultThreshold).balancedScore,
              evaluation.truePositive > 0, evaluation.trueNegative > 0 else { throw LearningError.noImprovement }
        let baseline = training.map(\.vibrationRMS).sorted()
        return .init(vehicleId: vehicleId, calibrationId: calibrationId, version: version, jerkThreshold: chosen,
                     vibrationRMS: baseline[baseline.count / 2], trainingRideIds: ordered.dropLast().map(\.id), holdoutRideIds: [last.id],
                     rideDataVersions: Dictionary(uniqueKeysWithValues: ordered.map { ($0.id.uuidString, $0.dataVersion) }),
                     trainingExamples: training.count, holdoutExamples: holdout.count, check: evaluation)
    }
    enum LearningError: LocalizedError {
        case insufficient, noImprovement, invalidData
        var errorDescription: String? {
            switch self {
            case .insufficient: "继续收集：同一校准至少 4 次实测骑行、12 个确认或拒绝片段；训练至少各 3 个，最新骑行至少各 1 个。"
            case .noImprovement: "保留默认阈值：新阈值未通过最新整次骑行的独立检查，继续收集。"
            case .invalidData: "记录校验失败，未参与学习。"
            }
        }
    }
}

@MainActor @Observable final class VehicleLearningService {
    static let shared = VehicleLearningService()
    private struct Storage: Codable { var versions: [VehicleLearningVersion] = []; var active: [String: UUID] = [:] }
    private var storage = Storage()
    private var generation = UUID()
    private let file: URL
    private(set) var busy = false
    private(set) var status = "仅学习停车后人工确认的原始片段；当前阈值仍是实验性候选检测。"
    private(set) var exampleCount = 0
    var versions: [VehicleLearningVersion] { storage.versions }
    init(file: URL? = nil) {
        self.file = file ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("vehicle-learning.json")
        storage = (try? JSONDecoder().decode(Storage.self, from: Data(contentsOf: self.file))) ?? Storage()
    }
    func active(vehicleId: UUID, calibrationId: UUID?) -> VehicleLearningVersion? {
        guard let calibrationId, let id = storage.active[calibrationId.uuidString] else { return nil }
        return storage.versions.first { $0.id == id && $0.vehicleId == vehicleId && $0.calibrationId == calibrationId && !$0.invalidated }
    }
    func use(_ version: VehicleLearningVersion) throws {
        guard storage.versions.contains(where: { $0.id == version.id && !$0.invalidated }) else { return }
        var updated = storage; updated.active[version.calibrationId.uuidString] = version.id; try save(updated)
    }
    func useDefault(calibrationId: UUID) throws { var updated = storage; updated.active.removeValue(forKey: calibrationId.uuidString); try save(updated) }
    func invalidate(rideId: UUID, remove: Bool = false) throws {
        generation = UUID(); busy = false
        var updated = storage
        let affected = Set(updated.versions.filter { $0.rideDataVersions[rideId.uuidString] != nil }.map(\.id))
        updated.active = updated.active.filter { !affected.contains($0.value) }
        if remove { updated.versions.removeAll { affected.contains($0.id) } }
        else { for index in updated.versions.indices where affected.contains(updated.versions[index].id) { updated.versions[index].invalidated = true } }
        try save(updated)
    }
    func eraseAll() throws {
        generation = UUID(); busy = false
        if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        storage = Storage(); exampleCount = 0; status = "个人学习资料已清除。"
    }
    func build(vehicleId: UUID, calibrationId: UUID, inputs: [LearningRideInput], root: URL = TelemetryJournal.root) async {
        guard !busy else { return }
        busy = true; let current = UUID(); generation = current; status = "核对原始窗口与整次骑行划分…"
        let collection = await Task.detached(priority: .utility) { VehicleLearningMath.collect(inputs: inputs, calibrationId: calibrationId, root: root) }.value
        guard generation == current else { return }
        defer { busy = false }
        exampleCount = collection.examples.count
        do {
            let version = (storage.versions.filter { $0.vehicleId == vehicleId }.map(\.version).max() ?? 0) + 1
            let candidate = try VehicleLearningMath.candidate(collection, vehicleId: vehicleId, calibrationId: calibrationId, version: version)
            var updated = storage; updated.versions.append(candidate); try save(updated)
            status = "候选 v\(version) 已生成，启用后从下次骑行生效。\(collection.skippedRides > 0 ? "有 \(collection.skippedRides) 次记录校验未通过，已跳过。" : "")尚未验证真实换挡识别准确率。"
        } catch { status = error.localizedDescription }
    }
    private func save(_ updated: Storage) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(updated).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); storage = updated
    }
}
