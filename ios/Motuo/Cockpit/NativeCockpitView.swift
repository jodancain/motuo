import SwiftUI
import SwiftData
import UIKit

/// Everything the web cockpit renders, as one value. `json()` is the exact payload of window.MotuoNativeReceive
/// (field list in docs/CONTRACT.md and prototypes/motuo-v3/native-adapter.js); tests check it field by field.
struct CockpitSnapshotInput {
    var phase = "idle"                    // idle | riding | paused
    var modal = false, active = true, simulated = false, demoMode = false
    var speedMPS: Double?
    var inertial: (speed: Double, uncertainty: Double)?
    var speedSampleTime: Double?, speedSampleElapsed: Double?
    var sampleTime = 0.0, seconds = 0.0, distanceM = 0.0
    var stateLabel = "准备出发", motion = "ready", locationStatus = ""
    var reduced = false, thermalState = "nominal", lowPower = false, watchReachable = false
    var vehicleModel = "我的摩托"
    var sound: [String: Any] = ["live": false, "status": "麦克风关闭"]
    var musicTitle: String?, musicArtist: String?, musicPlaying = false
    var appearance: [String: String]?
    var panel: (id: UUID, name: String)?
    var finishedRide: [String: Any]?

    func json() -> [String: Any] {
        // Measured GPS wins; a short inertial estimate is shown only while GPS is missing (and is never recorded).
        let speed = speedMPS ?? inertial?.speed
        let source = speedMPS != nil ? "gps" : inertial != nil ? "inertial" : "unavailable"
        var data: [String: Any] = [
            "phase": phase, "modal": modal, "active": active, "simulated": simulated, "demoMode": demoMode,
            "speedKmh": speed.map { $0 * 3.6 } as Any? ?? NSNull(), "speedSource": source,
            "uncertaintyKmh": (inertial?.uncertainty ?? 0) * 3.6, "sampleTime": sampleTime,
            "seconds": seconds, "distanceM": distanceM, "stateLabel": stateLabel, "motion": motion, "locationStatus": locationStatus,
            "reduced": reduced, "thermal": thermalState == "serious" || thermalState == "critical", "thermalState": thermalState, "lowPower": lowPower,
            "watchReachable": watchReachable, "vehicleModel": vehicleModel, "sound": sound,
            "musicTitle": musicTitle as Any? ?? NSNull(), "musicArtist": musicArtist as Any? ?? NSNull(), "musicPlaying": musicPlaying,
        ]
        if speedMPS != nil, let speedSampleTime { data["speedSampleTime"] = speedSampleTime }
        if speedMPS != nil, let speedSampleElapsed { data["speedSampleElapsed"] = speedSampleElapsed }
        data["appearance"] = appearance as Any? ?? NSNull()
        data["panel"] = panel.map { ["id": $0.id.uuidString, "name": $0.name] } as Any? ?? NSNull()
        if let finishedRide { data["finishedRide"] = finishedRide }
        return data
    }
    func encoded() -> String {
        let data = json()
        guard JSONSerialization.isValidJSONObject(data), let encoded = try? JSONSerialization.data(withJSONObject: data), let string = String(data: encoded, encoding: .utf8) else { return "{}" }
        return string
    }
}

/// The finished ride's saved summary for the comic; numbers come only from the stored ride and its journal timeline.
enum CockpitRecap {
    static func payload(ride: Ride, timeline: RideTimeline?) -> [String: Any] {
        var data: [String: Any] = ["id": ride.id.uuidString, "distanceM": ride.distanceM, "durationS": ride.durationS,
            "maxSpeedKmh": ride.validSpeedSamples > 0 ? ride.maxSpeedMPS * 3.6 : NSNull(), "simulated": ride.isSimulated, "validSpeedSamples": ride.validSpeedSamples]
        if let timeline { data.merge(timeline.json) { _, new in new } } else { data["timeline"] = []; data["events"] = [] }
        return data
    }
}

struct SharedImage: Identifiable { let id = UUID(); let url: URL }

