import Foundation
import Observation

@MainActor @Observable final class AppSettings {
    var demoMode: Bool { didSet { UserDefaults.standard.set(demoMode, forKey: "demoMode") } }
    var keepScreenOn: Bool { didSet { UserDefaults.standard.set(keepScreenOn, forKey: "keepScreenOn") } }
    var watchHaptics: Bool { didSet { UserDefaults.standard.set(watchHaptics, forKey: "watchHaptics") } }
    var watchStartHaptics: Bool { didSet { UserDefaults.standard.set(watchStartHaptics, forKey: "watchStartHaptics") } }
    var watchFinishHaptics: Bool { didSet { UserDefaults.standard.set(watchFinishHaptics, forKey: "watchFinishHaptics") } }
    var watchMilestoneHaptics: Bool { didSet { UserDefaults.standard.set(watchMilestoneHaptics, forKey: "watchMilestoneHaptics") } }
    var reducedEffects: Bool { didSet { UserDefaults.standard.set(reducedEffects, forKey: "reducedEffects") } }
    var autoSync: Bool { didSet { UserDefaults.standard.set(autoSync, forKey: "autoSync") } }
    var selectedVehicleID: String { didSet { UserDefaults.standard.set(selectedVehicleID, forKey: "selectedVehicleID") } }
    /// Comic-cockpit appearance (v3 paint / finish / world). Native owns persistence so the garage and the web scene agree.
    var cockpitPaint: String? { didSet { UserDefaults.standard.set(cockpitPaint, forKey: "cockpitPaint") } }
    var cockpitFinish: String? { didSet { UserDefaults.standard.set(cockpitFinish, forKey: "cockpitFinish") } }
    var cockpitWorld: String? { didSet { UserDefaults.standard.set(cockpitWorld, forKey: "cockpitWorld") } }
    /// One-shot request for the cockpit to open a scene panel (e.g. the garage's “外观与配色” entry). Not persisted.
    var cockpitPanelRequest: (id: UUID, name: String)?
    func requestCockpitPanel(_ name: String) { cockpitPanelRequest = (UUID(), name) }
    init() {
        let d = UserDefaults.standard
        demoMode = d.bool(forKey: "demoMode"); keepScreenOn = d.object(forKey: "keepScreenOn") as? Bool ?? true
        watchHaptics = d.object(forKey: "watchHaptics") as? Bool ?? true
        watchStartHaptics = d.object(forKey: "watchStartHaptics") as? Bool ?? true
        watchFinishHaptics = d.object(forKey: "watchFinishHaptics") as? Bool ?? true
        watchMilestoneHaptics = d.object(forKey: "watchMilestoneHaptics") as? Bool ?? true
        reducedEffects = d.bool(forKey: "reducedEffects"); autoSync = d.object(forKey: "autoSync") as? Bool ?? true
        selectedVehicleID = d.string(forKey: "selectedVehicleID") ?? ""
        cockpitPaint = d.string(forKey: "cockpitPaint"); cockpitFinish = d.string(forKey: "cockpitFinish"); cockpitWorld = d.string(forKey: "cockpitWorld")
    }
}

enum RideFormat {
    static func elapsed(_ seconds: Double) -> String {
        let value = max(0, Int(seconds)); return String(format: "%02d:%02d:%02d", value / 3600, (value / 60) % 60, value % 60)
    }
    static func distance(_ meters: Double) -> String { String(format: "%.1f", meters / 1000) }
    static func speed(_ mps: Double?) -> String { mps.map { String(Int(($0 * 3.6).rounded())) } ?? "—" }
}
