import SwiftUI
import SwiftData

@main struct MotuoApp: App {
    @State private var engine = RideEngine()
    @State private var settings = AppSettings()
    private let container: ModelContainer
    init() {
        do { container = try ModelContainer(for: Vehicle.self, Ride.self, MaintenanceEntry.self) }
        catch { fatalError("本地资料库无法打开。请保留应用数据并联系开发者：\(error)") }
    }
    var body: some Scene {
        WindowGroup {
            RootView().environment(engine).environment(settings)
                .preferredColorScheme(.dark)
                .tint(Cyber.accent)
        }.modelContainer(container)
    }
}
