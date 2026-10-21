import SwiftUI
import SwiftData

struct NativeCockpitView:View {
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
    private var vehicle:Vehicle?{vehicles.first{$0.id==engine.currentRide?.vehicleId} ?? vehicles.first{$0.id.uuidString==settings.selectedVehicleID} ?? vehicles.first}
    private var canOpenUtility:Bool{!engine.isRecording || engine.isSimulated || (engine.speedMPS ?? 99)<1}
    var body:some View {
        ZStack{
            CockpitWebView(snapshot:snapshot,onCommand:command,onError:{webError=$0}).id(generation)
            if let webError{
                VStack(spacing:18){Text(webError).font(.callout);Button("重新载入座舱"){generation=UUID();self.webError=nil};Button("原生记录控制"){route = .fallback}}
                    .padding(24).background(Cyber.panel,in:RoundedRectangle(cornerRadius:22)).padding()
            }
        }.background(Color.black).ignoresSafeArea()
        .statusBarHidden(engine.currentRide != nil)
        .persistentSystemOverlays(engine.currentRide != nil ? .hidden:.automatic)
        .task(id:scenePhase){
            guard scenePhase == .active else{EngineSoundService.shared.stop("后台已停止");return}
            while !Task.isCancelled{snapshot=makeSnapshot();try? await Task.sleep(for:.milliseconds(100))}
        }
        .onDisappear{EngineSoundService.shared.stop();engine.wrappedPending=false}
        // Tell the web layer at once when a native dialog, sheet or system alert covers it.
        .onChange(of:confirmFinish){_,_ in snapshot=makeSnapshot()}
        .onChange(of:confirmMicrophone){_,_ in snapshot=makeSnapshot()}
        .onChange(of:route){_,_ in snapshot=makeSnapshot()}
        .onChange(of:scenePhase){_,_ in snapshot=makeSnapshot()}
        .onChange(of:webError){_,error in if error != nil{engine.wrappedPending=false}}
        .onChange(of:engine.isPaused){_,paused in if paused{EngineSoundService.shared.stop("骑行暂停 · 声音已停止")}}
        .onChange(of:engine.currentRide?.id){_,id in if id == nil{EngineSoundService.shared.stop()}}
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
        .confirmationDialog("结束这次骑行？",isPresented:$confirmFinish,titleVisibility:.visible){
            Button("结束并生成复盘"){EngineSoundService.shared.stop();engine.wrappedAcknowledged=false;engine.wrappedPending=webError == nil;engine.finish();scheduleWrappedFallback()}
            Button("继续骑行",role:.cancel){}
        }message:{Text("原生记录先安全保存在手机，随后生成本地复盘。")}
        .confirmationDialog("用手机麦克风聆听声浪",isPresented:$confirmMicrophone,titleVisibility:.visible){
            Button("启用麦克风"){Task{await EngineSoundService.shared.start()}}
            Button("取消",role:.cancel){}
        }message:{Text("只在本机分析混合环境声音，不保存、不上传原音。声浪光效与音乐独立；暂不识别发动机、转速或油门。切后台、暂停和结束会停止。")}
    }
    private func command(_ action:String){
        switch action{
        case "primary":
            if engine.currentRide == nil{if let vehicle{engine.start(vehicle:vehicle)}}else if engine.isPaused{engine.resume()}else{engine.pause()}
        case "demoStart":
            guard engine.currentRide == nil,let vehicle else{return};settings.demoMode=true;engine.start(vehicle:vehicle)
        case "finish":confirmFinish=engine.currentRide != nil
        case "microphone":
            if EngineSoundService.shared.isCapturing || EngineSoundService.shared.status == "等待麦克风授权"{EngineSoundService.shared.stop()}
            else if scenePhase == .active && !engine.isPaused{confirmMicrophone=true}
        case "stopMicrophone":EngineSoundService.shared.stop()
        case "wrappedShown":engine.wrappedAcknowledged=true
        case "rideDetail":engine.wrappedPending=false
        case "wrappedDone":engine.wrappedPending=false;engine.lastFinishedRide=nil
        case "musicToggle":Task{await MusicService.shared.togglePlayback()}
        case "musicNext":Task{await MusicService.shared.skipNext()}
        case "musicPrevious":Task{await MusicService.shared.skipPrevious()}
        case "musicLibrary":if canOpenUtility{EngineSoundService.shared.stop();route = .music}
        case "garage","history","settings","navigation":
            if canOpenUtility{EngineSoundService.shared.stop();route=CockpitSheet(rawValue:action)}
        default:break
        }
        snapshot=makeSnapshot()
    }
    // If the web recap never confirms it started, fall back to the native recap sheet.
    private func scheduleWrappedFallback(){
        Task{try? await Task.sleep(for:.seconds(4));if !engine.wrappedAcknowledged{engine.wrappedPending=false}}
    }
    private var finishedRideSummary:[String:Any]?{
        guard engine.wrappedPending,let ride=engine.lastFinishedRide else{return nil}
        return ["id":ride.id.uuidString,"distanceM":ride.distanceM,"durationS":ride.durationS,"maxSpeedKmh":ride.maxSpeedMPS*3.6,"simulated":ride.isSimulated,"validSpeedSamples":ride.validSpeedSamples]
    }
    private func makeSnapshot()->String{
        let sound=EngineSoundService.shared,music=MusicService.shared
        let estimate=engine.inertialPresentation
        let speed=engine.speedMPS ?? estimate?.speed
        let source=engine.speedMPS != nil ? "gps":estimate != nil ? "inertial":"unavailable"
        let phase=engine.currentRide == nil ? "idle":engine.isPaused ? "paused":"riding"
        let motion=phase=="idle" ? "ready":speed == nil ? "gps":speed!<0.2 ? "stop":engine.elapsedSeconds<4 ? "launch":abs(engine.turnDirection)>0.25 ? "turn":engine.longitudinalTrend>0 ? "accelerate":engine.longitudinalTrend<0 ? "brake":"cruise"
        let live=sound.live && ProcessInfo.processInfo.systemUptime-sound.sampleUptime<1 && scenePhase == .active && !engine.isPaused
        var audio:[String:Any]=["live":live,"status":sound.status]
        if live,let f=sound.features{audio.merge(["level":f.level,"db":f.db,"clipped":f.clipped,"spectrum":f.spectrum,"wave":f.wave]){_,new in new}}
        var data:[String:Any]=[
            "modal":confirmFinish || confirmMicrophone || route != nil || scenePhase != .active || webError != nil,
            "phase":phase,"simulated":engine.isSimulated,"speedKmh":speed.map{$0*3.6} as Any? ?? NSNull(),"speedSource":source,
            "uncertaintyKmh":(estimate?.uncertainty ?? 0)*3.6,"sampleTime":ProcessInfo.processInfo.systemUptime,
            "seconds":engine.elapsedSeconds,"distanceM":engine.currentRide?.distanceM ?? 0,"stateLabel":engine.stateLabel,"motion":motion,
            "locationStatus":engine.isSimulated ? "DEMO · 模拟定位":estimate != nil ? "GPS 缺失 · IMU 估速":engine.locationStatus,
            "reduced":settings.reducedEffects || reduceMotion,"thermal":engine.thermalLimited,"watchReachable":WatchBridge.shared.isReachable,
            "vehicleModel":vehicle?.model ?? "我的摩托","sound":audio,"musicTitle":music.currentTitle,"musicArtist":music.currentArtist,"musicPlaying":music.isPlaying
        ]
        if let finished=finishedRideSummary{data["finishedRide"]=finished}
        guard JSONSerialization.isValidJSONObject(data),let encoded=try? JSONSerialization.data(withJSONObject:data),let string=String(data:encoded,encoding:.utf8)else{return "{}"}
        return string
    }
}
private enum CockpitSheet:String,Identifiable{case garage,history,settings,music,navigation,fallback;var id:String{rawValue}}
