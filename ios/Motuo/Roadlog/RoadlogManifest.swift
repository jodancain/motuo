import Foundation

/// Builds manifest.json purely from what is on disk (session.json, index.jsonl, events/clock JSONL, files), so the
/// normal seal and crash recovery share one code path and a manifest can always be rebuilt.
enum RoadlogManifestBuilder {
    /// Data may outlive the last clock sample by this much (clock samples are every 10 s; recovery after termination).
    static let recoveryMarginS = 3600.0
    static func build(directory: URL, status: String, rebuilt: Bool = false, verify: Bool) throws -> [String: Any] {
        let fm = FileManager.default
        guard let sessionData = try? Data(contentsOf: directory.appendingPathComponent("session.json")),
              let session = RoadlogJSON.object(sessionData) else { throw RoadlogError.write("路谱包缺少 session.json，无法重建：\(directory.lastPathComponent)") }
        let simulated = session["provenance"] as? String == "simulated"
        let index = RoadlogJSON.lines(directory.appendingPathComponent("index.jsonl"))
            .compactMap { try? JSONDecoder().decode(RoadlogIndexEntry.self, from: RoadlogJSON.data($0, pretty: false)) }
        let events = RoadlogJSON.lines(directory.appendingPathComponent("events.jsonl"))
        let clocks = RoadlogJSON.lines(directory.appendingPathComponent("clock.jsonl"))
        var problems: [String] = []

        func clockObject(_ record: [String: Any]?) -> Any {
            guard let record, let mono = record["t_mono"] as? Double, let unix = record["t_unix"] as? Double else { return NSNull() }
            return ["t_mono": mono, "t_unix": unix]
        }
        let first = clocks.first, last = clocks.last
        let startUnix = first?["t_unix"] as? Double ?? (session["startedAtUnix"] as? Double ?? 0)
        var endUnix = last?["t_unix"] as? Double ?? startUnix
        // After a crash the newest clock sample can be older than the newest data; use the latest observed time — but only
        // times on the trusted monotonic clock (within the clock samples' range plus a recovery margin). Schema 1.0 packages
        // recorded abs_altitude on another clock (t ≈ 8e8 s), which once pushed endedAtUTC to 2052.
        let monos = clocks.compactMap { $0["t_mono"] as? Double }
        let trusted = { (t: Double) -> Bool in guard let lo = monos.min(), let hi = monos.max() else { return true }; return t >= lo - 60 && t <= hi + RoadlogManifestBuilder.recoveryMarginS }
        let untrusted = index.filter { $0.type == "chunk" && !(trusted($0.tStart) && trusted($0.tEnd)) }.compactMap(\.stream)
        if !untrusted.isEmpty { problems.append("时钟可疑的流（时间戳不在单调时钟范围内，已不用于结束时间）：\(Set(untrusted).sorted().joined(separator: ", "))") }
        let lastMono = max(index.map(\.tEnd).filter(trusted).max() ?? 0, events.compactMap { $0["t_mono"] as? Double }.filter(trusted).max() ?? 0)
        if let last, let lm = last["t_mono"] as? Double, let lu = last["t_unix"] as? Double, lastMono > lm { endUnix = max(endUnix, lu + (lastMono - lm)) }

        var latestStatus: [String: [String: Any]] = [:]
        for event in events where event["type"] as? String == "stream_status" {
            if let stream = event["stream"] as? String { latestStatus[stream] = event }
        }
        let requested = (session["settings"] as? [String: Any])?["requestedRatesHz"] as? [String: Any] ?? [:]
        var streams: [String: Any] = [:]
        for spec in RoadlogStreams.all {
            let chunks = index.filter { $0.type == "chunk" && $0.stream == spec.name }.sorted { $0.seq < $1.seq }
            let rows = chunks.compactMap(\.rows).reduce(0, +)
            let tStart = chunks.map(\.tStart).min(), tEnd = chunks.map(\.tEnd).max()
            let declared = latestStatus[spec.name]
            var status = declared?["status"] as? String ?? (chunks.isEmpty ? "unavailable" : "recorded")
            var reason: Any = declared?["reason"] ?? (chunks.isEmpty && declared == nil ? "本次骑行没有该流的样本" : NSNull())
            if chunks.isEmpty, status == "recorded" { status = "unavailable"; reason = "已启动但没有收到样本" }
            var entry: [String: Any] = [
                "source": simulated ? "simulated" : spec.source, "status": status, "reason": reason,
                "requestedHz": requested[spec.name] ?? spec.requestedHz as Any? ?? NSNull(),
                "measuredHz": rows > 1 && (tEnd ?? 0) > (tStart ?? 0) ? Double(rows - 1) / (tEnd! - tStart!) : NSNull(),
                "rows": rows, "tStart": tStart as Any? ?? NSNull(), "tEnd": tEnd as Any? ?? NSNull(),
                "columns": spec.columns.map { ["name": $0.name, "unit": $0.unit, "description": $0.description] },
                "frame": spec.frame,
                "chunks": chunks.map(chunkObject),
            ]
            if spec.name == "acoustic" { entry["bandEdgesHz"] = RoadlogStreams.acousticBandEdgesHz }
            if spec.name == "acoustic_lf" { entry["frequenciesHz"] = RoadlogStreams.acousticLFHz }
            if let a = tStart, let b = tEnd, !(trusted(a) && trusted(b)) { entry["clockSuspect"] = true }
            streams[spec.name] = entry
        }
        var files: [String: Any] = [:]
        for name in ["events", "device", "clock", "accessory", "index", "session"] {
            let file = name == "session" ? "session.json" : name + ".jsonl"
            guard let data = try? Data(contentsOf: directory.appendingPathComponent(file)) else { problems.append("缺少 \(file)"); continue }
            files[name] = ["file": file, "lines": data.filter { $0 == 0x0a }.count, "bytes": data.count, "sha256": Roadlog.sha256(data)]
        }
        if verify {
            for entry in index {
                let url = directory.appendingPathComponent(entry.file)
                guard let data = try? Data(contentsOf: url) else { problems.append("缺少文件 \(entry.file)"); continue }
                if data.count != entry.bytes || Roadlog.sha256(data) != entry.sha256 { problems.append("校验不符 \(entry.file)") }
            }
        }
        let audio = index.filter { $0.type == "audio" }.sorted { $0.seq < $1.seq }
        let settings = session["settings"] as? [String: Any] ?? [:]
        let gaps = events.filter { $0["type"] as? String == "gap" }.map { event -> [String: Any] in
            ["stream": event["stream"] ?? "*", "tStart": event["t_start"] ?? NSNull(), "tEnd": event["t_end"] ?? NSNull(), "reason": event["reason"] ?? "unknown"]
        }
        let degradations = events.filter { $0["type"] as? String == "degradation" }.map { event -> [String: Any] in
            ["t_mono": event["t_mono"] ?? NSNull(), "level": event["level"] ?? 0, "action": event["action"] ?? "", "freeBytes": event["freeBytes"] ?? NSNull(), "remainingHours": event["remainingHours"] ?? NSNull(), "reason": event["reason"] ?? "low_storage"]
        }
        var totalBytes = 0, uncompressed = 0
        if let enumerator = fm.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
            for case let url as URL in enumerator where !["manifest.json", "manifest.sha256"].contains(url.lastPathComponent) {
                let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                if values?.isRegularFile == true { totalBytes += values?.fileSize ?? 0 }
            }
        }
        uncompressed = index.compactMap(\.uncompressedBytes).reduce(0, +) + files.values.compactMap { ($0 as? [String: Any])?["bytes"] as? Int }.reduce(0, +)
        let duration: Double = max(0, endUnix - startUnix)
        let perHour: Any = duration > 1 ? Double(totalBytes) / duration * 3600.0 : NSNull()
        return [
            "schema": Roadlog.schema, "schemaVersion": Roadlog.schemaVersion, "schemaMinor": session["schemaMinor"] ?? 0,
            "packageId": directory.lastPathComponent, "rideId": session["rideId"] ?? NSNull(),
            "status": status, "provenance": simulated ? "simulated" : "measured", "simulated": simulated,
            "startedAtUTC": Roadlog.iso(Date(timeIntervalSince1970: startUnix)), "endedAtUTC": Roadlog.iso(Date(timeIntervalSince1970: endUnix)),
            "durationS": duration,
            "clock": ["monotonicBase": "ProcessInfo.systemUptime seconds", "mappingFile": "clock.jsonl", "samples": clocks.count,
                      "start": clockObject(first), "end": clockObject(last)],
            "app": session["app"] ?? [:], "device": session["device"] ?? [:], "vehicle": session["vehicle"] ?? NSNull(),
            "settings": settings, "calibration": session["calibration"] ?? NSNull(), "capabilities": session["capabilities"] ?? [:],
            "streams": streams, "files": files,
            "audio": ["rawEnabled": settings["rawAudioEnabled"] ?? false, "codec": "AAC-LC mono", "bitrate": 32000, "sampleRate": 16000,
                      "segments": audio.map(chunkObject)],
            "gaps": gaps, "degradations": degradations, "storagePolicy": session["storagePolicy"] ?? NSNull(),
            "integrity": ["algorithm": "SHA-256", "chunksVerified": verify && problems.isEmpty, "problems": problems],
            "manifestRebuilt": rebuilt,
            "dataVolume": ["totalBytes": totalBytes, "uncompressedBytes": uncompressed,
                           "bytesPerHourEstimate": perHour],
            "upload": ["target": "iCloud Drive \(Roadlog.containerIdentifier) / Documents/Roadlog", "note": "上传状态只记录在手机上，不进入包校验和"],
        ]
    }
    private static func chunkObject(_ entry: RoadlogIndexEntry) -> [String: Any] {
        var object: [String: Any] = ["seq": entry.seq, "file": entry.file, "t_start": entry.tStart, "t_end": entry.tEnd,
                                     "bytes": entry.bytes, "sha256": entry.sha256, "recovered": entry.recovered]
        if let stream = entry.stream { object["stream"] = stream }
        if let rows = entry.rows { object["rows"] = rows }
        if let size = entry.uncompressedBytes { object["uncompressed_bytes"] = size }
        return object
    }
    /// manifest.json then manifest.sha256 (both atomic). The sha file's presence marks a complete manifest.
    static func write(_ manifest: [String: Any], to directory: URL) throws {
        let data = try RoadlogJSON.data(manifest)
        try data.write(to: directory.appendingPathComponent("manifest.json"), options: .atomic)
        try Data("\(Roadlog.sha256(data))  manifest.json\n".utf8).write(to: directory.appendingPathComponent("manifest.sha256"), options: .atomic)
    }
    static func status(of directory: URL) -> String? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")) else { return nil }
        return RoadlogJSON.object(data)?["status"] as? String
    }
}

