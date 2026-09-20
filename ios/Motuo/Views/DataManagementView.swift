import SwiftUI
import SwiftData

struct DataManagementView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(RideEngine.self) private var engine
    @Environment(AppSettings.self) private var settings
    @Query(sort:\Ride.startedAt,order:.reverse) private var rides: [Ride]
    @Query private var vehicles: [Vehicle]
    @Query private var maintenance: [MaintenanceEntry]
    @State private var manuals: [ManualRecord] = []
    @State private var pending: Deletion?
    @State private var confirming = false
    @State private var busy = false
    @State private var status = "删除不可撤回；NAS 备份按管理员保留周期轮换。"
    private enum Deletion { case ride(Ride), manual(ManualRecord), account }
    private var locked: Bool { busy || engine.currentRide != nil || !CloudRideSync.shared.activeRideIDs.isEmpty }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(status).font(.footnote)
                    if engine.currentRide != nil { Text("先结束骑行，再管理数据。").foregroundStyle(.orange) }
                    if !APIClient.shared.isPaired { Text("未配对时只删除手机记录；NAS 数据需连接后管理。").font(.footnote) }
                }
                Section("骑行记录") {
                    ForEach(rides) { ride in
                        HStack {
                            VStack(alignment:.leading) { Text(ride.vehicleName); Text(ride.startedAt.formatted(date:.abbreviated,time:.shortened)).font(.caption) }
                            Spacer()
                            Button("删除",role:.destructive) { pending = .ride(ride); confirming = true }.disabled(locked)
                        }
                    }
                }
                if APIClient.shared.isPaired {
                    Section("NAS 维修手册") {
                        ForEach(manuals) { manual in
                            HStack { Text(manual.fileName).lineLimit(2); Spacer(); Button("删除",role:.destructive) { pending = .manual(manual); confirming = true }.disabled(locked) }
                        }
                    }
                    Section("全部账户数据") {
                        Text("删除当前 NAS 账户的全部车辆、骑行、手册、保养及设备令牌，同时清除本机资料。其他配对设备将失去服务访问权限；它们已有的离线副本需要在对应设备删除。").font(.footnote)
                        Button("删除当前账户及本机资料",role:.destructive) { pending = .account; confirming = true }.disabled(locked)
                    }
                }
                Section { Button("清除本机 PDF 阅读缓存") { APIClient.shared.clearManualCache(); status = "已清除本机 PDF 缓存，NAS 原件保留。" }.disabled(locked) }
            }.navigationTitle("数据管理").toolbar { ToolbarItem(placement:.topBarTrailing) { Button("完成") { dismiss() }.disabled(busy) } }
        }.task { await loadManuals() }
        .confirmationDialog("确认永久删除所选资料？",isPresented:$confirming,titleVisibility:.visible) {
            Button("确认删除",role:.destructive) { Task { await remove() } }
            Button("取消",role:.cancel) { pending = nil }
        }
    }
    private func loadManuals() async {
        guard APIClient.shared.isPaired else { return }
        do { let result: ItemsResponse<ManualRecord> = try await APIClient.shared.request("/v1/manuals"); manuals = result.items }
        catch { status = error.localizedDescription }
    }
    private func deleteRemote(_ path: String) async throws {
        do { let _: EmptyAPIResponse = try await APIClient.shared.request(path,method:"DELETE") }
        catch let error as APIClientError where error.statusCode == 404 { /* Already absent. */ }
    }
    private func remove() async {
        guard !locked, let pending else { return }
        busy = true; defer { busy = false; self.pending = nil }
        do {
            switch pending {
            case .ride(let ride):
                if APIClient.shared.isPaired { try await deleteRemote("/v1/rides/\(ride.id.uuidString)") }
                let folder = TelemetryJournal.root.appendingPathComponent(ride.id.uuidString,isDirectory:true)
                if FileManager.default.fileExists(atPath:folder.path) { try FileManager.default.removeItem(at:folder) }
                try VehicleLearningService.shared.invalidate(rideId: ride.id, remove: true)
                context.delete(ride); try context.save()
                status = APIClient.shared.isPaired ? "已删除该次骑行的本机和 NAS 记录。" : "已删除本机骑行记录；当前未连接 NAS。"
            case .manual(let manual):
                try await deleteRemote("/v1/manuals/\(manual.id)"); APIClient.shared.clearManualCache(); await loadManuals(); status = "已删除 NAS 手册原件、检索资料和本机阅读缓存。"
            case .account:
                if !UserDefaults.standard.bool(forKey:"accountDeletion.localCleanupPending") {
                    try await deleteRemote("/v1/account")
                    UserDefaults.standard.set(true,forKey:"accountDeletion.localCleanupPending")
                }
                for ride in rides { context.delete(ride) }; for item in maintenance { context.delete(item) }; for vehicle in vehicles { context.delete(vehicle) }
                try context.save()
                if FileManager.default.fileExists(atPath:TelemetryJournal.root.path) { try FileManager.default.removeItem(at:TelemetryJournal.root) }
                try VehicleLearningService.shared.eraseAll()
                try SensorCalibrationService.shared.eraseAll()
                if let identifier = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName:identifier) }
                engine.clearWatchSummary()
                APIClient.shared.unpair(); settings.selectedVehicleID = ""; settings.autoSync = false
                manuals = []; status = "账户及本机资料已删除。其他设备的离线副本需在对应设备删除。"
            }
        } catch { status = "删除未完成：\(error.localizedDescription)。可以重试。" }
    }
}
