import Foundation
import Network
import Observation
import BackgroundTasks
import UIKit

enum RoadlogUploadState: String, Codable, Sendable {
    case pendingSeal, sealed, placedInCloud, uploaded, failed, localOnly, rejected
    var label: String {
        switch self {
        case .pendingSeal: "待封包"; case .sealed: "已封包"; case .placedInCloud: "已放入 iCloud"; case .uploaded: "已上传"
        case .failed: "失败 · 将重试"; case .localOnly: "仅本地"; case .rejected: "不上传"
        }
    }
}

struct RoadlogUploadItem: Codable, Identifiable, Equatable, Sendable {
    var id: String               // packageId
    var state: RoadlogUploadState
    var simulated: Bool
    var reason: String?
    var retryCount = 0
    var nextRetryAt: Date?
    var updatedAt: Date
    var uploadedAt: Date?
    var localDeleted = false
}

enum RoadlogCloudAvailability: Equatable, Sendable {
    case available(URL)          // <container>/Documents/Roadlog
    case unavailable(String)
}

/// iCloud Drive access, abstracted so the state machine is testable without an iCloud account.
protocol RoadlogCloudProvider: Sendable {
    func availability() -> RoadlogCloudAvailability
    func place(package: URL, into folder: URL) throws -> URL
    /// (all files uploaded, an upload error description if any)
    func uploadStatus(of placed: URL) -> (uploaded: Bool, error: String?)
}

/// iCloud Drive document container. Must be called off the main thread (url(forUbiquityContainerIdentifier:) can block).
struct ICloudDriveProvider: RoadlogCloudProvider {
    func availability() -> RoadlogCloudAvailability {
        let fm = FileManager.default
        guard fm.ubiquityIdentityToken != nil else { return .unavailable("未登录 iCloud，或 iCloud Drive / 本 App 的 iCloud 开关已关闭") }
        guard let container = fm.url(forUbiquityContainerIdentifier: Roadlog.containerIdentifier) else {
            return .unavailable("本版本未获得 iCloud 容器能力（签名未启用 iCloud Documents），或系统暂未提供容器")
        }
        let folder = container.appendingPathComponent("Documents/Roadlog", isDirectory: true)
        do { try fm.createDirectory(at: folder, withIntermediateDirectories: true) } catch { return .unavailable("iCloud 容器不可写：\(error.localizedDescription)") }
        return .available(folder)
    }
    /// Coordinated copy; manifest.json and manifest.sha256 are written last so a Mac can tell a complete package.
    func place(package: URL, into folder: URL) throws -> URL {
        let target = folder.appendingPathComponent(package.lastPathComponent, isDirectory: true)
        var coordinationError: NSError?, copyError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: target, options: .forReplacing, error: &coordinationError) { url in
            do { try Self.copyManifestLast(from: package, to: url) } catch { copyError = error }
        }
        if let error = coordinationError ?? copyError { throw error }
        return target
    }
    static func copyManifestLast(from source: URL, to target: URL) throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
        let last = ["manifest.json", "manifest.sha256"]
        let files = (fm.enumerator(at: source, includingPropertiesForKeys: [.isRegularFileKey])?.allObjects as? [URL] ?? [])
            .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
        let base = source.standardizedFileURL.path
        func relative(_ url: URL) -> String { String(url.standardizedFileURL.path.dropFirst(base.count + 1)) }
        for file in files.filter({ !last.contains(relative($0)) }) + last.map({ source.appendingPathComponent($0) }) {
            let destination = target.appendingPathComponent(relative(file))
            try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.copyItem(at: file, to: destination)
        }
    }
    func uploadStatus(of placed: URL) -> (uploaded: Bool, error: String?) {
        let keys: [URLResourceKey] = [.isRegularFileKey, .ubiquitousItemIsUploadedKey, .ubiquitousItemUploadingErrorKey]
        guard let files = FileManager.default.enumerator(at: placed, includingPropertiesForKeys: keys)?.allObjects as? [URL] else { return (false, "iCloud 中找不到已放入的包") }
        var all = true, failure: String?
        for file in files {
            guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
            if values.ubiquitousItemIsUploaded != true { all = false }
            if let error = values.ubiquitousItemUploadingError {
                failure = (error as NSError).code == NSUbiquitousFileNotUploadedDueToQuotaError ? "iCloud 空间不足" : error.localizedDescription
            }
        }
        return (all && !files.isEmpty, failure)
    }
}

