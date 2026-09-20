import SwiftUI
import SwiftData

struct RootView: View {
    @Environment(\.modelContext) private var context
    @Environment(RideEngine.self) private var engine
    @Environment(AppSettings.self) private var settings
    @Query(sort: \Vehicle.createdAt) private var vehicles: [Vehicle]
    @State private var tab: AppTab = .cockpit
    @State private var didConfigure = false
    var body: some View {
        GeometryReader { geometry in
            let landscape = geometry.size.width > geometry.size.height
            HStack(spacing: 0) {
                if landscape { tabBar(vertical: true).frame(width: 66) }
                VStack(spacing: 0) {
                    Group {
                        switch tab {
                        case .cockpit: DashboardView(landscape: landscape)
                        case .garage: GarageView()
                        case .rides: RideHistoryView()
                        case .settings: SettingsView()
                        }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    if !landscape { tabBar(vertical: false) }
                }
            }.background(Cyber.ink)
        }
        .task {
            guard !didConfigure else { return }; didConfigure = true
            if vehicles.isEmpty { let vehicle = Vehicle(); context.insert(vehicle); settings.selectedVehicleID = vehicle.id.uuidString; UserDefaults.standard.set(vehicle.id.uuidString,forKey:"autoSeedVehicleID"); try? context.save() }
            engine.configure(context: context, settings: settings)
            try? await CloudGarageSync.restore(context:context,settings:settings)
        }
        .alert("记录提示", isPresented: Binding(get: { engine.errorMessage != nil }, set: { if !$0 { engine.errorMessage = nil } })) {
            Button("知道了") { engine.errorMessage = nil }
        } message: { Text(engine.errorMessage ?? "") }
        .sheet(item: Binding(get: { engine.lastFinishedRide }, set: { engine.lastFinishedRide = $0 })) { ride in
            NavigationStack { RideDetailView(ride: ride).toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { engine.lastFinishedRide = nil } } } }
        }
    }
    private func tabBar(vertical: Bool) -> some View {
        let layout = vertical ? AnyLayout(VStackLayout(spacing: 24)) : AnyLayout(HStackLayout(spacing: 0))
        return layout {
            ForEach(AppTab.allCases) { item in
                Button {
                    if !engine.isRecording || engine.isSimulated || (engine.speedMPS ?? 99) < 1 { tab = item }
                } label: {
                    VStack(spacing: 6) {
                        Image(systemName: item.symbol).font(.system(size: 19, weight: tab == item ? .semibold : .regular))
                        Text(item.title).font(.system(size: 9, weight: .medium))
                    }.foregroundStyle(tab == item ? Cyber.accent : Cyber.muted)
                        .frame(maxWidth: .infinity).frame(height: 50)
                        .overlay(alignment: .top) { if tab == item { Capsule().fill(Cyber.accent).frame(width: 18,height: 2).offset(y: -7) } }
                }.buttonStyle(.plain)
                    .accessibilityLabel(item.title)
                    .accessibilityIdentifier("tab.\(item.rawValue)")
                    .accessibilityHint(engine.isRecording ? "骑行中请停车后切换" : "")
            }
        }.padding(.vertical, vertical ? 24 : 12).padding(.horizontal, vertical ? 6 : 14)
            .background(Cyber.ink).overlay(alignment: vertical ? .trailing : .top) { Rectangle().fill(Cyber.stroke).frame(width: vertical ? 1 : nil, height: vertical ? nil : 1) }
    }
}
enum AppTab: String, CaseIterable, Identifiable {
    case cockpit, garage, rides, settings
    var id: String { rawValue }
    var title: String { switch self { case .cockpit: return "驾驶舱"; case .garage: return "车库"; case .rides: return "骑行档案"; case .settings: return "控制中心" } }
    var symbol: String { switch self { case .cockpit: return "gauge.with.dots.needle.67percent"; case .garage: return "motorcycle"; case .rides: return "point.topleft.down.to.point.bottomright.curvepath"; case .settings: return "slider.horizontal.3" } }
}
