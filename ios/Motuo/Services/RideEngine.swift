import Foundation
import CoreLocation
import CoreMotion
import Observation
import SwiftData
import UIKit
import simd

@MainActor @Observable final class RideEngine: NSObject, @preconcurrency CLLocationManagerDelegate {
    @ObservationIgnored private var velocityBridge = InertialVelocityBridge()
    var inertialPresentation: (speed:Double,uncertainty:Double)? {
        guard isRecording,!isSimulated,speedMPS == nil else{return nil}
        return velocityBridge.estimate(at:ProcessInfo.processInfo.systemUptime)
    }
    var currentRide: Ride?
    var lastFinishedRide: Ride?
    // The cockpit web layer plays its full-screen recap first; the native detail sheet waits.
    var wrappedPending = false
    var wrappedAcknowledged = false
    var speedMPS: Double?
    var accelerationIntensity: Double = 0
    var rotationIntensity: Double = 0
    var turnDirection: Double = 0
    var longitudinalTrend: Int = 0
    var locationAccuracy: Double?
    var elapsedSeconds: Double = 0
    var errorMessage: String?
    var locationStatus = "等待定位"
    var motionStatus = "待机"
    var calibrationStatus = "尚未校准"
    var thermalLimited = false
    var recentEvents: [RideEvent] = []
    var isRecording: Bool { currentRide?.status == "recording" }
    var isPaused: Bool { currentRide?.status == "paused" || currentRide?.status == "interrupted" }
    var isSimulated: Bool { currentRide?.isSimulated ?? settings?.demoMode ?? false }
    var stateLabel: String {
        if currentRide == nil { return "准备出发" }
        if isPaused { return currentRide?.status == "interrupted" ? "记录已恢复 · 待继续" : "骑行已暂停" }
        guard let speedMPS else { return "信号待确认" }
        if speedMPS < 1.1 { return "临时停车" }
        if abs(turnDirection) > 0.25 { return turnDirection > 0 ? "右转趋势" : "左转趋势" }
        if longitudinalTrend > 0 { return "加速趋势" }
        if longitudinalTrend < 0 { return "减速趋势" }
        return "行驶中"
    }
    @ObservationIgnored private let saveChanges: (ModelContext) throws -> Void
    @ObservationIgnored private let flushJournal: (TelemetryJournal) throws -> Void
    @ObservationIgnored private let locationManager = CLLocationManager()
    @ObservationIgnored private let motionManager = CMMotionManager()
    @ObservationIgnored private let motionQueue: OperationQueue = { let q = OperationQueue(); q.name = "motuo.motion"; q.maxConcurrentOperationCount = 1; q.qualityOfService = .userInitiated; return q }()
    @ObservationIgnored private var context: ModelContext?
    @ObservationIgnored private var settings: AppSettings?
    @ObservationIgnored private var watchSummary: WatchRideContext?
    @ObservationIgnored private var journal: TelemetryJournal?
    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var lastLocation: CLLocation?
    @ObservationIgnored private var lastAcceptedLocation: CLLocation?
    @ObservationIgnored private var lastCourse: Double?
    @ObservationIgnored private var signalProcessor = RideSignalProcessor()
    @ObservationIgnored private var gpsTrend = GPSSpeedTrend()
    @ObservationIgnored private var telemetryClock = TelemetrySegmentClock()
    @ObservationIgnored private var lastMotionElapsed: Double?
    @ObservationIgnored private var tickNumber = 0
    @ObservationIgnored private var demoProgress: Double = 0
    @ObservationIgnored private var lastSavedAt = Date()
    @ObservationIgnored private var lastMotionUI: TimeInterval = 0
    @ObservationIgnored private var lastMilestoneKM = 0
    @ObservationIgnored private var calibrationId: UUID?
    @ObservationIgnored private var segmentMonotonicStart = ProcessInfo.processInfo.systemUptime