/// Upload state machine (persisted): pendingSeal → sealed → placedInCloud → uploaded; failures retry with backoff;
/// iCloud unavailable → localOnly (kept, reason shown, resumes automatically); simulated packages are rejected.
@MainActor @Observable final class RoadlogUploadQueue {
    static let shared = RoadlogUploadQueue()
    private(set) var items: [RoadlogUploadItem] = []
    private(set) var cloudStatus = "尚未检查 iCloud"
    @ObservationIgnored let localRoot: URL
    @ObservationIgnored private let store: URL
    @ObservationIgnored private let provider: RoadlogCloudProvider
    @ObservationIgnored var now: () -> Date = Date.init
    @ObservationIgnored var retention: () -> (count: Int, days: Int) = { (10, 7) }
    @ObservationIgnored private var running = false
    @ObservationIgnored private var rerun = false
    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var identityObserver: NSObjectProtocol?

    init(localRoot: URL = Roadlog.localRoot,
         store: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("roadlog-upload.json"),
         provider: RoadlogCloudProvider = ICloudDriveProvider()) {
        self.localRoot = localRoot; self.store = store; self.provider = provider
        items = (try? JSONDecoder().decode([RoadlogUploadItem].self, from: Data(contentsOf: store))) ?? []
    }
    /// Resume triggers: iCloud account change and network recovery (foreground / BG task / ride end call process() directly).
    func startObserving() {
        guard identityObserver == nil else { return }
        identityObserver = NotificationCenter.default.addObserver(forName: .NSUbiquityIdentityDidChange, object: nil, queue: .main) { _ in
            Task { @MainActor in await RoadlogUploadQueue.shared.retryNow() }
        }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in if path.status == .satisfied { Task { @MainActor in await RoadlogUploadQueue.shared.process() } } }
        monitor.start(queue: DispatchQueue(label: "cn.yundongyl.motuo.roadlog.network")); self.monitor = monitor
    }

    func item(_ id: String) -> RoadlogUploadItem? { items.first { $0.id == id } }
    func enqueue(_ id: String, simulated: Bool, state: RoadlogUploadState = .sealed) {
        guard item(id) == nil else { return }
        items.append(.init(id: id, state: simulated ? .rejected : state, simulated: simulated,
                           reason: simulated ? "模拟/合成数据不上传 iCloud" : nil, updatedAt: now()))
        save()
    }
    func markSealed(_ id: String, failed: String?) {
        update(id) { item in
            guard item.state == .pendingSeal else { return }
            if let failed { item.state = .failed; item.reason = failed } else { item.state = .sealed; item.reason = nil }
        }
    }
    /// Adopts packages found on disk (e.g. after crash recovery) that the queue does not know yet.
    func adopt(_ directory: URL) {
        let id = directory.lastPathComponent
        guard item(id) == nil, let data = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")), let manifest = RoadlogJSON.object(data) else { return }
        let status = manifest["status"] as? String
        enqueue(id, simulated: manifest["simulated"] as? Bool ?? false, state: status == "sealed" || status == "recovered" ? .sealed : .pendingSeal)
    }
    func retryNow() async {
        for index in items.indices where [.failed, .localOnly].contains(items[index].state) { items[index].nextRetryAt = nil }
        await process()
    }

    func process() async {
        if running { rerun = true; return }
        running = true; defer { running = false }
        repeat {
            rerun = false
            await step()
        } while rerun
        cleanup()
        schedulePollIfNeeded()
    }
    private func step() async {
        let provider = provider
        var availability: RoadlogCloudAvailability?
        for id in items.map(\.id) {
            guard let current = item(id), !current.localDeleted else { continue }
            let directory = localRoot.appendingPathComponent(id, isDirectory: true)
            switch current.state {
            case .uploaded, .rejected: continue
            case .pendingSeal:
                // A pending package that is no longer being recorded (crash) is sealed by recovery at launch.
                if let status = RoadlogManifestBuilder.status(of: directory), status == "sealed" || status == "recovered" { update(id) { $0.state = .sealed } }
                continue
            case .placedInCloud:
                if availability == nil { availability = await Task.detached { provider.availability() }.value }
                guard case let .available(folder)? = availability else { continue }
                let placed = folder.appendingPathComponent(id, isDirectory: true)
                let status = await Task.detached { provider.uploadStatus(of: placed) }.value
                update(id) { item in
                    if status.uploaded { item.state = .uploaded; item.uploadedAt = self.now(); item.reason = nil }
                    else { item.reason = status.error ?? "已放入 iCloud，等待系统上传（需要网络）" }
                }
            case .sealed, .failed, .localOnly:
                if let retry = current.nextRetryAt, retry > now() { continue }
                if availability == nil { availability = await Task.detached { provider.availability() }.value }
                switch availability! {
                case let .unavailable(reason):
                    cloudStatus = reason
                    update(id) { $0.state = .localOnly; $0.reason = reason + "；已保存在本机，可在“文件”App 查看或分享导出" }
                case let .available(folder):
                    cloudStatus = "iCloud Drive 可用"
                    let problems = await Task.detached { RoadlogVerifier.problems(directory) }.value
                    guard problems.isEmpty else {
                        update(id) { $0.state = .failed; $0.reason = "本地包校验失败：" + problems.prefix(3).joined(separator: "；"); $0.retryCount += 1; $0.nextRetryAt = self.backoff($0.retryCount) }
                        continue
                    }
                    let result = await Task.detached { Result { try provider.place(package: directory, into: folder) } }.value
                    update(id) { item in
                        switch result {
                        case .success: item.state = .placedInCloud; item.reason = "已放入 iCloud，等待系统上传"; item.retryCount = 0; item.nextRetryAt = nil
                        case let .failure(error):
                            item.state = .failed; item.retryCount += 1; item.nextRetryAt = self.backoff(item.retryCount)
                            item.reason = (error as NSError).code == NSFileWriteOutOfSpaceError ? "空间不足，稍后重试" : "放入 iCloud 失败：\(error.localizedDescription)"
                        }
                    }
                }
            }
        }
    }
    func backoff(_ retry: Int) -> Date { now().addingTimeInterval(min(6 * 3600, 60 * pow(2, Double(max(0, retry - 1))))) }

    /// Deletes local copies only for packages confirmed uploaded and outside the retention window
    /// (kept when among the newest N uploaded OR younger than D days). Unconfirmed packages are never deleted.
    func cleanup() {
        let (count, days) = retention()
        let uploaded = items.filter { $0.state == .uploaded && !$0.localDeleted }.sorted { $0.id > $1.id }
        for (rank, item) in uploaded.enumerated() {
            let age = now().timeIntervalSince(item.uploadedAt ?? now())
            guard rank >= count, age > Double(days) * 86400 else { continue }
            try? FileManager.default.removeItem(at: localRoot.appendingPathComponent(item.id, isDirectory: true))
            update(item.id) { $0.localDeleted = true }
        }
    }
    private func schedulePollIfNeeded() {
        poll?.cancel()
        guard items.contains(where: { $0.state == .placedInCloud || $0.state == .failed }), UIApplication.shared.applicationState == .active else { return }
        poll = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            await self?.process()
        }
    }
    private func update(_ id: String, _ change: (inout RoadlogUploadItem) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[index]); items[index].updatedAt = now(); save()
    }
    private func save() {
        if let data = try? JSONEncoder().encode(items) { try? data.write(to: store, options: .atomic) }
    }
}

