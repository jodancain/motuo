import SwiftUI
import SwiftData

struct DashboardView: View {
    var landscape: Bool
    @Environment(RideEngine.self) private var engine
    @Environment(AppSettings.self) private var settings
    @Query(sort: \Vehicle.createdAt) private var vehicles: [Vehicle]
    @State private var showNavigation = false
    @State private var showMusic = false
    @State private var showFinish = false
    var vehicle: Vehicle? {
        if let id=engine.currentRide?.vehicleId { return vehicles.first{$0.id==id} }
        return vehicles.first { $0.id.uuidString == settings.selectedVehicleID } ?? vehicles.first
    }
    var body: some View {
        Group {
            if landscape {
                VStack(spacing: 12) {
                    header
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 20) {
                            vehicleLabel
                            Metric(title: "DISTANCE",value:RideFormat.distance(engine.currentRide?.distanceM ?? 0),unit:"km",accent:Cyber.accent)
                            VStack(alignment:.leading,spacing:6) { Eyebrow(text:"RIDE TIME"); Text(RideFormat.elapsed(engine.elapsedSeconds)).font(Cyber.mono(18)).monospacedDigit() }
                        }.frame(width: 130)
                        SpeedDisplay(compact: true).frame(maxWidth: .infinity)
                        VStack(spacing:10) { navigationCard; musicCard }.frame(width: 206)
                    }.frame(maxHeight:.infinity)
                    HStack(spacing: 14) { sensorStrip; rideControls.frame(width: 320) }
                }.padding(18)
            } else {
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(spacing:20) {
                        header
                        HStack { vehicleLabel; Spacer(); StatusPill(text: engine.stateLabel, color:engine.isRecording ? Cyber.accent : Cyber.muted) }
                        SpeedDisplay(compact: false).frame(height:300)
                        Panel {
                            HStack(spacing:16) {
                                Metric(title:"TRIP",value:RideFormat.distance(engine.currentRide?.distanceM ?? 0),unit:"km",accent:Cyber.accent)
                                Rectangle().fill(Cyber.stroke).frame(width:1,height:40)
                                VStack(alignment:.leading,spacing:8) { Eyebrow(text:"RIDE TIME"); Text(RideFormat.elapsed(engine.elapsedSeconds)).font(Cyber.mono(25,weight:.semibold)).monospacedDigit() }.frame(maxWidth:.infinity,alignment:.leading)
                            }
                        }
                        HStack(spacing:12) { navigationCard; musicCard }
                        sensorStrip
                        }.padding(22)
                    }.scrollIndicators(.hidden)
                    // Keep critical controls outside the scroll content's hit-test region.
                    rideControls.padding(.horizontal,22).padding(.vertical,10).background(Cyber.ink)
                }
            }
        }
        .sheet(isPresented:$showNavigation) { NavigationSearchView() }
        .sheet(isPresented:$showMusic) { MusicLibraryView() }
        .confirmationDialog("结束这次骑行？",isPresented:$showFinish,titleVisibility:.visible) {
            Button("结束并生成复盘") { engine.finish() }
            Button("继续骑行",role:.cancel) { }
        } message: { Text("原始记录会先安全保存在手机，随后可同步到你的 NAS。") }
    }
    private var header: some View {
        HStack(alignment:.center) {
            HStack(spacing:8) {
                Image(systemName:"bolt.horizontal.fill").foregroundStyle(Cyber.accent).font(.system(size:21))
                Text("MOTUO").font(.system(size:23,weight:.black,design:.rounded)).italic().tracking(1)
                if landscape { Eyebrow(text:"RIDE OS / 01") }
            }
            Spacer()
            StatusPill(text:engine.isSimulated ? "DEMO · 模拟数据" : engine.isRecording ? "REC · 实际记录" : "READY",color:engine.isSimulated ? Cyber.orange : Cyber.accent)
        }
    }
    private var vehicleLabel: some View {
        VStack(alignment:.leading,spacing:5) {
            Eyebrow(text:vehicle?.make.uppercased() ?? "MY MACHINE")
            Text(vehicle?.model ?? "添加摩托").font(.system(size:21,weight:.bold,design:.rounded)).italic()
            if landscape { Text(engine.stateLabel).font(.system(size:10)).foregroundStyle(Cyber.muted) }
        }
    }
    private var navigationCard: some View {
        Button { if canOpenUtility { showNavigation = true } } label: {
            Panel {
                VStack(alignment:.leading,spacing:10) {
                    HStack { Image(systemName:"arrow.up.right").font(.system(size:22,weight:.bold)).foregroundStyle(Cyber.cyan); Spacer(); Image(systemName:"arrow.up.forward").font(.system(size:10)).foregroundStyle(Cyber.muted) }
                    Text("下一站，去哪").font(.system(size:14,weight:.semibold)).foregroundStyle(.white)
                    Text("高德导航 · 外部接续").font(.system(size:10)).foregroundStyle(Cyber.muted)
                }.frame(maxWidth:.infinity,alignment:.leading)
            }
        }.buttonStyle(.plain)
    }
    private var musicCard: some View {
        Button { if canOpenUtility { showMusic = true } } label: {
            Panel {
                VStack(alignment:.leading,spacing:10) {
                    HStack {
                        WaveBars(active:MusicService.shared.isPlaying).frame(width:30,height:22)
                        Spacer(); Image(systemName:MusicService.shared.isPlaying ? "pause.fill" : "play.fill").font(.system(size:12)).foregroundStyle(Cyber.accent)
                    }
                    Text(MusicService.shared.currentTitle.isEmpty ? "给旅程配乐" : MusicService.shared.currentTitle).font(.system(size:14,weight:.semibold)).foregroundStyle(.white).lineLimit(1)
                    Text(MusicService.shared.currentArtist.isEmpty ? "APPLE MUSIC" : MusicService.shared.currentArtist).font(.system(size:10)).foregroundStyle(Cyber.muted).lineLimit(1)
                }.frame(maxWidth:.infinity,alignment:.leading)
            }
        }.buttonStyle(.plain)
    }
    private var canOpenUtility: Bool { !engine.isRecording || engine.isSimulated || (engine.speedMPS ?? 99) < 1 }
    private var rideControls: some View {
        HStack(spacing:10) {
            if engine.currentRide == nil {
                ActionButton(title:settings.demoMode ? "进入演示骑行" : "开始骑行",symbol:"power") { if let vehicle { engine.start(vehicle:vehicle) } }
            } else {
                ActionButton(title:engine.isPaused ? "继续骑行" : "暂停",symbol:engine.isPaused ? "play.fill" : "pause.fill") { if engine.isPaused { engine.resume() } else { engine.pause() } }
                ActionButton(title:"结束",symbol:"stop.fill",primary:false) { showFinish = true }.frame(maxWidth:120)
            }
        }
    }
    private var sensorStrip: some View {
        HStack(spacing:12) {
            Label(engine.locationStatus,systemImage:"location.fill").foregroundStyle(engine.speedMPS == nil ? Cyber.muted : Cyber.cyan)
            if !landscape { Spacer() }
            Label(engine.isSimulated ? "DEMO" : "IMU",systemImage:"gyroscope").foregroundStyle(Cyber.muted)
            Label(WatchBridge.shared.isReachable ? "在线" : "待连接",systemImage:"applewatch").foregroundStyle(WatchBridge.shared.isReachable ? Cyber.accent : Cyber.muted)
        }.font(.system(size:9,weight:.medium)).lineLimit(1).minimumScaleFactor(0.75).frame(maxWidth:.infinity)
    }
}

