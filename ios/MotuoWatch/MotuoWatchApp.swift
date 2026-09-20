import SwiftUI
import WatchConnectivity
import WatchKit
import Observation

@main struct MotuoWatchApp: App {
    @State private var companion = WatchCompanion()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            WatchDashboard().environment(companion)
                .onChange(of:scenePhase,initial:true) { _,phase in companion.isActive = phase == .active }
        }
    }
}
@MainActor @Observable final class WatchCompanion: NSObject, WCSessionDelegate {
    var context = WatchRideContext(isRiding:false,isSimulated:false,speedKPH:nil,distanceKM:0,elapsedSeconds:0,status:"在 iPhone 开始骑行",updatedAt:.distantPast)
    var isActive = false
    var lastFeedback = "活动时可接收事件反馈"
    var connected = false
    private var gate = HapticGate()
    override init() {
        super.init()
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
    }
    nonisolated func session(_ session:WCSession,activationDidCompleteWith activationState:WCSessionActivationState,error:Error?) {
        let current = session.receivedApplicationContext
        Task { @MainActor in self.connected = session.isReachable; self.receive(current) }
    }
    nonisolated func sessionReachabilityDidChange(_ session:WCSession) { Task { @MainActor in self.connected = session.isReachable } }
    nonisolated func session(_ session:WCSession,didReceiveApplicationContext applicationContext:[String:Any]) { Task { @MainActor in self.receive(applicationContext) } }
    nonisolated func session(_ session:WCSession,didReceiveMessage message:[String:Any]) { Task { @MainActor in self.receive(message) } }
    nonisolated func session(_ session:WCSession,didReceiveMessage message:[String:Any],replyHandler:@escaping ([String:Any])->Void) {
        Task { @MainActor in replyHandler(["requested":self.receive(message)]) }
    }
    @discardableResult private func receive(_ message:[String:Any]) -> Bool {
        if let data = message["rideContext"] as? Data, let update = try? JSONDecoder().decode(WatchRideContext.self,from:data),update.updatedAt >= context.updatedAt {
            context = update
            if update.cleared == true { gate = HapticGate(); lastFeedback = "骑行资料已清除" }
        }
        guard let data = message["hapticEvent"] as? Data,let event = try? JSONDecoder().decode(RideHapticEvent.self,from:data) else { return false }
        guard context.cleared != true || event.createdAt > context.updatedAt else { return false }
        guard gate.accept(event,now:Date(),isActive:isActive) else { lastFeedback = "非活动 / 过期 · 已跳过"; return false }
        let type:WKHapticType = switch event.kind { case .start: .start; case .pause: .stop; case .finish: .success; case .milestone: .notification }
        WKInterfaceDevice.current().play(type); lastFeedback = "已请求触觉 · \(event.kind.rawValue)"; return true
    }
}
struct WatchDashboard: View {
    @Environment(WatchCompanion.self) private var companion
    private let mint = Color(red:0.46,green:0.84,blue:1.0)
    var body: some View {
        TimelineView(.periodic(from:.now,by:1)) { time in
            let stale = time.date.timeIntervalSince(companion.context.updatedAt)>5
            ScrollView {
                VStack(spacing:7) {
                    HStack { Image(systemName:"bolt.horizontal.fill"); Text("MOTUO").font(.system(size:13,weight:.black,design:.rounded)).italic(); Spacer(); Circle().fill(companion.connected ? mint : .gray).frame(width:5,height:5) }.foregroundStyle(mint)
                    if companion.context.isSimulated { Text("DEMO · 模拟数据").font(.system(size:9,weight:.bold)).foregroundStyle(.orange) }
                    if companion.context.isSummary == true {
                        Image(systemName:"flag.checkered").font(.system(size:36)).foregroundStyle(mint).padding(.top,8)
                        Text("骑行完成").font(.system(size:20,weight:.semibold))
                        Text(companion.context.updatedAt.formatted(date:.abbreviated,time:.shortened)).font(.system(size:9)).foregroundStyle(.gray)
                    } else {
                        Text(stale ? "—" : companion.context.speedKPH.map { "\(Int($0.rounded()))" } ?? "—").font(.system(size:65,weight:.light,design:.rounded)).monospacedDigit()
                        Text("KM/H").font(.system(size:9,design:.monospaced)).tracking(3).foregroundStyle(.gray)
                        Text(stale ? "等待 iPhone 实时更新" : companion.context.status).font(.system(size:11)).foregroundStyle(mint)
                    }
                    Divider().padding(.vertical,4)
                    HStack { VStack { Text(String(format:"%.1f",companion.context.distanceKM)).font(.system(size:20,design:.monospaced)); Text("公里").font(.system(size:9)).foregroundStyle(.gray) }; Spacer(); VStack { Text(String(format:"%02d:%02d",Int(companion.context.elapsedSeconds)/60,Int(companion.context.elapsedSeconds)%60)).font(.system(size:20,design:.monospaced)); Text("活动时长").font(.system(size:9)).foregroundStyle(.gray) } }
                    if let destination = companion.context.navTitle {
                        VStack(spacing:4) { Label(destination,systemImage:"location.fill").font(.system(size:11));Text(companion.context.navInstruction ?? "等待导航").font(.system(size:9)).foregroundStyle(.gray) }.padding(.top,7)
                    }
                    Text(companion.lastFeedback).font(.system(size:9)).foregroundStyle(.gray).padding(.top,8)
                }.padding(.horizontal,6)
            }.containerBackground(.black.gradient,for:.navigation)
        }
    }
}
