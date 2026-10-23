import SwiftUI
import SwiftData

@main struct MotuoApp: App {
    @State private var engine = RideEngine()
    @State private var settings = AppSettings()
    @Environment(\.scenePhase) private var scenePhase
    private let container: ModelContainer
    init() {
        RoadlogBackground.register()
        // iCloud entitlements (roadlog iCloud Drive) would make SwiftData's default `.automatic` turn on CloudKit sync,
        // which this local store does not support; keep the same local default.store and never sync it via CloudKit.
        do { container = try ModelContainer(for: Vehicle.self, Ride.self, MaintenanceEntry.self, configurations: ModelConfiguration(cloudKitDatabase: .none)) }
        catch { fatalError("本地资料库无法打开。请保留应用数据并联系开发者：\(error)") }
    }
    var body: some Scene {
        WindowGroup {
            RootView().environment(engine).environment(settings)
                .background(Color(red: 0x0B / 255, green: 0x0A / 255, blue: 0x12 / 255).ignoresSafeArea())
                .preferredColorScheme(.dark)
                .tint(Cyber.accent)
                .task { await startRoadlog() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await RoadlogUploadQueue.shared.process() } }
                    if phase == .background, RoadlogUploadQueue.shared.items.contains(where: { $0.state != .uploaded && $0.state != .rejected }) { RoadlogBackground.schedule() }
                }
        }.modelContainer(container)
    }
    /// Launch: seal packages left open by a termination, then resume uploads.
    @MainActor private func startRoadlog() async {
        let queue = RoadlogUploadQueue.shared, settings = settings
        queue.retention = { (max(0, settings.roadlogKeepCount), max(0, settings.roadlogKeepDays)) }
        RoadlogRecorder.shared.upload = queue
        queue.startObserving()
        await RoadlogLibrary.recoverAll()
        await queue.process()
    }
}
