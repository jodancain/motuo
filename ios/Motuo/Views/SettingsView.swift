import SwiftUI
import SwiftData

struct SettingsView:View {
    @Environment(AppSettings.self) private var settings
    @Environment(RideEngine.self) private var engine
    @Query(sort: \Vehicle.createdAt) private var vehicles: [Vehicle]
    @State private var calibrationVehicle: Vehicle?
    private var selectedVehicle: Vehicle? { vehicles.first { $0.id.uuidString == settings.selectedVehicleID } ?? vehicles.first }
    private var mountStatus: String {
        guard let vehicle = selectedVehicle, let profile = SensorCalibrationService.shared.profile(for: vehicle.id) else { return "尚未采样安装校准" }
        return "v\(profile.version) · \(profile.mountName) · 真实样本 \(profile.sampleCount)"
    }
    @State private var showPair=false
    @State private var showAccessories=false
    @State private var showDataManagement=false
    var body:some View {
        @Bindable var settings=settings
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:22) {
                    PageTitle(eyebrow:"CONTROL CENTER",title:"按你的节奏设定",subtitle:"驾驶体验、私有连接与数据边界。")
                    Panel {
                        VStack(alignment:.leading,spacing:18) {
                            HStack { Image(systemName:"server.rack").foregroundStyle(Cyber.cyan).font(.system(size:24));VStack(alignment:.leading,spacing:5) { Text("私人 NAS").font(.system(size:18,weight:.semibold));Text(APIClient.shared.isPaired ? "设备已配对":"等待配对").font(.system(size:12)).foregroundStyle(Cyber.muted) };Spacer();StatusPill(text:APIClient.shared.isPaired ? "PAIRED":"LOCAL",color:Cyber.cyan) }
                            Text(APIClient.shared.baseURL).font(Cyber.mono(11)).foregroundStyle(Cyber.muted).textSelection(.enabled)
                            ActionButton(title:APIClient.shared.isPaired ? "管理连接":"配对私人车库",symbol:"link",primary:false) { showPair=true }
                        }
                    }
                    Panel {
                        VStack(spacing:18) {
                            Toggle(isOn:$settings.demoMode) { settingLabel("演示骑行",detail:"模拟路线与动态，始终标记 DEMO",symbol:"play.rectangle") }.disabled(engine.currentRide != nil)
                            Divider()
                            Toggle(isOn:$settings.keepScreenOn) { settingLabel("驾驶时保持亮屏",detail:"仅在你开始骑行后启用",symbol:"sun.max") }
                            Toggle(isOn:$settings.reducedEffects) { settingLabel("轻量动效",detail:"降低渲染频率与效果强度",symbol:"circle.lefthalf.filled") }
                            Toggle(isOn:$settings.autoSync) { settingLabel("结束后同步 NAS",detail:"离线先保存在手机，可手动重试",symbol:"arrow.triangle.2.circlepath") }
                        }.tint(Cyber.accent)
                    }
                    RoadlogSettingsPanel()
                    Panel {
                        VStack(alignment:.leading,spacing:18) {
                            Toggle(isOn:$settings.watchHaptics) { settingLabel("Apple Watch 事件反馈",detail:WatchBridge.shared.status,symbol:"applewatch") }
                            VStack(spacing:12) {
                                Toggle("出发反馈",isOn:$settings.watchStartHaptics)
                                Toggle("结束反馈",isOn:$settings.watchFinishHaptics)
                                Toggle("里程节点反馈",isOn:$settings.watchMilestoneHaptics)
                            }.font(.system(size:12)).tint(Cyber.accent).disabled(!settings.watchHaptics)
                            Text("仅在手表 App 活动且可达时播放短促反馈。后台或过期事件跳过，不补振，不启动虚构健身会话。").font(.system(size:11)).foregroundStyle(Cyber.muted).lineSpacing(5)
                            Divider()
                            HStack { settingLabel("支架安装",detail:mountStatus,symbol:"gyroscope");Spacer();Button("安装校准") { calibrationVehicle=selectedVehicle }.font(.system(size:12)).disabled(engine.currentRide != nil || selectedVehicle == nil) }
                            Text("结束骑行后，熄火扶正车辆并固定支架，再采样安装方向。更换支架位置请重新采样；动态倾角准确度仍待独立参考验证。").font(.system(size:11)).foregroundStyle(Cyber.muted).lineSpacing(5)
                        }
                    }
                    Button { showAccessories=true } label:{ Panel { HStack { settingLabel("配件实验室",detail:"BLE / Wi-Fi · HUD、胎压、外置 IMU",symbol:"dot.radiowaves.left.and.right");Spacer();Image(systemName:"chevron.right").font(.system(size:12)) } } }.buttonStyle(.plain)
                    Button { showDataManagement=true } label: { Panel { HStack { settingLabel("数据管理",detail:"骑行、手册、私人账户与本机缓存",symbol:"externaldrive");Spacer();Image(systemName:"chevron.right").font(.system(size:12)) } } }.buttonStyle(.plain)
                    Panel {
                        VStack(alignment:.leading,spacing:10) {
                            Eyebrow(text:"DATA WITH CONTEXT",color:Cyber.accent)
                            Text("实测、估计、确认、演示，分别保存").font(.system(size:15,weight:.semibold))
                            Text("真实挡位、发动机转速和数值倾角未接入时显示未知。只有明确确认或传感器真值可进入个人模型；手册原文仅作为证据。").font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(5)
                            Text("MOTUO 0.4 · iOS 真机内测").font(Cyber.mono(10)).foregroundStyle(Cyber.muted).padding(.top,8)
                        }
                    }
                }.padding(24).frame(maxWidth:850)
            }.background(Cyber.ink).toolbar(.hidden,for:.navigationBar)
        }.sheet(isPresented:$showPair) { PairingView() }.sheet(isPresented:$showAccessories) { AccessoriesView() }.sheet(item:$calibrationVehicle) { CalibrationView(vehicle:$0) }.sheet(isPresented:$showDataManagement) { DataManagementView() }
    }
    private func settingLabel(_ title:String,detail:String,symbol:String)->some View {
        HStack(alignment:.top,spacing:12) { Image(systemName:symbol).foregroundStyle(Cyber.accent).font(.system(size:19)).frame(width:23);VStack(alignment:.leading,spacing:6) { Text(title).font(.system(size:14,weight:.medium)).foregroundStyle(.white);Text(detail).font(.system(size:10)).foregroundStyle(Cyber.muted) } }
    }
}

