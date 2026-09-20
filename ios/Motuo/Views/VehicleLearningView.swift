import SwiftUI
import SwiftData

struct VehicleLearningView: View {
    let vehicle: Vehicle
    @Environment(\.dismiss) private var dismiss
    @Environment(RideEngine.self) private var engine
    @Query(sort: \Ride.startedAt) private var rides: [Ride]
    @State private var learning = VehicleLearningService.shared
    @State private var calibration = SensorCalibrationService.shared
    @State private var error: String?
    private var profile: CalibrationProfile? { calibration.profile(for: vehicle.id) }
    private var versions: [VehicleLearningVersion] { learning.versions.filter { $0.vehicleId == vehicle.id && $0.calibrationId == profile?.id }.sorted { $0.version > $1.version } }
    private var locked: Bool { learning.busy || engine.currentRide != nil }
    var body: some View {
        NavigationStack {
            List {
                Section("从你确认的片段学习") {
                    Text("只使用实测骑行中，你确认或拒绝的疑似换挡原时间段。演示、AI 解释和未确认事件不会成为训练标签。")
                    Text("至少 4 次骑行、12 个片段；最新整次骑行留作检查。不同安装校准独立学习，数据不足时继续收集。")
                    Text("这是个人候选检测阈值，不能确定实际挡位，也不代表已验证识别准确率。").foregroundStyle(Cyber.orange)
                }.font(.footnote)
                Section("当前安装") {
                    if let profile {
                        LabeledContent("校准", value: "v\(profile.version) · \(profile.mountName)")
                        let active = learning.active(vehicleId: vehicle.id, calibrationId: profile.id)
                        LabeledContent("候选检测", value: active.map { "个人 v\($0.version)" } ?? "默认阈值")
                        if let active {
                            LabeledContent("已确认窗口的振动基线", value: String(format: "%.2f m/s² RMS", active.vibrationRMS))
                            Text("基线用于比较同一安装的片段振动；不代表车辆健康标准或故障诊断。").font(.caption).foregroundStyle(Cyber.muted)
                            Button("回退默认阈值") { perform { try learning.useDefault(calibrationId: profile.id) } }.disabled(locked)
                        }
                        Button(learning.busy ? "正在核对记录…" : "用已确认片段生成候选") {
                            let inputs = rides.filter { $0.vehicleId == vehicle.id }.map {
                                LearningRideInput(id: $0.id, vehicleId: $0.vehicleId, calibrationId: $0.calibrationId, startedAt: $0.startedAt, source: $0.source, finished: $0.isFinished, dataVersion: $0.dataVersion, events: $0.events)
                            }
                            Task { await learning.build(vehicleId: vehicle.id, calibrationId: profile.id, inputs: inputs) }
                        }.disabled(locked)
                    } else { Text("先在设置中完成停车扶正与安装方向校准。无校准的历史片段不合并训练。") }
                    if engine.currentRide != nil { Text("结束当前骑行后可更新阈值。").foregroundStyle(Cyber.orange) }
                    Text(learning.status).font(.footnote).foregroundStyle(Cyber.muted)
                    if let error { Text(error).foregroundStyle(Cyber.orange).font(.footnote) }
                }
                Section("可回退版本") {
                    if versions.isEmpty { Text("尚无候选版本").foregroundStyle(Cyber.muted) }
                    ForEach(versions) { version in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { Text("个人 v\(version.version)").font(.headline); Spacer(); Text(version.createdAt.formatted(date: .abbreviated, time: .omitted)).font(.caption) }
                            Text("训练 \(version.trainingRideIds.count) 次 / \(version.trainingExamples) 段 · 独立检查 \(version.holdoutRideIds.count) 次 / \(version.holdoutExamples) 段").font(.caption)
                            Text("窗口振动基线 \(String(format: "%.2f", version.vibrationRMS)) m/s² RMS").font(.caption).foregroundStyle(Cyber.muted)
                            if version.invalidated { Text("原标签已修改，版本已停用；重新生成候选。").font(.caption).foregroundStyle(Cyber.orange) }
                            else if learning.active(vehicleId: vehicle.id, calibrationId: profile?.id)?.id == version.id { Label("下次骑行使用", systemImage: "checkmark.circle.fill").foregroundStyle(Cyber.cyan).font(.caption) }
                            else { Button("使用此版本") { perform { try learning.use(version) } }.disabled(locked) }
                        }.padding(.vertical, 5)
                    }
                }
            }.scrollContentBackground(.hidden).background(Cyber.ink).navigationTitle("车辆学习")
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } } }
        }
    }
    private func perform(_ operation: () throws -> Void) { do { try operation(); error = nil } catch { self.error = error.localizedDescription } }
}