    override convenience init() { self.init(saveChanges: { try $0.save() }) }
    init(saveChanges: @escaping (ModelContext) throws -> Void, flushJournal: @escaping (TelemetryJournal) throws -> Void = { try $0.flushRecoveringAfterFailure() }) {
        self.saveChanges = saveChanges; self.flushJournal = flushJournal
        super.init(); locationManager.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(wallClockDidChange), name: UIApplication.significantTimeChangeNotification, object: nil)
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.distanceFilter = kCLDistanceFilterNone
        locationManager.activityType = .automotiveNavigation
        locationManager.pausesLocationUpdatesAutomatically = false
        locationManager.showsBackgroundLocationIndicator = true
        ticker = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }
    func configure(context: ModelContext, settings: AppSettings) {
        guard self.context == nil else { return }
        self.context = context; self.settings = settings
        if let rawId = UserDefaults.standard.string(forKey: "activeRideID"), let id = UUID(uuidString: rawId) {
            let descriptor = FetchDescriptor<Ride>(predicate: #Predicate { $0.id == id })
            if let ride = try? context.fetch(descriptor).first, !ride.isFinished {
                ride.status = "interrupted"; ride.segmentStartedAt = nil; currentRide = ride
                elapsedSeconds = ride.durationS; recentEvents = ride.events.suffix(10).reversed(); calibrationId = ride.calibrationId
                journal = try? TelemetryJournal(rideId: ride.id)
                var events = ride.events
                events.append(.init(kind: "dataGap", timestamp: Date(), windowStart: Date(), windowEnd: Date(), confidence: 1, source: "measured"))
                ride.events = events; try? context.save()
            }
        }
        watchSummary = UserDefaults.standard.data(forKey: "motuo.watch.lastSummary").flatMap { try? JSONDecoder().decode(WatchRideContext.self, from: $0) }
        WatchBridge.shared.activate()
    }
    func clearWatchSummary() {
        watchSummary = nil; lastFinishedRide = nil; wrappedPending = false; wrappedAcknowledged = false; recentEvents = []; calibrationId = nil
        speedMPS = nil; elapsedSeconds = 0; accelerationIntensity = 0; rotationIntensity = 0; turnDirection = 0; longitudinalTrend = 0
        UserDefaults.standard.removeObject(forKey: "motuo.watch.lastSummary")
        NavigationService.shared.clear(); WatchBridge.shared.clear()
    }
    func start(vehicle: Vehicle) {
        guard currentRide == nil, let context, let settings else { return }
        errorMessage = nil
        let ride = Ride(vehicle: vehicle, simulated: settings.demoMode)
        let profile = SensorCalibrationService.shared.profile(for: vehicle.id)
        calibrationId = profile?.id; ride.calibrationId = profile?.id
        ride.learningVersionId = ride.isSimulated ? nil : VehicleLearningService.shared.active(vehicleId: ride.vehicleId, calibrationId: profile?.id)?.id
        calibrationStatus = profile.map { "安装校准 v\($0.version) · 动态倾角待验证" } ?? "尚未采样安装校准"
        do {
            journal = try TelemetryJournal(rideId: ride.id)
            context.insert(ride); try saveChanges(context); currentRide = ride
            UserDefaults.standard.set(ride.id.uuidString, forKey: "activeRideID")
            elapsedSeconds = 0; recentEvents = []; demoProgress = 0; lastMilestoneKM = 0
            watchSummary = nil; UserDefaults.standard.removeObject(forKey: "motuo.watch.lastSummary")
            resetSegment(); startSensors()
            if settings.watchHaptics { WatchBridge.shared.sendHaptic(.start) }
        } catch {
            context.delete(ride); journal = nil
            errorMessage = "无法开始记录：\(error.localizedDescription)"
        }
    }
    func pause() {
        guard let ride = currentRide, isRecording else { return }
        checkpointDuration(); ride.status = "paused"; ride.segmentStartedAt = nil
        stopSensors(); speedMPS = nil; turnDirection = 0; longitudinalTrend = 0; gpsTrend.reset()
        do { try journal?.flush(); try context?.save() } catch { errorMessage = error.localizedDescription }
        if settings?.watchHaptics == true { WatchBridge.shared.sendHaptic(.pause) }
        sendWatchContext()
    }
    func resume() {
        guard let ride = currentRide, isPaused else { return }
        do {
            let activeJournal = try journal ?? TelemetryJournal(rideId: ride.id)
            journal = activeJournal
            if activeJournal.errorMessage != nil { recordStorageGap(ride) }
            try flushJournal(activeJournal)
            ride.status = "recording"; ride.segmentStartedAt = Date()
            try persistChanges()
            resetSegment(); startSensors(); errorMessage = nil
        } catch {
            ride.status = "interrupted"; ride.segmentStartedAt = nil; stopSensors(); speedMPS = nil
            errorMessage = "继续记录未保存，请释放存储空间后重试：\(error.localizedDescription)"
        }
    }
    func finish() {
        guard let ride = currentRide else {
            if tickNumber % 30 == 0 { sendWatchContext() }
            return
        }
        errorMessage = nil
        if isRecording { checkpointDuration() }
        stopSensors(); ride.segmentStartedAt = nil
        do {
            if journal?.errorMessage != nil { recordStorageGap(ride) }
            guard let journal else { throw APIClientError(message: "遥测文件尚未恢复，请重试") }
            try flushJournal(journal)
        } catch {
            ride.status = "interrupted"; ride.segmentStartedAt = nil; recordStorageGap(ride)
            speedMPS = nil; accelerationIntensity = 0; rotationIntensity = 0; turnDirection = 0; longitudinalTrend = 0; gpsTrend.reset()
            errorMessage = "遥测尚未保存，请释放存储空间后重试结束；已提交记录保留：\(error.localizedDescription)"
            try? persistChanges(); sendWatchContext()
            return
        }
        let priorVersion = ride.dataVersion, priorSummary = ride.summaryText, priorSync = ride.syncStatus
        let priorEndedAt = ride.endedAt
        ride.status = "finished"; ride.endedAt = Date(); ride.dataVersion += 1
        ride.summaryText = Self.localSummary(for: ride); ride.syncStatus = "local"
        do { try persistChanges() }
        catch {
            // Never release the recovery pointer or announce completion until metadata is durable.
            ride.status = "interrupted"; ride.endedAt = priorEndedAt; ride.dataVersion = priorVersion
            ride.summaryText = priorSummary; ride.syncStatus = priorSync; ride.segmentStartedAt = nil
            speedMPS = nil; accelerationIntensity = 0; rotationIntensity = 0; turnDirection = 0; longitudinalTrend = 0; gpsTrend.reset()
            errorMessage = "结束记录未保存，请释放存储空间后重试结束；记录仍保留在本机：\(error.localizedDescription)"
            try? persistChanges(); sendWatchContext()
            return
        }
        if settings?.watchHaptics == true { WatchBridge.shared.sendHaptic(.finish) }
        watchSummary = WatchRideContext(isRiding: false, isSimulated: ride.isSimulated, speedKPH: nil, distanceKM: ride.distanceM / 1000, elapsedSeconds: ride.durationS, status: "骑行完成", updatedAt: Date(), isSummary: true)
        if let data = try? JSONEncoder().encode(watchSummary) { UserDefaults.standard.set(data, forKey: "motuo.watch.lastSummary") }
        lastFinishedRide = ride; currentRide = nil; journal = nil; speedMPS = nil
        accelerationIntensity = 0; rotationIntensity = 0; turnDirection = 0; longitudinalTrend = 0; gpsTrend.reset(); elapsedSeconds = 0
        UserDefaults.standard.removeObject(forKey: "activeRideID"); sendWatchContext()
    }
    func confirmEvent(_ id: UUID, label: String, note: String, ride: Ride) {
        guard ["confirmed", "rejected"].contains(label), !ride.isSimulated else { return }
        var events = ride.events
        guard let index = events.firstIndex(where: { $0.id == id }), events[index].source == "inferred" else { return }
        events[index].feedback = label; events[index].note = note
        ride.events = events; ride.dataVersion += 1; ride.syncStatus = "local"
        ride.summaryText = Self.localSummary(for: ride); ride.aiText = ""; ride.reportStatus = "local"
        do { try context?.save(); try VehicleLearningService.shared.invalidate(rideId: ride.id) } catch { errorMessage = error.localizedDescription }
    }
    private func recordStorageGap(_ ride: Ride) {
        let note = "记录链路发生写入中断；恢复保留已提交数据块和完整尾行，未写完的尾行可能缺测。请核对记录完整性。"
        if !ride.notes.contains(note) {
            ride.notes += (ride.notes.isEmpty ? "" : "\n") + note
            var events = ride.events
            let now = Date()
            events.append(.init(kind: "dataGap", timestamp: now, windowStart: now, windowEnd: now, confidence: 1, source: "measured"))
            ride.events = events
        }
    }
    private func persistChanges() throws {
        guard let context else { throw APIClientError(message: "记录存储尚未就绪") }
        try saveChanges(context)
    }
    private func resetSegment() {
        lastLocation = nil; lastAcceptedLocation = nil; lastCourse = nil; signalProcessor.reset(); gpsTrend.reset(); longitudinalTrend = 0
        let uptime = ProcessInfo.processInfo.systemUptime
        telemetryClock = TelemetrySegmentClock(wall: Date(), uptime: uptime)
        segmentMonotonicStart = uptime; lastMotionElapsed = nil; lastMotionUI = 0
        lastSavedAt = Date(); speedMPS = nil
        if let ride = currentRide { signalProcessor.setThreshold(ride.isSimulated ? nil : VehicleLearningService.shared.versions.first { $0.id == ride.learningVersionId && $0.vehicleId == ride.vehicleId && $0.calibrationId == ride.calibrationId && !$0.invalidated }?.jerkThreshold) }
    }
    @objc private func wallClockDidChange() {
        guard isRecording else { return }
        checkpointDuration(); stopSensors(); resetSegment(); startSensors()
    }
    private func startSensors() {
        guard let ride = currentRide else { return }
        UIApplication.shared.isIdleTimerDisabled = settings?.keepScreenOn == true
        if ride.isSimulated { locationStatus = "演示路线"; motionStatus = "模拟数据"; return }
        locationManager.requestWhenInUseAuthorization()
        locationManager.allowsBackgroundLocationUpdates = true; locationManager.startUpdatingLocation()
        if motionManager.isDeviceMotionAvailable {
            let motionSegmentID = telemetryClock.id
            motionManager.deviceMotionUpdateInterval = 1 / 50
            motionManager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: motionQueue) { [weak self] data, error in
                guard let data else { return }
                let sample = MotionValues(segmentId: motionSegmentID, timestamp: data.timestamp, ax: data.userAcceleration.x * 9.80665,
                    ay: data.userAcceleration.y * 9.80665, az: data.userAcceleration.z * 9.80665,
                    rx: data.rotationRate.x, ry: data.rotationRate.y, rz: data.rotationRate.z)
                Task { @MainActor in self?.receiveMotion(sample) }
            }
            motionStatus = "动态采集中"
        } else { motionStatus = "设备无动态传感器" }
    }
    private func stopSensors() {
        velocityBridge.reset()
        locationManager.stopUpdatingLocation(); locationManager.allowsBackgroundLocationUpdates = false
        motionManager.stopDeviceMotionUpdates(); UIApplication.shared.isIdleTimerDisabled = false
        motionStatus = "已暂停"
    }
    private func receiveMotion(_ value: MotionValues) {
        guard isRecording, !isSimulated, value.segmentId == telemetryClock.id,
              let point = telemetryClock.motion(uptime: value.timestamp),
              lastMotionElapsed == nil || point.elapsed > lastMotionElapsed! else { return }
        lastMotionElapsed = point.elapsed
        let timestamp = point.timestamp
        if let id=currentRide?.vehicleId,let profile=SensorCalibrationService.shared.profile(for:id),profile.id==calibrationId {
            let corrected=SIMD3(value.ax,value.ay,value.az)-profile.accelerationBias.vector
            velocityBridge.motion(acceleration:profile.projected(corrected).y,time:value.timestamp)
        } else { velocityBridge.motion(acceleration:nil,time:value.timestamp) }
        let acceleration = sqrt(value.ax * value.ax + value.ay * value.ay + value.az * value.az)
        let rotation = sqrt(value.rx * value.rx + value.ry * value.ry + value.rz * value.rz)
        if value.timestamp - lastMotionUI >= 1 / 10 {
            accelerationIntensity = min(1, acceleration / 5); rotationIntensity = min(1, rotation / 1.5); lastMotionUI = value.timestamp
        }
        journal?.append(.init(timestamp: timestamp, monotonicS: point.elapsed, source: "measured",
            stream: "motion", segmentId: telemetryClock.id.uuidString,
            accelerationX: value.ax, accelerationY: value.ay, accelerationZ: value.az,
            rotationX: value.rx, rotationY: value.ry, rotationZ: value.rz,
            quality: "valid", calibrationId: calibrationId?.uuidString))
        if let event = signalProcessor.process(acceleration: acceleration, rotation: rotation,
                                               speed: speedMPS, timestamp: timestamp, monotonic: point.elapsed, simulated: false) {
            addEvent(event)
        }
    }
    private func addEvent(_ event: RideEvent) {
        guard let ride = currentRide else { return }
        var events = ride.events; events.append(event); ride.events = events
        recentEvents = Array(events.suffix(10).reversed())
    }
    private func tick() {
        tickNumber += 1
        if tickNumber % 30 == 0 { thermalLimited = ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical }
        guard let ride = currentRide else { return }
        if isRecording {
            elapsedSeconds = ride.durationS + max(0,ProcessInfo.processInfo.systemUptime-segmentMonotonicStart)
            if isSimulated { demoTick() }
            else if lastLocation == nil || Date().timeIntervalSince(lastLocation!.timestamp) > 4 {
                speedMPS = nil; locationStatus = "定位信号待恢复"; turnDirection = 0; longitudinalTrend = 0; gpsTrend.reset()
            }
        }
        if tickNumber % 30 == 0 {
            if let error = journal?.errorMessage, isRecording {
                errorMessage = error; pause(); ride.status = "interrupted"
            }
            if isRecording { checkpointDuration() }
            try? context?.save(); sendWatchContext()
        }
    }
    private func checkpointDuration() {
        guard let ride = currentRide, ride.segmentStartedAt != nil else { return }
        let now = ProcessInfo.processInfo.systemUptime
        ride.durationS += max(0,now-segmentMonotonicStart);segmentMonotonicStart=now;ride.segmentStartedAt=Date()
        elapsedSeconds = ride.durationS
    }
    private func demoTick() {
        guard let ride = currentRide else { return }
        demoProgress += 1 / 30
        let t = demoProgress
        let kph = max(0, 34 + 12 * sin(t / 7) + 6 * sin(t / 2.9))
        speedMPS = kph / 3.6; turnDirection = sin(t / 5) * 0.7
        accelerationIntensity = 0.14 + abs(sin(t / 2.9)) * 0.35
        rotationIntensity = abs(turnDirection) * 0.6
        ride.distanceM += kph / 3.6 / 30; ride.maxSpeedMPS = max(ride.maxSpeedMPS, kph / 3.6)
        if tickNumber % 30 == 0 {
            ride.validSpeedSamples += 1
            longitudinalTrend = gpsTrend.update(speed: speedMPS, accuracy: 0.1, timestamp: Date(), now: Date())
            let a = t / 200
            guard let point = telemetryClock.motion(uptime: ProcessInfo.processInfo.systemUptime) else { return }
            journal?.append(.init(timestamp: point.timestamp, monotonicS: point.elapsed,
                source: "simulated", stream: "simulation", segmentId: telemetryClock.id.uuidString, speedMPS: kph / 3.6, latitude: 31.2304 + sin(a) * 0.016,
                longitude: 121.4737 + (1 - cos(a)) * 0.021, horizontalAccuracyM: 5, speedAccuracyMPS: 0.5,
                accelerationX: accelerationIntensity * 5, rotationZ: turnDirection * 0.3, quality: "valid"))
        }
        if Int(t) > 0, Int(t) % 22 == 0, tickNumber % 30 == 0 {
            addEvent(.init(kind: "turn", timestamp: Date(), windowStart: Date().addingTimeInterval(-2), windowEnd: Date().addingTimeInterval(2), confidence: 0.45, source: "simulated"))
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .denied, .restricted: locationStatus = "定位未授权"; speedMPS = nil
        case .authorizedWhenInUse, .authorizedAlways: locationStatus = "搜索卫星定位"
        default: locationStatus = "等待定位授权"
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard isRecording, !isSimulated, let ride = currentRide else { return }
        for location in locations.sorted(by: { $0.timestamp < $1.timestamp }) {
            let now = Date()
            guard location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 100,
                  abs(now.timeIntervalSince(location.timestamp)) <= 10,
                  let sampleElapsed = telemetryClock.location(timestamp: location.timestamp),
                  lastLocation == nil || location.timestamp > lastLocation!.timestamp else { continue }
            lastLocation = location; locationAccuracy = location.horizontalAccuracy
            speedMPS = SpeedQuality.accepted(speed: location.speed, accuracy: location.speedAccuracy, timestamp: location.timestamp, now: now)
            if let speedMPS,location.horizontalAccuracy<=25,abs(now.timeIntervalSince(location.timestamp))<=1.5 {
                velocityBridge.gps(speed:speedMPS,accuracy:location.speedAccuracy,time:ProcessInfo.processInfo.systemUptime)
            }
            longitudinalTrend = gpsTrend.update(speed: location.horizontalAccuracy <= 25 ? speedMPS : nil, accuracy: location.speedAccuracy, timestamp: location.timestamp, now: now)
            locationStatus = location.horizontalAccuracy <= 25 ? "定位稳定" : "定位精度较低"
            if let speed = speedMPS {
                ride.validSpeedSamples += 1
                ride.maxSpeedMPS = max(ride.maxSpeedMPS, speed)
                if speed >= 1.5, location.horizontalAccuracy <= 30, let previous = lastAcceptedLocation {
                    let dt = location.timestamp.timeIntervalSince(previous.timestamp), distance = location.distance(from: previous)
                    if dt > 0, dt <= 10, distance <= max(30, dt * 70), previous.horizontalAccuracy <= 30 { ride.distanceM += distance }
                }
                if speed > 3, location.course >= 0, location.courseAccuracy >= 0, location.courseAccuracy < 30 {
                    if let previous = lastCourse {
                        let delta = (location.course - previous + 540).truncatingRemainder(dividingBy: 360) - 180
                        turnDirection = abs(delta) < 0.8 ? 0 : max(-1, min(1, delta / 12))
                    }
                    lastCourse = location.course
                } else { turnDirection = 0 }
            }
            lastAcceptedLocation = location
            journal?.append(.init(timestamp: location.timestamp,
                monotonicS: sampleElapsed, source: "measured",
                stream: "location", segmentId: telemetryClock.id.uuidString,
                speedMPS: speedMPS, latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                horizontalAccuracyM: location.horizontalAccuracy,
                speedAccuracyMPS: location.speedAccuracy >= 0 ? location.speedAccuracy : nil,
                quality: speedMPS == nil || location.horizontalAccuracy > 30 ? "degraded" : "valid",
                calibrationId: calibrationId?.uuidString))
            let km = Int(ride.distanceM / 10000)
            if km > lastMilestoneKM { lastMilestoneKM = km; if settings?.watchHaptics == true { WatchBridge.shared.sendHaptic(.milestone) } }
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { locationStatus = "定位暂不可用"; speedMPS = nil; longitudinalTrend = 0; gpsTrend.reset() }
    private func sendWatchContext() {
        let navigation = NavigationService.shared
        var watchContext = WatchRideContext(isRiding: isRecording, isSimulated: isSimulated, speedKPH: speedMPS.map { $0 * 3.6 },
            distanceKM: (currentRide?.distanceM ?? 0) / 1000, elapsedSeconds: elapsedSeconds,
            status: stateLabel, updatedAt: Date(), isSummary: false)
        if currentRide == nil, let summary = watchSummary { watchContext = summary }
        if let name = navigation.destinationName {
            watchContext.navTitle = String(name.prefix(70))
            watchContext.navInstruction = navigation.embeddedAvailable ? navigation.instruction?.maneuver : "请在高德查看摩托路线"
        }
        WatchBridge.shared.update(watchContext)
        var hud:[String:Any]=["type":"state","v":1,"mode":"rideInfo","source":isSimulated ? "simulated":"measured",
                             "timestamp":Date().ISO8601Format(),"status":stateLabel,
                             "units":["speed":"kmh"],"distanceKm":(currentRide?.distanceM ?? 0)/1000]
        if let speedMPS { hud["speed"]=["current":speedMPS*3.6] }
        if let data=try? JSONSerialization.data(withJSONObject:hud) { AccessoryService.shared.sendHUD(data) }
    }
    static func localSummary(for ride: Ride) -> String {
        let prefix = ride.isSimulated ? "这是一段演示骑行，所有动态与路线均为模拟数据。\n\n" : ""
        let confirmed = ride.events.filter { $0.feedback == "confirmed" }.count
        let candidates = ride.events.filter { $0.source == "inferred" && $0.feedback == nil }.count
        let speedText = ride.validSpeedSamples > 0 ? "记录期均速 \(Int(ride.meanSpeedMPS * 3.6)) km/h。" : "本次没有有效速度样本，速度统计未知。"
        return prefix + "本次记录 \(RideFormat.distance(ride.distanceM)) 公里，活动时长 \(RideFormat.elapsed(ride.durationS))。" + speedText + "\n\n捕捉到 \(candidates) 个待核对动态片段，\(confirmed) 个片段已由你确认。手机动态只能反映运动变化，不能据此确定挡位、机械故障或驾驶安全。\n\n" + (ride.notes.isEmpty ? "停车后可以核对片段，并结合保养记录与手册检查车辆。" : ride.notes)
    }
}

private struct MotionValues: Sendable {
    var segmentId: UUID
    var timestamp: Double; var ax: Double; var ay: Double; var az: Double
    var rx: Double; var ry: Double; var rz: Double
}