/// Crash/termination recovery: seal leftover `.part` chunks, drop half lines, rebuild the manifest.
enum RoadlogRecovery {
    /// Returns true when the package needed (and got) recovery. Packages with a sealed/recovered manifest are untouched.
    @discardableResult static func recoverIfNeeded(_ directory: URL) throws -> Bool {
        let status = RoadlogManifestBuilder.status(of: directory)
        guard status == nil || status == "recording" else { return false }
        let fm = FileManager.default
        // Index first: later steps append to it.
        for name in ["index", "events", "device", "clock", "accessory"] { truncatePartialLine(directory.appendingPathComponent(name + ".jsonl")) }
        var indexed = Set(RoadlogJSON.lines(directory.appendingPathComponent("index.jsonl")).compactMap { $0["file"] as? String })
        let index = try RoadlogPackageWriter.appendHandle(directory.appendingPathComponent("index.jsonl"))
        defer { try? index.close() }
        var lastT: Double?
        let streamsRoot = directory.appendingPathComponent("streams", isDirectory: true)
        for folder in (try? fm.contentsOfDirectory(at: streamsRoot, includingPropertiesForKeys: nil)) ?? [] {
            for file in (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
                if file.pathExtension == "tmp" { try? fm.removeItem(at: file); continue }
                guard file.lastPathComponent.hasSuffix(".csv.part"), let seq = Int(file.lastPathComponent.prefix(6)) else { continue }
                let stream = folder.lastPathComponent
                let relative = "streams/\(stream)/" + String(format: "%06d.csv.gz", seq)
                if indexed.contains(relative) { try? fm.removeItem(at: file); continue }
                // A .gz without an index line came from an interrupted seal; the .part is the source of truth.
                try? fm.removeItem(at: directory.appendingPathComponent(relative))
                truncatePartialLine(file)
                let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
                let rows = text.split(separator: "\n", omittingEmptySubsequences: true).dropFirst()
                guard let firstRow = rows.first, let lastRow = rows.last,
                      let tStart = Double(firstRow.prefix { $0 != "," }), let tEnd = Double(lastRow.prefix { $0 != "," }) else { try? fm.removeItem(at: file); continue }
                let entry = try RoadlogPackageWriter.sealPart(file, stream: stream, seq: seq, directory: directory, rows: rows.count, tStart: tStart, tEnd: tEnd, recovered: true)
                try index.write(contentsOf: try JSONEncoder.roadlog.encode(entry) + Data([0x0a])); try index.synchronize()
                indexed.insert(relative); try? fm.removeItem(at: file)
                lastT = max(lastT ?? tEnd, tEnd)
            }
        }
        // Audio segments still open at termination (no moov atom may be written; flagged for the reader).
        let audioRoot = directory.appendingPathComponent("audio", isDirectory: true)
        for file in ((try? fm.contentsOfDirectory(at: audioRoot, includingPropertiesForKeys: nil)) ?? []).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where file.pathExtension == "m4a" {
            let relative = "audio/" + file.lastPathComponent
            guard !indexed.contains(relative), let data = try? Data(contentsOf: file), let seq = Int(file.deletingPathExtension().lastPathComponent) else { continue }
            let entry = RoadlogIndexEntry(type: "audio", stream: nil, seq: seq, file: relative, rows: nil, tStart: lastT ?? 0, tEnd: lastT ?? 0, bytes: data.count, uncompressedBytes: nil, sha256: Roadlog.sha256(data), recovered: true)
            try index.write(contentsOf: try JSONEncoder.roadlog.encode(entry) + Data([0x0a]))
        }
        let events = try RoadlogPackageWriter.appendHandle(directory.appendingPathComponent("events.jsonl"))
        let t = lastT ?? RoadlogJSON.lines(directory.appendingPathComponent("clock.jsonl")).last?["t_mono"] as? Double ?? 0
        try events.write(contentsOf: try RoadlogJSON.line(["type": "recovered_after_termination", "source": "app", "t_mono": t,
            "note": "App 在骑行中被终止；未封好的块已截断到最后完整行并封包，manifest 由 index.jsonl 重建"]))
        try events.synchronize(); try events.close()
        let manifest = try RoadlogManifestBuilder.build(directory: directory, status: "recovered", rebuilt: true, verify: true)
        try RoadlogManifestBuilder.write(manifest, to: directory)
        return true
    }
    static func truncatePartialLine(_ url: URL) {
        guard let data = try? Data(contentsOf: url), let last = data.last, last != 0x0a else { return }
        let keep = data.lastIndex(of: 0x0a).map { data.distance(from: data.startIndex, to: $0) + 1 } ?? 0
        if let handle = try? FileHandle(forWritingTo: url) { try? handle.truncate(atOffset: UInt64(keep)); try? handle.close() }
    }
}

