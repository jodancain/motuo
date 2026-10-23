import SwiftUI

/// Control-center panel: roadlog mode (default on), raw audio (default off, explicit confirmation), library entry.
struct RoadlogSettingsPanel: View {
    @Environment(AppSettings.self) private var settings
    @Environment(RideEngine.self) private var engine
    @State private var confirmRawAudio = false
    @State private var showLibrary = false
    private var recorder: RoadlogRecorder { .shared }
    private var queue: RoadlogUploadQueue { .shared }
    var body: some View {
        @Bindable var settings = settings
        Panel {
            VStack(alignment: .leading, spacing: 16) {
                Toggle(isOn: $settings.roadlogEnabled) {
                    label("路谱采集模式", detail: "每次真实骑行自动全量记录手机传感器，结束后放入你的 iCloud；演示骑行不采集", symbol: "waveform.path.ecg")
                }.accessibilityIdentifier("roadlog.enabled")
                Toggle(isOn: Binding(get: { settings.roadlogRawAudio }, set: { on in if on { confirmRawAudio = true } else { settings.roadlogRawAudio = false } })) {
                    label("保存原始声音", detail: "用于以后分析发动机转速；默认关闭。需在座舱开启麦克风才会录制", symbol: "mic")
                }.disabled(!settings.roadlogEnabled).accessibilityIdentifier("roadlog.rawAudio")
                if recorder.active {
                    Text("本次骑行正在采集 · 已记录 \(RoadlogFormat.megabytes(recorder.stats.bytes))\(recorder.stats.motionHz.map { " · \(Int($0.rounded()))Hz" } ?? "")")
                        .font(Cyber.mono(11)).foregroundStyle(Cyber.accent)
                }
                if let error = recorder.lastError { Text(error).font(.system(size: 11)).foregroundStyle(.orange) }
                Text(engine.currentRide == nil ? "设置对下一次骑行生效。" : "设置变化从下一次骑行开始生效。")
                    .font(.system(size: 11)).foregroundStyle(Cyber.muted)
                Button { showLibrary = true } label: {
                    HStack { label("路谱包与上传", detail: queue.items.isEmpty ? "还没有路谱" : "\(queue.items.count) 个 · \(queue.cloudStatus)", symbol: "icloud.and.arrow.up"); Spacer(); Image(systemName: "chevron.right").font(.system(size: 12)) }
                }.buttonStyle(.plain).accessibilityIdentifier("roadlog.library")
            }.tint(Cyber.accent)
        }
        .alert("保存原始声音？", isPresented: $confirmRawAudio) {
            Button("开启", role: .destructive) { settings.roadlogRawAudio = true }
            Button("取消", role: .cancel) {}
        } message: {
            Text("开启后，骑行中只要你在座舱打开了麦克风，就会把周围所有声音（包括对话）录成压缩音频，保存在本机和你自己的 iCloud，不发给第三方。可随时关闭。")
        }
        .sheet(isPresented: $showLibrary) { RoadlogLibraryView() }
    }
    private func label(_ title: String, detail: String, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).foregroundStyle(Cyber.accent).font(.system(size: 19)).frame(width: 23)
            VStack(alignment: .leading, spacing: 6) { Text(title).font(.system(size: 14, weight: .medium)).foregroundStyle(.white); Text(detail).font(.system(size: 10)).foregroundStyle(Cyber.muted) }
        }
    }
}

enum RoadlogFormat {
    static func megabytes(_ bytes: Int) -> String { String(format: "%.1f MB", Double(bytes) / 1_000_000) }
    /// "2026-10-22T08-15-30Z_<UUID>" → local date/time text.
    static func title(_ packageId: String) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss'Z'"
        guard let date = f.date(from: String(packageId.prefix(20))) else { return packageId }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

struct RoadlogLibraryView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppSettings.self) private var settings
    @State private var share: SharedImage?
    @State private var message: String?
    @State private var working: String?
    private var queue: RoadlogUploadQueue { .shared }
    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            List {
                Section {
                    Text(queue.cloudStatus).font(.system(size: 13))
                    Text("本机副本也可在“文件”App → 我的 iPhone → MOTUO → Roadlog 查看。Mac 上用 tools/roadlog/roadlog.py 读取。")
                        .font(.system(size: 11)).foregroundStyle(Cyber.muted)
                    Button("立即重试上传") { Task { await queue.retryNow() } }
                } header: { Text("iCloud") }
                Section {
                    Stepper("保留最近 \(settings.roadlogKeepCount) 次", value: $settings.roadlogKeepCount, in: 0...100)
                    Stepper("或 \(settings.roadlogKeepDays) 天内", value: $settings.roadlogKeepDays, in: 0...90)
                    Text("只清理已确认上传到 iCloud 的本机副本；未确认上传的路谱一律保留。").font(.system(size: 11)).foregroundStyle(Cyber.muted)
                } header: { Text("本机副本") }
                Section {
                    if queue.items.isEmpty { Text("还没有路谱包").foregroundStyle(Cyber.muted) }
                    ForEach(queue.items.sorted { $0.id > $1.id }) { item in
                        let directory = queue.localRoot.appendingPathComponent(item.id)
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(RoadlogFormat.title(item.id)).font(.system(size: 14, weight: .medium))
                                Spacer()
                                StatusPill(text: item.state.label, color: item.state == .uploaded ? Cyber.accent : item.state == .failed || item.state == .localOnly ? .orange : Cyber.cyan)
                            }
                            Text(item.localDeleted ? "本机副本已按保留设置清理（iCloud 中保留）" : RoadlogFormat.megabytes(RoadlogLibrary.size(directory)) + (item.simulated ? " · 模拟数据" : ""))
                                .font(Cyber.mono(10)).foregroundStyle(Cyber.muted)
                            if let reason = item.reason { Text(reason).font(.system(size: 11)).foregroundStyle(Cyber.muted) }
                            if !item.localDeleted, item.state != .pendingSeal {
                                Button(working == item.id ? "正在打包…" : "分享导出 (.zip)") { export(directory, id: item.id) }
                                    .font(.system(size: 12)).disabled(working != nil)
                            }
                        }.padding(.vertical, 4)
                    }
                } header: { Text("路谱包") }
                if let message { Section { Text(message).foregroundStyle(.orange) } }
            }
            .scrollContentBackground(.hidden).background(Cyber.ink).navigationTitle("路谱")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } } }
            .task { await queue.process() }
        }.sheet(item: $share) { item in ShareSheet(items: [item.url]) { share = nil } }
    }
    private func export(_ directory: URL, id: String) {
        working = id; message = nil
        Task {
            let result = await Task.detached { Result { try RoadlogLibrary.zipForSharing(directory) } }.value
            working = nil
            switch result { case let .success(url): share = SharedImage(url: url); case let .failure(error): message = "导出失败：\(error.localizedDescription)" }
        }
    }
}
