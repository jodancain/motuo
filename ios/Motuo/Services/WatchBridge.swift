import Foundation
import WatchConnectivity
import Observation

@MainActor @Observable final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()
    var isReachable = false
    var isPaired = false
    var isInstalled = false
    var status = "尚未连接"
    private var session: WCSession?
    private var pendingContext: WatchRideContext?
    func activate() {
        guard WCSession.isSupported(), session == nil else { return }
        if pendingContext == nil, let data = UserDefaults.standard.data(forKey: "watch.pendingClear") { pendingContext = try? JSONDecoder().decode(WatchRideContext.self, from: data) }
        let session = WCSession.default; self.session = session; session.delegate = self; session.activate()
    }
    func clear() {
        let context = WatchRideContext(isRiding: false, isSimulated: false, speedKPH: nil, distanceKM: 0, elapsedSeconds: 0, status: "资料已清除", updatedAt: Date(), cleared: true)
        if let data = try? JSONEncoder().encode(context) { UserDefaults.standard.set(data, forKey: "watch.pendingClear") }
        update(context)
    }
    func update(_ context: WatchRideContext) {
        pendingContext = context
        guard let session, session.activationState == .activated,
              let data = try? JSONEncoder().encode(context) else { return }
        do { try session.updateApplicationContext(["rideContext": data]); UserDefaults.standard.removeObject(forKey: "watch.pendingClear") } catch { /* Retain a pending clear across relaunch until accepted by WatchConnectivity. */ }
        if session.isReachable { session.sendMessage(["rideContext": data], replyHandler: nil, errorHandler: nil) }
    }
    func sendHaptic(_ kind: RideHapticEvent.Kind) {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: "watchHaptics") as? Bool ?? true else { return }
        let key: String? = switch kind { case .start: "watchStartHaptics"; case .finish: "watchFinishHaptics"; case .milestone: "watchMilestoneHaptics"; case .pause: nil }
        if let key, !(defaults.object(forKey: key) as? Bool ?? true) { return }
        guard let session, session.activationState == .activated, session.isReachable,
              let data = try? JSONEncoder().encode(RideHapticEvent(kind: kind)) else { status = "手表不可达 · 已跳过反馈"; return }
        session.sendMessage(["hapticEvent": data], replyHandler: { [weak self] reply in
            Task { @MainActor in self?.status = reply["requested"] as? Bool == true ? "手表已请求触觉" : "手表已跳过反馈" }
        }, errorHandler: { [weak self] _ in Task { @MainActor in self?.status = "触觉未送达 · 不补发" } })
    }
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.refresh(session); if let pending = self.pendingContext { self.update(pending) } }
    }
    nonisolated func sessionReachabilityDidChange(_ session: WCSession) { Task { @MainActor in self.refresh(session) } }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) { Task { @MainActor in self.isReachable = false } }
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    private func refresh(_ session: WCSession) {
        isReachable = session.isReachable; isPaired = session.isPaired; isInstalled = session.isWatchAppInstalled
        status = isReachable ? "手表活动可达" : isPaired ? "已配对 · 等待手表活动" : "未配对 Apple Watch"
    }
}