/// Recomputes manifest.sha256 and every indexed file hash. Empty result = package intact.
enum RoadlogVerifier {
    static func problems(_ directory: URL) -> [String] {
        var problems: [String] = []
        guard let manifestData = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")),
              let manifest = RoadlogJSON.object(manifestData) else { return ["缺少或无法解析 manifest.json"] }
        let recorded = (try? String(contentsOf: directory.appendingPathComponent("manifest.sha256"), encoding: .utf8))?.split(separator: " ").first.map(String.init)
        if recorded != Roadlog.sha256(manifestData) { problems.append("manifest.sha256 不符") }
        if !["sealed", "recovered"].contains(manifest["status"] as? String ?? "") { problems.append("包尚未封好") }
        let streams = manifest["streams"] as? [String: Any] ?? [:]
        var entries = streams.values.compactMap { ($0 as? [String: Any])?["chunks"] as? [[String: Any]] }.flatMap { $0 }
        entries += (manifest["audio"] as? [String: Any])?["segments"] as? [[String: Any]] ?? []
        for entry in entries {
            guard let file = entry["file"] as? String, let sha = entry["sha256"] as? String else { problems.append("块描述不完整"); continue }
            guard let data = try? Data(contentsOf: directory.appendingPathComponent(file)) else { problems.append("缺少 \(file)"); continue }
            if Roadlog.sha256(data) != sha || data.count != entry["bytes"] as? Int { problems.append("校验不符 \(file)") }
        }
        return problems
    }
}

