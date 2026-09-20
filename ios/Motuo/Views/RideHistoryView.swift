import SwiftUI
import SwiftData
import MapKit
#if canImport(Lottie)
import Lottie
#endif

struct RideHistoryView:View {
    @Query(sort:\Ride.startedAt,order:.reverse) private var rides:[Ride]
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:22) {
                    PageTitle(eyebrow:"RIDE ARCHIVE",title:"每一程，都有回响",subtitle:"路线、动态片段和关于你的机器的新发现。")
                    let finished=rides.filter { $0.isFinished }
                    Panel { HStack { Metric(title:"RIDES",value:"\(finished.filter { !$0.isSimulated }.count)",unit:"次");Metric(title:"TOTAL DISTANCE",value:RideFormat.distance(finished.filter { !$0.isSimulated }.reduce(0){$0+$1.distanceM}),unit:"km",accent:Cyber.accent) } }
                    if rides.isEmpty { EmptyState(symbol:"point.topleft.down.to.point.bottomright.curvepath",title:"第一程，即将开始",detail:"开启一次骑行，这里就会留下\n属于你和这辆摩托的旅程。") }
                    ForEach(rides) { ride in
                        NavigationLink { RideDetailView(ride:ride) } label:{
                            Panel {
                                VStack(alignment:.leading,spacing:16) {
                                    HStack { Text(ride.startedAt.formatted(.dateTime.month(.twoDigits).day(.twoDigits))).font(Cyber.mono(24,weight:.medium));Text(ride.startedAt.formatted(.dateTime.hour().minute())).font(Cyber.mono(12)).foregroundStyle(Cyber.muted);Spacer();StatusPill(text:ride.isSimulated ? "DEMO" : ride.isFinished ? "RIDE" : "未结束",color:ride.isSimulated ? Cyber.orange : Cyber.accent) }
                                    HStack { VStack(alignment:.leading,spacing:7) { Text(ride.vehicleName).font(.system(size:13));Text("\(RideFormat.elapsed(ride.durationS)) · \(ride.events.count) 个动态片段").font(.system(size:11)).foregroundStyle(Cyber.muted) };Spacer();Text(RideFormat.distance(ride.distanceM)).font(Cyber.mono(29,weight:.semibold)).foregroundStyle(Cyber.accent);Text("km").font(Cyber.mono(10)).foregroundStyle(Cyber.muted);Image(systemName:"chevron.right").font(.system(size:10)).foregroundStyle(Cyber.muted) }
                                }.foregroundStyle(.white)
                            }
                        }.buttonStyle(.plain)
                    }
                }.padding(24).frame(maxWidth:850)
            }.background(Cyber.ink).toolbar(.hidden,for:.navigationBar)
        }
    }
}

