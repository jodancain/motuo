import Foundation

/// One line of index.jsonl: a sealed CSV chunk or a closed audio segment. Source of truth for manifest rebuild.
struct RoadlogIndexEntry: Codable, Equatable, Sendable {
    var type: String                // chunk | audio
    var stream: String?
    var seq: Int
    var file: String
    var rows: Int?
    var tStart: Double
    var tEnd: Double
    var bytes: Int
    var uncompressedBytes: Int?
    var sha256: String
    var recovered: Bool
    enum CodingKeys: String, CodingKey {
        case type, stream, seq, file, rows, bytes, sha256, recovered
        case tStart = "t_start", tEnd = "t_end", uncompressedBytes = "uncompressed_bytes"
    }
}

enum RoadlogLog: String, CaseIterable, Sendable { case events, device, clock, accessory }

struct RoadlogLiveStats: Equatable, Sendable {
    var bytes = 0
    var motionHz: Double?
    var degradationLevel = 0
}

enum RoadlogError: LocalizedError {
    case write(String)
    var errorDescription: String? { if case let .write(message) = self { return message }; return nil }
}

/// Serial, batched writer for one roadlog package. Sensor callbacks only enqueue; formatting, IO and gzip happen on
/// the writer's own utility queue. A crash loses at most the in-memory second; open chunks are plain `.part` CSV.
final class RoadlogPackageWriter: @unchecked Sendable {
    let directory: URL
    let packageId: String
    let simulated: Bool
    private let queue = DispatchQueue(label: "cn.yundongyl.motuo.roadlog.writer", qos: .utility)
    private let chunkSpan: Double
    private let chunkLimit: Int
    private var streams: [String: StreamState] = [:]
    private var logs: [RoadlogLog: LogFile] = [:]
    private var index: FileHandle?
    private var mapping: RoadlogClockMapping
    private var pausedAt: Double?
    private var failure: String?
    private var sealed = false
    private var timer: DispatchSourceTimer?
    private let statsLock = NSLock()
    private var _stats = RoadlogLiveStats()
    private var committedBytes = 0
    private var motionWindow: (t: Double, rows: Int)?
    private var motionRows = 0

    var stats: RoadlogLiveStats { statsLock.lock(); defer { statsLock.unlock() }; return _stats }
    var errorMessage: String? { queue.sync { failure } }