struct PairingView:View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @Environment(AppSettings.self) private var settings
    @State private var baseURL=APIClient.shared.baseURL
    @State private var code=""
    @State private var busy=false
    @State private var message=""
    @State private var showUnpair=false
    var body:some View {
        NavigationStack {
            Form {
                Section("你的私人车库") { TextField("HTTPS 服务地址",text:$baseURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL);Text("填写你自己部署的服务地址。设备凭据按服务地址隔离，安全保存在系统钥匙串。").font(.footnote).foregroundStyle(Cyber.muted) }
                Section("设备配对") { SecureField("一次性配对码",text:$code).textInputAutocapitalization(.never).autocorrectionDisabled();Button { Task { await pair() } } label:{ if busy { ProgressView() } else { Text("验证并配对") } }.disabled(busy || code.isEmpty) }
                if !message.isEmpty { Section { Text(message).foregroundStyle(Cyber.cyan) } }
                if APIClient.shared.isPaired { Section { Button("解除本机配对",role:.destructive) { showUnpair=true };Text("解除配对会移除本机凭据，保留手机和 NAS 上已有记录。").font(.footnote).foregroundStyle(Cyber.muted) } }
            }.scrollContentBackground(.hidden).background(Cyber.ink).navigationTitle("私人 NAS").toolbar { ToolbarItem(placement:.topBarTrailing) { Button("完成") { dismiss() } } }
        }.confirmationDialog("解除本机配对？",isPresented:$showUnpair) { Button("解除配对",role:.destructive) { APIClient.shared.unpair();message="已移除本机凭据" } }
    }
    private func pair() async {
        busy=true;defer{busy=false}
        APIClient.shared.baseURL=baseURL.trimmingCharacters(in:.whitespacesAndNewlines)
        do { try await APIClient.shared.pair(code:code,deviceName:UIDevice.current.name);code="";try await CloudGarageSync.restore(context:context,settings:settings);message="配对成功，已有车辆档案已读取，可以同步骑行与导入手册。" }
        catch { message=error.localizedDescription }
    }
}

struct AccessoriesView:View {
    @Environment(\.dismiss) private var dismiss
    var service:AccessoryService { .shared }
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:22) {
                    PageTitle(eyebrow:"ACCESSORY LAB",title:"让机器，连接更多",subtitle:"为 HUD、胎压与外置动态传感器预留通道。")
                    HStack(spacing:12) {
                        capability("HUD",symbol:"windshield.front.and.wiper",detail:"显示出口")
                        capability("TPMS",symbol:"tirepressure",detail:"待协议适配")
                        capability("IMU",symbol:"gyroscope",detail:"待硬件接入")
                    }
                    Text(service.statusMessage).font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(5)
                    HStack { ActionButton(title:"扫描配件",symbol:"antenna.radiowaves.left.and.right") { service.startScanning() };Button("停止") { service.stopScanning() }.font(.system(size:13)).padding(12) }
                    ForEach(service.devices) { device in
                        Button { service.connect(device.id) } label:{ Panel { HStack { Image(systemName:"dot.radiowaves.left.and.right").foregroundStyle(Cyber.cyan);VStack(alignment:.leading,spacing:6) { Text(device.name).font(.system(size:15,weight:.semibold)).foregroundStyle(.white);Text(device.transport + device.rssi.map { " · \($0) dBm" }.defaultingToEmpty).font(Cyber.mono(10)).foregroundStyle(Cyber.muted) };Spacer();Image(systemName:"link").foregroundStyle(Cyber.accent) } } }.buttonStyle(.plain)
                    }
                    if service.devices.isEmpty { EmptyState(symbol:"antenna.radiowaves.left.and.right",title:"等待你的第一件配件",detail:"这里只显示可发现的设备。连接成功后，仍需匹配具体厂商的数据协议。") }
                    Button("断开当前连接") { service.disconnect() }.font(.system(size:12)).foregroundStyle(Cyber.muted)
                    Panel { Text("配件数据保留设备来源、时间戳与单位。没有实时数据时显示未知；不会根据外观或名称假定设备支持胎压、挡位或 HUD 协议。").font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(5) }
                }.padding(24).frame(maxWidth:800)
            }.background(Cyber.ink).navigationTitle("配件").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement:.topBarTrailing) { Button("完成") { dismiss() } } }
        }.onDisappear { service.stopScanning() }
    }
    private func capability(_ name:String,symbol:String,detail:String)->some View { Panel { VStack(spacing:10) { Image(systemName:symbol).font(.system(size:24)).foregroundStyle(Cyber.cyan);Text(name).font(Cyber.mono(13,weight:.bold));Text(detail).font(.system(size:8)).foregroundStyle(Cyber.muted) }.frame(maxWidth:.infinity) } }
}
private extension Optional where Wrapped == String { var defaultingToEmpty:String { self ?? "" } }