enum RoadlogReadme {
    static let text = """
    # Motuo 路谱包（schema v1.1）

    一次真实骑行的手机传感器全量记录。完整规格见仓库 `docs/ROADLOG_FORMAT.md`；Mac 端工具 `tools/roadlog/roadlog.py`（list / verify / summary / export）。

    **隐私：** 包含精确轨迹（以及可能的原始环境声音）。只保存在本机和你自己的 iCloud Drive，不要上传到公开仓库或第三方。

    ## 文件
    - `manifest.json`：schema、骑行 ID、起止时间、时钟映射、设备/系统/App、车辆、每个流的列定义（名称/单位/说明）、实际采样率、缺口、降级、校验和。`manifest.sha256` 是它的 SHA-256；两者都在时，包才完整。
    - `session.json`：开始时写下的元数据（manifest 可由它和 index.jsonl 重建）。
    - `index.jsonl`：每个已封好的数据块一行（文件、行数、时间范围、字节数、SHA-256）。
    - `streams/<流>/<序号>.csv.gz`：按 60 秒或 4 MiB 切块的 gzip CSV，第一行表头，第一列 `t_mono`。空字段 = 无数据（绝不用 0 代替）。
    - `events.jsonl` 骑行状态/推断事件/缺口/降级；`device.jsonl` 电池、热状态、前后台、存储；`clock.jsonl` 时钟映射；`accessory.jsonl` 配件原始帧。
    - `audio/NNNN.m4a`：仅在“保存原始声音”开启时存在（AAC 单声道 16 kHz）。
    - v1.1 新增：`streams/vehicle_state`（App 推断的车辆状态，10 Hz，整数编码见列说明）与 `streams/acoustic_lf`（20–500 Hz 低频细分谱，约 4 帧/秒，只采集）。

    ## 时间
    `t_mono` = iPhone `ProcessInfo.systemUptime` 秒（与 CoreMotion 时间戳同一时基）。换算 UTC：取 `clock.jsonl` 中最近一条 `{t_mono, t_unix}`，`t_unix = t_unix0 + (t_mono - t_mono0)`。定位与航向另存原始 `t_unix`。

    ## 来源
    每个流的 `source` 为 measured（传感器测量）、inferred（App 推断，流名以 inferred_ 开头）或 simulated（合成测试包）。声学特征是手机麦克风的混合环境声，不是发动机转速。

    ## Python（仅标准库）
    ```python
    import csv, gzip, io, json, pathlib
    pkg = pathlib.Path("2026-10-22T08-15-30Z_<rideUUID>")
    manifest = json.loads((pkg / "manifest.json").read_text())
    clock = [json.loads(l) for l in (pkg / "clock.jsonl").read_text().splitlines() if l.strip()]
    def to_unix(t):
        ref = min(clock, key=lambda c: abs(c["t_mono"] - t))
        return ref["t_unix"] + (t - ref["t_mono"])
    rows = []
    for chunk in manifest["streams"]["motion"]["chunks"]:
        with gzip.open(pkg / chunk["file"], "rt", newline="") as f:
            rows += [{k: (float(v) if v else None) for k, v in r.items()} for r in csv.DictReader(f)]
    print(len(rows), manifest["streams"]["motion"]["measuredHz"], to_unix(rows[0]["t_mono"]))
    ```
    """
}