    /// Creates the package and writes session.json, README.md and the "recording" manifest synchronously.
    init(root: URL, session: [String: Any], packageId: String, mapping: RoadlogClockMapping,
         chunkSpan: Double = Roadlog.chunkSpanS, chunkLimit: Int = Roadlog.chunkBytes, flushInterval: Double = 1) throws {
        directory = root.appendingPathComponent(packageId, isDirectory: true)
        self.packageId = packageId; self.mapping = mapping
        self.chunkSpan = chunkSpan; self.chunkLimit = chunkLimit
        simulated = session["provenance"] as? String == "simulated"
        let fm = FileManager.default
        try fm.createDirectory(at: directory.appendingPathComponent("streams"), withIntermediateDirectories: true)
        Self.protect(root); Self.protect(directory)
        try RoadlogJSON.data(session).write(to: directory.appendingPathComponent("session.json"), options: .atomic)
        try Data(RoadlogReadme.text.utf8).write(to: directory.appendingPathComponent("README.md"), options: .atomic)
        for log in RoadlogLog.allCases { logs[log] = try LogFile(url: directory.appendingPathComponent(log.rawValue + ".jsonl")) }
        index = try Self.appendHandle(directory.appendingPathComponent("index.jsonl"))
        queue.sync {
            writeLog(.clock, ["type": "clock", "source": "app", "reason": "start", "t_mono": mapping.mono, "t_unix": mapping.unix])
            flushLogs()
        }
        try RoadlogManifestBuilder.write(try RoadlogManifestBuilder.build(directory: directory, status: "recording", verify: false), to: directory)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + flushInterval, repeating: flushInterval)
        timer.setEventHandler { [weak self] in self?.periodicFlush() }
        timer.resume(); self.timer = timer
    }
    deinit { timer?.cancel() }

    // MARK: input (any thread)

    func append(_ stream: String, _ values: [Double?]) {
        queue.async { [self] in appendLocked(stream, values) }
    }
    func appendBatch(_ stream: String, _ rows: [[Double?]]) {
        queue.async { [self] in for row in rows { appendLocked(stream, row) } }
    }
    /// Adds t_mono/t_unix when absent (t_unix derived from the latest clock mapping) and `source` default "app".
    func log(_ file: RoadlogLog, _ object: [String: Any]) {
        queue.async { [self] in writeLog(file, object) }
    }
    func clock(_ value: RoadlogClockMapping, reason: String) {
        queue.async { [self] in
            mapping = value
            writeLog(.clock, ["type": "clock", "source": "app", "reason": reason, "t_mono": value.mono, "t_unix": value.unix])
        }
    }
    /// recorded | unsupported | unavailable | disabled | degraded — the latest one wins in the manifest.
    func streamStatus(_ stream: String, _ status: String, reason: String?, t: Double = ProcessInfo.processInfo.systemUptime, extra: [String: Any] = [:]) {
        var object: [String: Any] = ["type": "stream_status", "source": "app", "stream": stream, "status": status, "t_mono": t]
        if let reason { object["reason"] = reason }
        object.merge(extra) { _, new in new }
        log(.events, object)
    }
    func pause(t: Double) { queue.async { [self] in pausedAt = t } }
    func resume(t: Double) {
        queue.async { [self] in
            if let start = pausedAt { writeLog(.events, ["type": "gap", "source": "app", "stream": "*", "t_start": start, "t_end": t, "t_mono": t, "reason": "paused"]) }
            pausedAt = nil
            for state in streams.values { state.suppressGap = true }
        }
    }
    func audioSegment(seq: Int, file: String, tStart: Double, tEnd: Double) {
        queue.async { [self] in
            let url = directory.appendingPathComponent(file)
            guard let data = try? Data(contentsOf: url) else { return }
            appendIndex(.init(type: "audio", stream: nil, seq: seq, file: file, rows: nil, tStart: tStart, tEnd: tEnd, bytes: data.count, uncompressedBytes: nil, sha256: Roadlog.sha256(data), recovered: false))
            committedBytes += data.count
        }
    }
    func setDegradation(_ level: Int) { statsLock.lock(); _stats.degradationLevel = level; statsLock.unlock() }

    /// Flushes, seals every open chunk, writes the final manifest. Synchronous; call off the main thread.
    @discardableResult func seal(end: RoadlogClockMapping) throws -> [String: Any] {
        try queue.sync {
            timer?.cancel(); timer = nil
            if !sealed {
                mapping = end
                writeLog(.clock, ["type": "clock", "source": "app", "reason": "end", "t_mono": end.mono, "t_unix": end.unix])
                for state in streams.values.sorted(by: { $0.spec.name < $1.spec.name }) { sealChunk(state) }
                flushLogs()
                for log in logs.values { log.close() }
                try? index?.synchronize(); try? index?.close(); index = nil
                sealed = true
            }
            if let failure { throw RoadlogError.write(failure) }
            let manifest = try RoadlogManifestBuilder.build(directory: directory, status: "sealed", verify: true)
            try RoadlogManifestBuilder.write(manifest, to: directory)
            return manifest
        }
    }
    /// Test hook: drains the queue (flushes buffers to .part files) without sealing.
    func drain() { queue.sync { flushBuffers(); flushLogs() } }

    // MARK: queue-confined

    private func appendLocked(_ name: String, _ values: [Double?]) {
        guard failure == nil, !sealed, let t = values.first ?? nil, t.isFinite else { return }
        let state: StreamState
        if let existing = streams[name] { state = existing }
        else {
            guard let spec = RoadlogStreams.spec(name), values.count == spec.columns.count else { return }
            state = StreamState(spec: spec); streams[name] = state
        }
        guard values.count == state.spec.columns.count else { return }
        if let last = state.lastT {
            if t < last { state.dropped += 1; return }
            if let threshold = state.spec.gapThresholdS, !state.suppressGap, pausedAt == nil, t - last > threshold {
                writeLog(.events, ["type": "gap", "source": "app", "stream": name, "t_start": last, "t_end": t, "t_mono": t,
                                   "reason": name == "location" ? "gps_lost" : "sensor_stall"])
            }
        }
        state.suppressGap = false; state.lastT = t
        do {
            if let start = state.chunkStart, t - start >= chunkSpan || state.chunkBytes >= chunkLimit { sealChunk(state) }
            if state.chunkStart == nil { try openChunk(state, t: t) }
            let line = RoadlogCSV.row(values, columns: state.spec.columns)
            let bytes = Data(line.utf8)
            state.buffer.append(bytes); state.chunkRows += 1; state.chunkBytes += bytes.count; state.chunkEnd = t
            if state.buffer.count >= 64 * 1024 { try writeBuffer(state) }
            if name == "motion" { motionRows += 1; if motionWindow == nil { motionWindow = (t, motionRows) } }
        } catch { fail(error) }
    }
    private func openChunk(_ state: StreamState, t: Double) throws {
        state.seq += 1
        let folder = directory.appendingPathComponent("streams/\(state.spec.name)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(String(format: "%06d.csv.part", state.seq))
        let header = Data((state.spec.header + "\n").utf8)
        try header.write(to: url)
        state.part = try FileHandle(forWritingTo: url); try state.part?.seekToEnd(); state.partURL = url
        state.chunkStart = t; state.chunkRows = 0; state.chunkBytes = header.count
    }
    private func writeBuffer(_ state: StreamState) throws {
        guard !state.buffer.isEmpty, let part = state.part else { return }
        try part.write(contentsOf: state.buffer); state.buffer.removeAll(keepingCapacity: true)
    }
    private func sealChunk(_ state: StreamState) {
        guard let url = state.partURL, let start = state.chunkStart else { return }
        do {
            try writeBuffer(state); try state.part?.close(); state.part = nil
            if state.chunkRows > 0 {
                let entry = try Self.sealPart(url, stream: state.spec.name, seq: state.seq, directory: directory,
                                              rows: state.chunkRows, tStart: start, tEnd: state.chunkEnd, recovered: false)
                appendIndex(entry); committedBytes += entry.bytes
            }
            try? FileManager.default.removeItem(at: url)
        } catch { fail(error) }
        state.partURL = nil; state.chunkStart = nil; state.chunkRows = 0; state.chunkBytes = 0
    }
    private func appendIndex(_ entry: RoadlogIndexEntry) {
        do {
            let line = try JSONEncoder.roadlog.encode(entry) + Data([0x0a])
            try index?.write(contentsOf: line); try index?.synchronize()
        } catch { fail(error) }
    }
    private func writeLog(_ file: RoadlogLog, _ object: [String: Any]) {
        var value = object
        let t = (value["t_mono"] as? Double) ?? ProcessInfo.processInfo.systemUptime
        value["t_mono"] = t
        if value["t_unix"] == nil { value["t_unix"] = mapping.unix(forMono: t) }
        if value["source"] == nil { value["source"] = "app" }
        if simulated, let source = value["source"] as? String, source == "measured" || source == "inferred" { value["source"] = "simulated" }
        do { try logs[file]?.append(value) } catch { fail(error) }
    }
    private func periodicFlush() {
        flushBuffers(); flushLogs()
        var hz: Double?
        if let window = motionWindow, let last = streams["motion"]?.lastT, last > window.t {
            hz = Double(motionRows - window.rows) / (last - window.t)
        }
        motionWindow = streams["motion"]?.lastT.map { ($0, motionRows) }
        let pending = streams.values.reduce(0) { $0 + $1.chunkBytes } + logs.values.reduce(0) { $0 + $1.bytes }
        statsLock.lock(); _stats.bytes = committedBytes + pending; if let hz { _stats.motionHz = hz } else if streams["motion"] == nil { _stats.motionHz = nil }; statsLock.unlock()
    }
    private func flushBuffers() { for state in streams.values { do { try writeBuffer(state) } catch { fail(error) } } }
    private func flushLogs() { for log in logs.values { do { try log.flush() } catch { fail(error) } } }
    private func fail(_ error: Error) { if failure == nil { failure = "路谱写入失败：\(error.localizedDescription)" } }

    // MARK: shared with recovery

    /// gzip → temp → atomic rename → hash. The caller appends the index line and then deletes the .part.
    static func sealPart(_ url: URL, stream: String, seq: Int, directory: URL, rows: Int, tStart: Double, tEnd: Double, recovered: Bool) throws -> RoadlogIndexEntry {
        let raw = try Data(contentsOf: url)
        let gz = try RoadlogGzip.compress(raw)
        let relative = "streams/\(stream)/" + String(format: "%06d.csv.gz", seq)
        let target = directory.appendingPathComponent(relative), temp = target.appendingPathExtension("tmp")
        try gz.write(to: temp)
        if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
        try FileManager.default.moveItem(at: temp, to: target)
        return .init(type: "chunk", stream: stream, seq: seq, file: relative, rows: rows, tStart: tStart, tEnd: tEnd,
                     bytes: gz.count, uncompressedBytes: raw.count, sha256: Roadlog.sha256(gz), recovered: recovered)
    }
    static func appendHandle(_ url: URL) throws -> FileHandle {
        if !FileManager.default.fileExists(atPath: url.path) { try Data().write(to: url) }
        let handle = try FileHandle(forWritingTo: url); try handle.seekToEnd(); return handle
    }
    /// Lock-screen writable while recording; large data stays out of device backups (it goes to iCloud Drive instead).
    static func protect(_ url: URL) {
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var mutable = url; try? mutable.setResourceValues(values)
    }

    private final class StreamState {
        let spec: RoadlogStreamSpec
        var seq = 0
        var part: FileHandle?
        var partURL: URL?
        var buffer = Data()
        var chunkStart: Double?
        var chunkEnd = 0.0
        var chunkRows = 0
        var chunkBytes = 0
        var lastT: Double?
        var dropped = 0
        var suppressGap = false
        init(spec: RoadlogStreamSpec) { self.spec = spec }
    }
    private final class LogFile {
        let handle: FileHandle
        var buffer = Data()
        var bytes = 0
        init(url: URL) throws { handle = try RoadlogPackageWriter.appendHandle(url) }
        func append(_ object: [String: Any]) throws {
            let line = try RoadlogJSON.line(object); buffer.append(line); bytes += line.count
        }
        func flush() throws { guard !buffer.isEmpty else { return }; try handle.write(contentsOf: buffer); buffer.removeAll(keepingCapacity: true) }
        func close() { try? flush(); try? handle.synchronize(); try? handle.close() }
    }
}

enum RoadlogJSON {
    static func data(_ object: Any, pretty: Bool = true) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes])
    }
    static func line(_ object: [String: Any]) throws -> Data { try data(object, pretty: false) + Data([0x0a]) }
    static func object(_ data: Data) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] }
    /// Complete lines only; a crash-truncated final line (no "\n") is ignored.
    static func lines(_ url: URL) -> [[String: Any]] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        var result: [[String: Any]] = []
        var start = data.startIndex
        while let newline = data[start...].firstIndex(of: 0x0a) {
            if newline > start, let object = object(data[start..<newline]) { result.append(object) }
            start = data.index(after: newline)
        }
        return result
    }
}

extension JSONEncoder {
    static var roadlog: JSONEncoder { let e = JSONEncoder(); e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]; return e }
}
