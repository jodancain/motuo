import SwiftUI

struct CalibrationView: View {
    var vehicle: Vehicle
    @Environment(\.dismiss) private var dismiss
    @State private var forward: MountForwardHint = .top
    @State private var mount = "车把支架"
    @State private var upright = false
    private var service: SensorCalibrationService { .shared }
    var body: some View {
        NavigationStack {
            Form {
                Section("停车扶正 · \(vehicle.name)") {
                    Text("熄火，将车辆扶正且静止。保持手机固定在实际使用的支架上，选择手机哪一个方向朝向车头。校准约需 2 秒。")
                    TextField("支架名称",text:$mount)
                    Picker("车头方向",selection:$forward) { ForEach(MountForwardHint.allCases) { Text($0.rawValue).tag($0) } }
                    Toggle("已扶正车辆、熄火且支架固定",isOn:$upright)
                    Button(service.sampling ? "正在采样…" : "采样并保存安装校准") { Task { await service.sample(vehicleId:vehicle.id,mountName:mount,forwardHint:forward) } }
                        .disabled(!upright || service.sampling || mount.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                    Text(service.status).font(.footnote)
                }
                Section("这辆车的安装记录") {
                    ForEach(service.profiles.filter { $0.vehicleId == vehicle.id }.reversed()) { profile in
                        Button { service.activate(profile) } label: {
                            VStack(alignment:.leading,spacing:6) {
                                Text("v\(profile.version) · \(profile.mountName)" + (service.profile(for:vehicle.id)?.id == profile.id ? " · 当前" : ""))
                                Text("\(profile.forwardHint) · \(profile.sampleCount) 样本 · \(profile.createdAt.formatted(date:.abbreviated,time:.shortened))").font(.caption).foregroundStyle(.secondary)
                            }
                        }.disabled(service.sampling)
                    }
                    Text("安装方向用于将手机坐标映射到车辆相对坐标。车辆必须由你确认扶正；这不代表已经验证动态倾角精度。手机或支架位置变化后重新采样。").font(.footnote)
                }
            }.navigationTitle("安装校准").toolbar { ToolbarItem(placement:.topBarTrailing) { Button("完成") { dismiss() } } }
        }.onDisappear { service.cancel() }
    }
}