/// System share sheet for the comic PNG. Saving to Photos is excluded: that would need a new photo-library usage
/// description; Files / AirDrop / Messages need no extra permission.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    var onDone: () -> Void
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.excludedActivityTypes = [.saveToCameraRoll, .assignToContact]
        controller.completionWithItemsHandler = { _, _, _, _ in onDone() }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct NativeCockpitView:View {
    var isActive = true
    var onNavigate: (AppTab) -> Void = { _ in }
    @Environment(RideEngine.self) private var engine
    @Environment(AppSettings.self) private var settings
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Query(sort:\Vehicle.createdAt) private var vehicles:[Vehicle]
    @State private var snapshot="{}"
    @State private var route:CockpitSheet?
    @State private var confirmFinish=false
    @State private var confirmMicrophone=false
    @State private var webError:String?
    @State private var generation=UUID()
    @State private var share:SharedImage?
    @State private var timeline:(id:UUID,value:RideTimeline)?
    @State private var timelineDeadline=Date.distantPast
    @State private var countdownToken=UUID()
    private var vehicle:Vehicle?{vehicles.first{$0.id==engine.currentRide?.vehicleId} ?? vehicles.first{$0.id.uuidString==settings.selectedVehicleID} ?? vehicles.first}
    private var canOpenUtility:Bool{!engine.isRecording || engine.isSimulated || (engine.speedMPS ?? 99)<1}
    private var visible:Bool{isActive && scenePhase == .active}
    private struct PushKey:Hashable{var phase:ScenePhase;var visible:Bool}
    var body:some View {
        ZStack{
            CockpitWebView(snapshot:snapshot,isActive:isActive,onCommand:command,onError:{webError=$0}).id(generation)
            if let webError{
                VStack(spacing:18){Text(webError).font(.callout);Button("重新载入座舱"){generation=UUID();self.webError=nil};Button("原生记录控制"){route = .fallback}}
                    .padding(24).background(Cyber.panel,in:RoundedRectangle(cornerRadius:22)).padding()
            }
        }.background(Color.black).ignoresSafeArea()
        // Hidden tab or background: the page stops its rAF/audio (snapshot active=false); keep a slow heartbeat only.
        .task(id:PushKey(phase:scenePhase,visible:visible)){
            if scenePhase != .active,EngineSoundService.shared.isCapturing{EngineSoundService.shared.stop("后台已停止")}
            while !Task.isCancelled{snapshot=makeSnapshot();try? await Task.sleep(for:.milliseconds(visible ? 100:1000))}
        }
        .onChange(of:isActive){_,active in
            if !active{EngineSoundService.shared.stop();engine.cockpitCountdown=false}
            snapshot=makeSnapshot()
        }
        // Tell the web layer at once when a native dialog, sheet or system alert covers it.
        .onChange(of:confirmFinish){_,_ in snapshot=makeSnapshot()}
        .onChange(of:confirmMicrophone){_,_ in snapshot=makeSnapshot()}
        .onChange(of:route){_,_ in snapshot=makeSnapshot()}
        .onChange(of:share?.id){_,_ in snapshot=makeSnapshot()}
        .onChange(of:scenePhase){_,_ in snapshot=makeSnapshot()}
        .onChange(of:webError){_,error in if error != nil{engine.wrappedPending=false;engine.cockpitCountdown=false}}
        .onChange(of:engine.isPaused){_,paused in if paused{EngineSoundService.shared.stop("骑行暂停 · 声音已停止")}}
        .onChange(of:engine.currentRide?.id){_,id in if id == nil{EngineSoundService.shared.stop()};snapshot=makeSnapshot()}
        .onChange(of:settings.cockpitPanelRequest?.id){_,_ in snapshot=makeSnapshot()}
        .sheet(item:$route){item in
            NavigationStack{
                Group{
                    switch item{
                    case .garage:GarageView()
                    case .history:RideHistoryView()
                    case .settings:SettingsView()
                    case .music:MusicLibraryView()
                    case .fallback:DashboardView(landscape:false)
                    case .navigation:
                        VStack(alignment:.leading,spacing:20){
                            Image(systemName:"map").font(.largeTitle).foregroundStyle(Cyber.cyan)
                            Text("开源导航 · 服务准备中").font(.title2.bold())
                            Text("MapLibre + OSM + Valhalla 摩托算路。区域地图与 NAS 路线服务尚未上线，当前没有可用真实路线。")
                            Text("新版不再打开高德，也不会展示虚构路线作为真实导航。骑行记录仍可独立使用。").foregroundStyle(Cyber.muted)
                            Spacer()
                        }.padding(24).background(Cyber.ink)
                    }
                }.toolbar{ToolbarItem(placement:.topBarTrailing){Button("返回座舱"){route=nil}}}
            }.preferredColorScheme(.dark)
        }
        .sheet(item:$share){item in ShareSheet(items:[item.url]){share=nil}.presentationDetents([.medium,.large])}
        .confirmationDialog("结束这次骑行？",isPresented:$confirmFinish,titleVisibility:.visible){
            Button("结束并生成复盘"){
                EngineSoundService.shared.stop();engine.wrappedAcknowledged=false;engine.wrappedPending=webError == nil
                engine.finish()
                if let ride=engine.lastFinishedRide{loadTimeline(ride)}else{engine.wrappedPending=false}
                scheduleWrappedFallback()
            }
            Button("继续骑行",role:.cancel){}
        }message:{Text("原生记录先安全保存在手机，随后生成本地复盘。")}
        .confirmationDialog("用手机麦克风聆听声浪",isPresented:$confirmMicrophone,titleVisibility:.visible){
            Button("启用麦克风"){Task{await EngineSoundService.shared.start()}}
            Button("取消",role:.cancel){}
        }message:{Text("只在本机分析混合环境声音，不保存、不上传原音。声浪光效与音乐独立；暂不识别发动机、转速或油门。切后台、暂停和结束会停止。")}
    }
    private func command(_ c:CockpitCommand){
        switch c.action{
        case "primary":
            if engine.currentRide == nil{engine.cockpitCountdown=false;if let vehicle{engine.start(vehicle:vehicle)}}else if engine.isPaused{engine.resume()}else{engine.pause()}
        case "demoStart":
            guard engine.currentRide == nil,let vehicle else{engine.cockpitCountdown=false;return}
            // v3: one explicitly simulated ride; the demo setting itself stays as the user left it.
            if CockpitBundle.isV3{engine.start(vehicle:vehicle,simulated:true)}else{settings.demoMode=true;engine.start(vehicle:vehicle)}
        case "countdown":
            // The departure countdown runs before recording; hide the tab bar meanwhile, with a safety timeout.
            guard engine.currentRide == nil,visible else{return}
            engine.cockpitCountdown=true;let token=UUID();countdownToken=token
            Task{try? await Task.sleep(for:.seconds(9));if countdownToken==token,engine.currentRide == nil{engine.cockpitCountdown=false}}
        case "countdownCancel":engine.cockpitCountdown=false
        case "finish":confirmFinish=engine.currentRide != nil
        case "microphone":
            if EngineSoundService.shared.isCapturing || EngineSoundService.shared.status == "等待麦克风授权"{EngineSoundService.shared.stop()}
            else if scenePhase == .active && !engine.isPaused{confirmMicrophone=true}
        case "stopMicrophone":EngineSoundService.shared.stop()
        case "appearance":
            if let paint=c.paint{settings.cockpitPaint=paint}
            if let finish=c.finish{settings.cockpitFinish=finish}
            if let world=c.world{settings.cockpitWorld=world}
        case "share":
            guard let data=c.image,UIImage(data:data) != nil else{return}
            let formatter=DateFormatter();formatter.dateFormat="yyyyMMdd-HHmm"
            let directory=FileManager.default.temporaryDirectory.appendingPathComponent("MotuoShare",isDirectory:true)
            try? FileManager.default.removeItem(at:directory);try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
            let url=directory.appendingPathComponent("motuo-ride-comic-\(formatter.string(from:Date())).png")
            do{try data.write(to:url,options:.atomic);share=SharedImage(url:url)}catch{engine.errorMessage="图片暂时无法分享：\(error.localizedDescription)"}
        case "wrappedShown":engine.wrappedAcknowledged=true
        case "rideDetail":engine.wrappedPending=false
        case "wrappedDone":engine.wrappedPending=false;engine.lastFinishedRide=nil
        case "musicToggle":Task{await MusicService.shared.togglePlayback()}
        case "musicNext":Task{await MusicService.shared.skipNext()}
        case "musicPrevious":Task{await MusicService.shared.skipPrevious()}
        case "musicLibrary":if canOpenUtility{EngineSoundService.shared.stop();route = .music}
        case "garage" where CockpitBundle.isV3:
            // Single navigation: the cockpit's vehicle-profile link switches to the native 车库 tab.
            if canOpenUtility{EngineSoundService.shared.stop();onNavigate(.garage)}
        case "garage","history","settings","navigation":
            if canOpenUtility{EngineSoundService.shared.stop();route=CockpitSheet(rawValue:c.action)}
        default:break
        }
        snapshot=makeSnapshot()
    }
    // If the web recap never confirms it started, fall back to the native recap sheet.
    private func scheduleWrappedFallback(){
        Task{try? await Task.sleep(for:.seconds(4));if !engine.wrappedAcknowledged{engine.wrappedPending=false}}
    }
    // Read the saved journal off the main thread; the recap waits for it briefly, then goes without a timeline.
    private func loadTimeline(_ ride:Ride){
        let id=ride.id,events=ride.events;timelineDeadline=Date().addingTimeInterval(2.5)
        Task{
            let value=await Task.detached(priority:.userInitiated){RideTimeline.build(samples:TelemetryJournal.routeSamples(rideId:id),events:events)}.value
            if engine.lastFinishedRide?.id == id{timeline=(id,value);snapshot=makeSnapshot()}
        }
    }
    private var finishedRideSummary:[String:Any]?{
        guard engine.wrappedPending,let ride=engine.lastFinishedRide else{return nil}
        if let timeline,timeline.id==ride.id{return CockpitRecap.payload(ride:ride,timeline:timeline.value)}
        return Date()<timelineDeadline ? nil:CockpitRecap.payload(ride:ride,timeline:nil)
    }
    private func makeSnapshot()->String{
        let sound=EngineSoundService.shared,music=MusicService.shared
        let estimate=engine.inertialPresentation
        let speed=engine.speedMPS ?? estimate?.speed
        let phase=engine.currentRide == nil ? "idle":engine.isPaused ? "paused":"riding"
        let motion=phase=="idle" ? "ready":speed == nil ? "gps":speed!<0.2 ? "stop":engine.elapsedSeconds<4 ? "launch":abs(engine.turnDirection)>0.25 ? "turn":engine.longitudinalTrend>0 ? "accelerate":engine.longitudinalTrend<0 ? "brake":"cruise"
        let live=sound.live && ProcessInfo.processInfo.systemUptime-sound.sampleUptime<1 && scenePhase == .active && !engine.isPaused
        var audio:[String:Any]=["live":live,"status":sound.status]
        if live,let f=sound.features{audio.merge(["level":f.level,"db":f.db,"clipped":f.clipped,"spectrum":f.spectrum,"wave":f.wave]){_,new in new}}
        var appearance:[String:String]=[:]
        if let p=settings.cockpitPaint{appearance["paint"]=p};if let f=settings.cockpitFinish{appearance["finish"]=f};if let w=settings.cockpitWorld{appearance["world"]=w}
        var input=CockpitSnapshotInput()
        input.phase=phase;input.active=visible;input.simulated=engine.isSimulated;input.demoMode=settings.demoMode
        input.modal=confirmFinish || confirmMicrophone || route != nil || share != nil || scenePhase != .active || webError != nil
        input.speedMPS=engine.speedMPS;input.inertial=estimate;input.speedSampleTime=engine.speedSampleTime;input.speedSampleElapsed=engine.speedSampleElapsed
        input.sampleTime=ProcessInfo.processInfo.systemUptime;input.seconds=engine.elapsedSeconds;input.distanceM=engine.currentRide?.distanceM ?? 0
        input.stateLabel=engine.stateLabel;input.motion=motion
        input.locationStatus=engine.isSimulated ? "DEMO · 模拟定位":estimate != nil ? "GPS 缺失 · IMU 估速":engine.locationStatus
        input.reduced=settings.reducedEffects || reduceMotion;input.thermalState=engine.thermalState;input.lowPower=engine.lowPowerMode
        input.watchReachable=WatchBridge.shared.isReachable;input.vehicleModel=vehicle?.model ?? "我的摩托";input.sound=audio
        input.musicTitle=music.currentTitle;input.musicArtist=music.currentArtist;input.musicPlaying=music.isPlaying
        input.appearance=appearance.isEmpty ? nil:appearance;input.panel=settings.cockpitPanelRequest
        input.finishedRide=finishedRideSummary
        return input.encoded()
    }
}
private enum CockpitSheet:String,Identifiable{case garage,history,settings,music,navigation,fallback;var id:String{rawValue}}
