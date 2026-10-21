import Foundation
import CryptoKit

struct TelemetryChunk: Codable, Identifiable {
    var sequence: Int; var sha256: String; var bytes: Int; var samples: Int
    var id: Int { sequence }
}

/// Append-only, serial writer. A crash may lose the last incomplete JSON line, never a committed chunk.
final class TelemetryJournal: @unchecked Sendable {
    let directory: URL
    private let queue = DispatchQueue(label: "cn.yundongyl.motuo.telemetry", qos: .utility)
    private var handle: FileHandle?
    private var pendingBytes = 0
    private var pendingSamples = 0
    private var openedAt = Date()
    private var chunks: [TelemetryChunk] = []
    private var failure: String?
    private let chunkLimit: Int
    private let encoder = MotuoJSON.encoder()
    var errorMessage: String? { queue.sync { failure } }
    var committedChunks: [TelemetryChunk] { queue.sync { chunks } }
    static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Rides", isDirectory: true)
    }
    init(rideId: UUID, root: URL = TelemetryJournal.root, chunkLimit: Int = 512 * 1024) throws {
        directory = root.appendingPathComponent(rideId.uuidString, isDirectory: true)
        self.chunkLimit = min(chunkLimit, 4 * 1024 * 1024)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication],ofItemAtPath:directory.path)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var mutableURL = directory; try mutableURL.setResourceValues(values)
        try recover()
    }
    func append(_ sample: TelemetrySample) {
        queue.async { [self] in
            guard failure == nil else { return }
            do {
                let line = try encoder.encode(sample) + Data([0x0a])
                if pendingBytes > 0, pendingBytes + line.count > chunkLimit { try commit() }
                try ensureHandle()
                try handle?.write(contentsOf: line)
                pendingBytes += line.count; pendingSamples += 1
                if pendingSamples % 50 == 0 { try handle?.synchronize() }
                if pendingBytes >= chunkLimit || Date().timeIntervalSince(openedAt) >= 15 { try commit() }
            } catch { failure = "遥测写入失败：\(error.localizedDescription)" }
        }
    }
    @discardableResult func flush() throws -> [TelemetryChunk] {
        try queue.sync {
            if let failure { throw JournalError.write(failure) }
            try commit(); return chunks
        }
    }
    /// An explicit user retry may recover a failed writer without replacing its journal.
    /// Known committed blocks are verified before the existing complete-tail recovery runs.
    @discardableResult func flushRecoveringAfterFailure() throws -> [TelemetryChunk] {
        try queue.sync {
            do {
                if failure != nil {
                    try? handle?.close(); handle = nil
                    for chunk in chunks {
                        let bytes = try Data(contentsOf: directory.appendingPathComponent("\(chunk.sequence).jsonl"))
                        guard bytes.count == chunk.bytes, Self.hash(bytes) == chunk.sha256 else { throw JournalError.write("已提交数据块校验不符，请保留本机资料") }
                    }
                    chunks = []; pendingBytes = 0; pendingSamples = 0
                    try recover()
                } else { try commit() }
                failure = nil
                return chunks
            } catch {
                failure = "遥测恢复未完成：\(error.localizedDescription)"
                throw JournalError.write(failure!)
            }
        }
    }
    func data(for chunk: TelemetryChunk) throws -> Data {
        try Data(contentsOf: directory.appendingPathComponent("\(chunk.sequence).jsonl"))
    }
    private func ensureHandle() throws {
        guard handle == nil else { return }
        let url = directory.appendingPathComponent("pending.partial")
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        handle = try FileHandle(forWritingTo: url); try handle?.seekToEnd(); openedAt = Date()
    }
    private func commit() throws {
        guard pendingBytes > 0 else { return }
        try handle?.synchronize(); try handle?.close(); handle = nil
        let pending = directory.appendingPathComponent("pending.partial")
        let data = try Data(contentsOf: pending)
        let sequence = (chunks.last?.sequence ?? -1) + 1
        try FileManager.default.moveItem(at: pending, to: directory.appendingPathComponent("\(sequence).jsonl"))
        chunks.append(.init(sequence: sequence, sha256: Self.hash(data), bytes: data.count, samples: pendingSamples))
        pendingBytes = 0; pendingSamples = 0
        try encoder.encode(chunks).write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
    }
    private func recover() throws {
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        let completed = files.compactMap { url -> (Int, URL)? in
            guard url.pathExtension == "jsonl", let sequence = Int(url.deletingPathExtension().lastPathComponent), sequence >= 0 else { return nil }
            return (sequence, url)
        }.sorted { $0.0 < $1.0 }
        guard Set(completed.map { $0.0 }).count == completed.count else { throw JournalError.write("遥测块序号重复，请保留原始文件") }
        let manifest = directory.appendingPathComponent("manifest.json")
        var confirmed: [TelemetryChunk] = []
        if FileManager.default.fileExists(atPath: manifest.path) {
            do { confirmed = try MotuoJSON.decoder().decode([TelemetryChunk].self, from: Data(contentsOf: manifest)) }
            catch { throw JournalError.write("已确认数据清单无法读取，请保留原始文件") }
            guard confirmed.enumerated().allSatisfy({ $0.offset == $0.element.sequence && $0.element.bytes > 0 && $0.element.bytes <= 4*1024*1024 && $0.element.samples > 0 }) else { throw JournalError.write("已确认数据清单无效，请保留原始文件") }
        }
        // A confirmed checksum is evidence: never replace it with a new checksum of altered data.
        for chunk in confirmed {
            guard let url = completed.first(where: { $0.0 == chunk.sequence })?.1 else { throw JournalError.write("已确认遥测块缺失，请保留其余原始文件") }
            let data = try Data(contentsOf: url)
            guard data.count == chunk.bytes, Self.hash(data) == chunk.sha256 else { throw JournalError.write("已确认遥测块校验失败，请保留原始文件") }
        }
        chunks = confirmed
        // A crash may occur after moving a complete block but before saving the manifest.
        for (sequence, url) in completed where sequence >= confirmed.count {
            guard sequence == chunks.count else { throw JournalError.write("遥测块序号不连续，请保留原始文件") }
            let data = try Data(contentsOf: url)
            let count = try validCompleteRows(data)
            chunks.append(.init(sequence: sequence, sha256: Self.hash(data), bytes: data.count, samples: count))
        }
        let pending = directory.appendingPathComponent("pending.partial")
        if FileManager.default.fileExists(atPath: pending.path) {
            let data = try Data(contentsOf: pending)
            if let lastNewline = data.lastIndex(of: 10) {
                let complete = Data(data[...lastNewline])
                let count = try validCompleteRows(complete)
                try complete.write(to: pending, options: .atomic)
                pendingBytes = complete.count; pendingSamples = count
                try commit()
            } else { try FileManager.default.removeItem(at: pending) }
        }
        try encoder.encode(chunks).write(to: manifest, options: .atomic)
    }
    private func validCompleteRows(_ data: Data) throws -> Int {
        guard !data.isEmpty, data.count <= 4*1024*1024, data.last == 10 else { throw JournalError.write("未确认遥测块不完整，请保留原始文件") }
        let decoder = MotuoJSON.decoder()
        let rows = data.split(separator: 10)
        for row in rows { _ = try decoder.decode(TelemetrySample.self, from: Data(row)) }
        return rows.count
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func routeSamples(rideId: UUID, root: URL = root) -> [TelemetrySample] {
        let dir = root.appendingPathComponent(rideId.uuidString, isDirectory: true)
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        let decoder = MotuoJSON.decoder()
        var result: [TelemetrySample] = []; var lastTime = -Double.infinity
        let latitudeKey = Data("\"latitude\"".utf8)
        for url in files.filter({ $0.pathExtension == "jsonl" }).sorted(by: { (Int($0.deletingPathExtension().lastPathComponent) ?? 0) < (Int($1.deletingPathExtension().lastPathComponent) ?? 0) }) {
            guard let data = try? Data(contentsOf: url) else { continue }
            for line in data.split(separator: 10) {
                // Motion rows (~50 Hz) carry no coordinates; skip them before the comparatively slow JSON decode.
                guard line.range(of: latitudeKey) != nil,
                      let sample = try? decoder.decode(TelemetrySample.self, from: Data(line)),
                      sample.latitude != nil, sample.longitude != nil else { continue }
                if sample.monotonicS < lastTime { lastTime = -.infinity }
                guard sample.monotonicS - lastTime >= 0.9 else { continue }
                result.append(sample); lastTime = sample.monotonicS
            }
        }
        return result
    }
    enum JournalError: LocalizedError { case write(String); var errorDescription: String? { if case let .write(s) = self { return s }; return nil } }
}