struct RideDetailView:View {
    @Bindable var ride:Ride
    @Environment(\.modelContext) private var context
    @Environment(RideEngine.self) private var engine
    @Environment(AppSettings.self) private var settings
    @Query private var vehicles:[Vehicle]
    @State private var samples:[TelemetrySample]=[]
    @State private var replayIndex=0.0
    @State private var isReplaying=false
    @State private var confirming:RideEvent?
    @State private var note=""
    @State private var timer:Timer?
    var body:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:22) {
                HStack { PageTitle(eyebrow:ride.isSimulated ? "DEMO RECAP" : "RIDE RECAP",title:ride.isFinished ? "好好收尾，下次见" : "骑行记录",subtitle:ride.startedAt.formatted(.dateTime.year().month().day().hour().minute()));Spacer();Image(systemName:"flag.checkered").font(.system(size:30,weight:.ultraLight)).foregroundStyle(Cyber.accent) }
                #if canImport(Lottie)
                if Bundle.main.url(forResource:"RideComplete",withExtension:"json") != nil { LottieView(animation:.named("RideComplete")).playing(loopMode:.playOnce).frame(height:72) }
                #endif
                if ride.isSimulated { StatusPill(text:"演示数据 · 不进入个人学习",color:Cyber.orange) }
                Panel { HStack { Metric(title:"DISTANCE",value:RideFormat.distance(ride.distanceM),unit:"km",accent:Cyber.accent);Metric(title:"DURATION",value:String(format:"%.0f",ride.durationS/60),unit:"min");Metric(title:"MEAN SPEED",value:ride.validSpeedSamples>0 ? String(format:"%.0f",ride.meanSpeedMPS*3.6) : "—",unit:"km/h") } }
                routePanel
                Panel(accent:Cyber.accent.opacity(0.2)) {
                    VStack(alignment:.leading,spacing:14) {
                        HStack { Image(systemName:"sparkle").foregroundStyle(Cyber.accent);Text("本地复盘").font(.system(size:18,weight:.semibold));Spacer();Eyebrow(text:"ON DEVICE") }
                        Text(ride.summaryText.isEmpty ? "这次记录尚未结束，结束后会立即生成本地复盘。" : ride.summaryText).font(.system(size:13)).foregroundStyle(Color.white.opacity(0.8)).lineSpacing(7)
                    }
                }
                cloudPanel
                if !ride.events.isEmpty {
                    HStack { Eyebrow(text:"MOMENTS TO REVIEW",color:Cyber.cyan);Spacer();Text("停车后核对").font(.system(size:10)).foregroundStyle(Cyber.muted) }
                    ForEach(ride.events) { event in
                        Button { if !ride.isSimulated && ride.isFinished && event.source == "inferred" { confirming=event;note=event.note } } label:{
                            Panel { HStack(alignment:.top,spacing:12) { Image(systemName:event.kind == "turn" ? "arrow.turn.up.right":"waveform.path").foregroundStyle(Cyber.cyan).font(.system(size:21));VStack(alignment:.leading,spacing:7) { Text(event.title).font(.system(size:15,weight:.semibold)).foregroundStyle(.white);Text("\(event.windowStart.formatted(.dateTime.hour().minute().second())) – \(event.windowEnd.formatted(.dateTime.hour().minute().second()))").font(Cyber.mono(10)).foregroundStyle(Cyber.muted);Text(event.feedback == "confirmed" ? "你已确认 · 原始估计仍保留" : event.feedback == "rejected" ? "你已排除" : event.source == "simulated" ? "演示片段" : "候选片段 · 需要你的确认").font(.system(size:11)).foregroundStyle(event.feedback == "confirmed" ? Cyber.accent:Cyber.muted) };Spacer();if event.source == "inferred" && !ride.isSimulated { Image(systemName:"chevron.right").font(.system(size:10)).foregroundStyle(Cyber.muted) } } }
                        }.buttonStyle(.plain)
                    }
                }
                Text("轨迹坐标使用 WGS84。倾角数值与真实挡位尚未启用；模型只收录明确确认或外设实测的标签。").font(.system(size:11)).foregroundStyle(Cyber.muted).lineSpacing(4)
            }.padding(24).frame(maxWidth:850)
        }.background(Cyber.ink).navigationTitle("骑行复盘").navigationBarTitleDisplayMode(.inline)
            .task {
                let id=ride.id
                samples=await Task.detached(priority:.utility) { TelemetryJournal.routeSamples(rideId:id) }.value
                if settings.autoSync && APIClient.shared.isPaired && ride.isFinished && !ride.isSimulated && ride.syncStatus != "synced" { await CloudRideSync.shared.sync(ride,vehicle:vehicles.first{$0.id==ride.vehicleId},context:context) }
            }
            .onDisappear { timer?.invalidate();timer=nil }
            .sheet(item:$confirming) { event in
                NavigationStack { Form {
                    Section { Text(event.title).font(.headline);Text("片段时间：\(event.windowStart.formatted(.dateTime.hour().minute().second())) – \(event.windowEnd.formatted(.dateTime.hour().minute().second()))").font(.footnote);Text("请按实际记忆确认。选择不知道不会产生训练标签。").font(.footnote).foregroundStyle(.secondary) }
                    Section("补充真实情况") { TextField("例如：换挡、路面接缝，或支架晃动",text:$note,axis:.vertical) }
                    Section { Button("确认这个事件") { engine.confirmEvent(event.id,label:"confirmed",note:note,ride:ride);confirming=nil };Button("不是这个事件") { engine.confirmEvent(event.id,label:"rejected",note:note,ride:ride);confirming=nil };Button("不确定，暂不标注") { confirming=nil } }
                }.navigationTitle("核对动态片段").toolbar { ToolbarItem(placement:.cancellationAction) { Button("取消") { confirming=nil } } } }
            }
    }
    private var routePanel:some View {
        VStack(alignment:.leading,spacing:14) {
            HStack { Eyebrow(text:"ROUTE REPLAY",color:Cyber.cyan);Spacer();Text("\(samples.count) 个定位点").font(Cyber.mono(10)).foregroundStyle(Cyber.muted) }
            if samples.count>1 {
                let coordinates=samples.compactMap { s -> CLLocationCoordinate2D? in guard let lat=s.latitude,let lon=s.longitude else{return nil};return .init(latitude:lat,longitude:lon) }
                let index=min(max(0,Int(replayIndex)),samples.count-1)
                Map {
                    MapPolyline(coordinates:coordinates).stroke(Cyber.accent,lineWidth:4)
                    if index<coordinates.count { Annotation("回放",coordinate:coordinates[index]) { Circle().fill(Cyber.accent).frame(width:13,height:13).overlay{Circle().stroke(.black,lineWidth:3)}.shadow(color:Cyber.accent.opacity(0.5),radius:8) } }
                }.mapStyle(.standard(elevation:.flat,pointsOfInterest:.excludingAll)).frame(height:240).clipShape(RoundedRectangle(cornerRadius:18))
                HStack(spacing:12) {
                    Button { toggleReplay() } label:{Image(systemName:isReplaying ? "pause.fill":"play.fill").frame(width:35,height:35).background(Cyber.accent.opacity(0.1),in:Circle())}
                    Slider(value:$replayIndex,in:0...Double(samples.count-1),step:1)
                    Text("\(RideFormat.speed(samples[index].speedMPS)) km/h").font(Cyber.mono(11)).frame(width:75)
                }
            } else { EmptyState(symbol:"map",title:"暂无可回放轨迹",detail:"有效定位点不足。动态记录与本地复盘仍会保留。") }
        }
    }
    private var cloudPanel:some View {
        Panel {
            VStack(alignment:.leading,spacing:14) {
                HStack { Image(systemName:"server.rack").foregroundStyle(Cyber.cyan);Text("NAS · AI 复盘").font(.system(size:17,weight:.semibold));Spacer();StatusPill(text:ride.syncStatus == "synced" ? "已同步":"本地优先",color:Cyber.cyan) }
                if !ride.aiText.isEmpty { Text(ride.aiText).font(.system(size:13)).lineSpacing(6) }
                else { Text(ride.reportStatus == "pending" ? "记录已到达 NAS，AI 复盘处理中。" : "AI 将结合这次记录与车辆档案补充复盘；本地结果立即可用。").font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(5) }
                if APIClient.shared.isPaired && ride.isFinished {
                    if CloudRideSync.shared.activeRideIDs.contains(ride.id) { ProgressView(CloudRideSync.shared.statusMessage).font(.system(size:11)) }
                    else { HStack { Button("同步 / 重试") { Task { await CloudRideSync.shared.sync(ride,vehicle:vehicles.first{$0.id==ride.vehicleId},context:context) } };Spacer();Button("刷新 AI 复盘") { Task { await CloudRideSync.shared.fetchReport(ride,context:context) } } }.font(.system(size:12)) }
                    Text(CloudRideSync.shared.statusMessage).font(.system(size:10)).foregroundStyle(Cyber.muted)
                } else { Text("在控制中心配对私人 NAS 后可同步。").font(.system(size:11)).foregroundStyle(Cyber.muted) }
            }
        }
    }
    private func toggleReplay() {
        if isReplaying { timer?.invalidate();timer=nil;isReplaying=false;return }
        if Int(replayIndex)>=samples.count-1 { replayIndex=0 }
        isReplaying=true
        timer=Timer.scheduledTimer(withTimeInterval:0.12,repeats:true) { _ in
            if Int(replayIndex)<samples.count-1 { replayIndex+=1 } else { timer?.invalidate();timer=nil;isReplaying=false }
        }
    }
}