/// BGProcessingTask for leftover sealing, retries and upload read-back. Identifier is listed in Info.plist.
enum RoadlogBackground {
    static let identifier = "cn.yundongyl.motuo.roadlog.process"
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            let work = Task { @MainActor in
                await RoadlogLibrary.recoverAll()
                await RoadlogUploadQueue.shared.process()
                task.setTaskCompleted(success: true)
                if RoadlogUploadQueue.shared.items.contains(where: { [.sealed, .failed, .placedInCloud, .pendingSeal].contains($0.state) }) { schedule() }
            }
            task.expirationHandler = { work.cancel() }
        }
    }
    static func schedule() {
        let request = BGProcessingTaskRequest(identifier: identifier)
        request.requiresNetworkConnectivity = true; request.requiresExternalPower = false
        try? BGTaskScheduler.shared.submit(request)   // unavailable in the simulator; foreground triggers still run
    }
}

/// Launch-time recovery of packages left open by a termination, then adoption into the upload queue.
@MainActor enum RoadlogLibrary {
    static func packages(root: URL = Roadlog.localRoot) -> [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey])) ?? [])
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
    }
    static func recoverAll(root: URL = Roadlog.localRoot, recorder: RoadlogRecorder? = nil, queue: RoadlogUploadQueue? = nil) async {
        let queue = queue ?? .shared, active = (recorder ?? .shared).packageId
        for directory in packages(root: root) where directory.lastPathComponent != active {
            _ = await Task.detached { try? RoadlogRecovery.recoverIfNeeded(directory) }.value
            queue.adopt(directory)
        }
    }
    static func size(_ directory: URL) -> Int {
        (FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey])?.allObjects as? [URL] ?? [])
            .reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }
    /// Zip for the share sheet via NSFileCoordinator's `.forUploading` (system-made archive of the directory).
    nonisolated static func zipForSharing(_ directory: URL) throws -> URL {
        var error: NSError?, result: URL?, copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: directory, options: .forUploading, error: &error) { zip in
            let target = FileManager.default.temporaryDirectory.appendingPathComponent(directory.lastPathComponent + ".zip")
            do { try? FileManager.default.removeItem(at: target); try FileManager.default.copyItem(at: zip, to: target); result = target } catch { copyError = error }
        }
        if let failure = error ?? copyError { throw failure }
        guard let result else { throw RoadlogError.write("无法生成压缩包") }
        return result
    }
}