struct SpeedDisplay: View {
    var compact: Bool
    @Environment(RideEngine.self) private var engine
    @Environment(AppSettings.self) private var settings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                TimelineView(.animation(minimumInterval:engine.thermalLimited || settings.reducedEffects ? 1/30 : 1/60,paused:reduceMotion || settings.reducedEffects)) { timeline in
                    let time = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy:60)
                    ZStack {
                    RoundedRectangle(cornerRadius:24).fill(RadialGradient(colors:[Cyber.accent.opacity(0.035+engine.accelerationIntensity*0.06),Cyber.ink],center:.center,startRadius:0,endRadius:geometry.size.width*0.65))
                    RoadGrid(progress:reduceMotion || settings.reducedEffects ? 0 : time, intensity:engine.isRecording ? (engine.speedMPS ?? 0) / 20 : 0, turn:engine.turnDirection)
                        .opacity(0.7)
                    MotionEnergyRing(progress: reduceMotion || settings.reducedEffects ? 0 : time,
                        intensity: min(1, max(engine.accelerationIntensity, engine.rotationIntensity)),
                        turn: engine.turnDirection, isActive: engine.isRecording,
                        reduced: reduceMotion || settings.reducedEffects)
                    }
                }
                VStack(spacing:compact ? 5 : 9) {
                    HStack(spacing:7) { Rectangle().fill(Cyber.accent).frame(width:18,height:2); Eyebrow(text:engine.isSimulated ? "SIMULATED SPEED" : "GPS SPEED",color:Cyber.accent); Rectangle().fill(Cyber.accent).frame(width:18,height:2) }
                    Text(RideFormat.speed(engine.speedMPS))
                        .font(.system(size:compact ? 112 : 132,weight:.thin,design:.rounded)).monospacedDigit().tracking(-7)
                        .foregroundStyle(.white).contentTransition(.numericText()).minimumScaleFactor(0.5).lineLimit(1)
                        .shadow(color:Cyber.accent.opacity(0.15),radius:18)
                    Text("KM/H").font(Cyber.mono(11)).tracking(4).foregroundStyle(Cyber.muted)
                    HStack(spacing:20) {
                        VStack(spacing:5) { Text("挡位").font(.system(size:9)).foregroundStyle(Cyber.muted); Text("—").font(Cyber.mono(23)); Text("未接车辆信号").font(.system(size:8)).foregroundStyle(Cyber.muted) }
                        Rectangle().fill(Cyber.stroke).frame(width:1,height:34)
                        VStack(spacing:5) { Text("动态感知").font(.system(size:9)).foregroundStyle(Cyber.muted); MotionMeter(value:engine.rotationIntensity).frame(width:70,height:18); Text("动感强度 · 非转速").font(.system(size:8)).foregroundStyle(Cyber.muted) }
                    }.padding(.top,compact ? 0 : 12)
                }.padding(.vertical,10)
                VStack { HStack { corner; Spacer(); corner.rotationEffect(.degrees(90)) }; Spacer(); HStack { corner.rotationEffect(.degrees(-90)); Spacer(); corner.rotationEffect(.degrees(180)) } }.padding(4).opacity(0.7)
            }
        }.accessibilityElement(children:.combine)
    }
    private var corner: some View { UnevenRoundedRectangle(topLeadingRadius:3).trim(from:0.5,to:0.75).stroke(Cyber.accent.opacity(0.5),lineWidth:1).frame(width:18,height:18) }
}
struct RoadGrid: View {
    var progress: Double; var intensity: Double; var turn: Double
    var body: some View {
        Canvas { context,size in
            let horizon = CGPoint(x:size.width*(0.5+turn*0.06),y:size.height*0.35)
            for index in -5...5 {
                var line = Path(); line.move(to:horizon); line.addLine(to:CGPoint(x:size.width/2+Double(index)*size.width*0.25,y:size.height))
                context.stroke(line,with:.color(Cyber.cyan.opacity(0.09)),lineWidth:0.7)
            }
            for index in 0..<10 {
                let phase = (Double(index)/10 + progress*min(0.1,intensity*0.018)).truncatingRemainder(dividingBy:1)
                let y = horizon.y + pow(phase,2)*(size.height-horizon.y)
                var line = Path(); line.move(to:CGPoint(x:0,y:y)); line.addLine(to:CGPoint(x:size.width,y:y))
                context.stroke(line,with:.color(Cyber.cyan.opacity(0.08)),lineWidth:0.7)
            }
        }.mask(LinearGradient(colors:[.clear,.white.opacity(0.5),.white],startPoint:.top,endPoint:.bottom))
    }
}
struct MotionMeter: View {
    var value: Double
    var body: some View { HStack(alignment:.center,spacing:3) { ForEach(0..<11) { index in RoundedRectangle(cornerRadius:1).fill(Double(abs(index-5))/5 <= value ? Cyber.cyan : Cyber.cyan.opacity(0.14)).frame(width:3,height:CGFloat(6+abs(index-5)*2)) } } }
}
struct WaveBars: View {
    var active: Bool
    var body: some View {
        TimelineView(.animation(minimumInterval:1/12,paused:!active)) { time in
            HStack(alignment:.center,spacing:3) { ForEach(0..<5) { i in
                Capsule().fill(Cyber.accent).frame(width:3,height:active ? 6+14*abs(sin(time.date.timeIntervalSinceReferenceDate*3+Double(i))) : CGFloat([8,16,22,13,7][i]))
            } }
        }
    }
}

/// An unscaled visual response to phone motion, never an RPM/gear/lean gauge.
struct MotionEnergyRing: View {
    var progress: Double
    var intensity: Double
    var turn: Double
    var isActive: Bool
    var reduced: Bool
    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height * 0.43)
            let radius = min(size.width * 0.44, size.height * 0.39)
            let energy = isActive ? max(0, min(1, intensity)) : 0
            let sweep = 270.0
            func arc(_ start: Double, _ end: Double, radius r: Double) -> Path {
                var path = Path()
                path.addArc(center: center, radius: r, startAngle: .degrees(start), endAngle: .degrees(end), clockwise: false)
                return path
            }
            context.stroke(arc(135, 405, radius: radius), with: .color(Cyber.accent.opacity(0.13)), lineWidth: 1)
            context.stroke(arc(137, 403, radius: radius - 9), with: .color(Cyber.accent.opacity(0.06)), lineWidth: 5)
            for tick in 0..<60 {
                let angle = 135 + Double(tick) / 59 * sweep
                let opacity = 0.12 + (Double(tick) / 60 < energy ? 0.32 : 0)
                context.stroke(arc(angle, angle + 1.35, radius: radius + 5), with: .color(Cyber.accent.opacity(opacity)), lineWidth: tick.isMultiple(of: 5) ? 5 : 2)
            }
            guard isActive else { return }
            let phase = reduced ? 0 : sin(progress * 1.2) * 6
            let length = 15 + energy * 44
            for start in [164.0 + phase, 344.0 - phase] {
                let glow = arc(start, start + length, radius: radius - 1)
                context.stroke(glow, with: .color(Cyber.violet.opacity(0.13 + energy * 0.15)), style: StrokeStyle(lineWidth: 11, lineCap: .round))
                context.stroke(glow, with: .color(Cyber.accent.opacity(0.65)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
            let side = turn >= 0 ? 335.0 : 185.0
            context.stroke(arc(side - 14, side + 14, radius: radius + 10), with: .color(Cyber.violet.opacity(0.15 + abs(turn) * 0.7)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
        }.accessibilityHidden(true)
    }
}
