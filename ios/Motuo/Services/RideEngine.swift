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
    /// The web cockpit plays its departure countdown before recording starts; the tab bar hides meanwhile.
    var cockpitCountdown = false
    var speedMPS: Double?
    /// Identity of the current speed reading: monotonic uptime and ride-elapsed seconds when it was taken (GPS fix or 1 Hz demo step).
    var speedSampleTime: Double?
    var speedSampleElapsed: Double?
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
    var thermalState = "nominal"
    var lowPowerMode = false
    var recentEvents: [RideEvent] = []
    /// 10 Hz vehicle-state estimate while recording (inferred; simulated for DEMO rides). Never measured truth.
    var vehicleState: VehicleStateSnapshot?
    var isRecording: Bool { currentRide?.status == "recording" }
    var isPaused: Bool { currentRide?.status == "paused" || currentRide?.status == "interrupted" }
    var isSimulated: Bool { currentRide?.isSimulated ?? settings?.demoMode ?? false }
    var stateLabel: String {
        if currentRide == nil { return "准备出发" }
        if isPaused { return currentRide?.status == "interrupted" ? "记录已恢复 · 待继续" : "骑行已暂停" }
        if let v = vehicleState, let label = Self.vehicleLabel(v, speed: speedMPS) { return label }
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
    @ObservationIgnored private var vehicleEstimator = VehicleStateEstimator()
    @ObservationIgnored private var demoReplay: VehicleReplayCursor?
    @ObservationIgnored private var lastSoundUptime = 0.0
    @ObservationIgnored private var gpsTrend = GPSSpeedTrend()
    @ObservationIgnored private var telemetryClock = TelemetrySegmentClock()
    @ObservationIgnored private var lastMotionElapsed: Double?
    @ObservationIgnored private var tickNumber = 0
    @ObservationIgnored private var demoProgress: Double = 0
    @ObservationIgnored private var demoSecond = -1
    @ObservationIgnored private var demoWallStart: Date?
    @ObservationIgnored private var lastSavedAt = Date()
    @ObservationIgnored private var lastMotionUI: TimeInterval = 0
    @ObservationIgnored private var lastMilestoneKM = 0
    @ObservationIgnored private var calibrationId: UUID?
    @ObservationIgnored private var segmentMonotonicStart = ProcessInfo.processInfo.systemUptime
    /// Full-sensor roadlog for real rides (DEMO rides never start one). Independent of TelemetryJournal.
    @ObservationIgnored let roadlog: RoadlogRecorder

    override convenience init() { self.init(saveChanges: { try $0.save() }) }
    init(saveChanges: @escaping (ModelContext) throws -> Void, flushJournal: @escaping (TelemetryJournal) throws -> Void = { try $0.flushRecoveringAfterFailure() }, roadlog: RoadlogRecorder? = nil) {
        self.saveChanges = saveChanges; self.flushJournal = flushJournal; self.roadlog = roadlog ?? .shared
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
        speedMPS = nil; elapsedSeconds = 0; accelerationIntensity = 0; rotationIntensity = 0; turnDirection = 0; longitudinalTrend = 0; vehicleState = nil
        UserDefaults.standard.removeObject(forKey: "motuo.watch.lastSummary")
        NavigationService.shared.clear(); WatchBridge.shared.clear()
    }
    /// `simulated` overrides the demo setting for one ride (the cockpit's “演示骑行” sticker) without changing it.
    func start(vehicle: Vehicle, simulated: Bool? = nil) {
        guard currentRide == nil, let context, let settings else { return }
        errorMessage = nil; cockpitCountdown = false
        let ride = Ride(vehicle: vehicle, simulated: simulated ?? settings.demoMode)
        let profile = SensorCalibrationService.shared.profile(for: vehicle.id)
        calibrationId = profile?.id; ride.calibrationId = profile?.id
        ride.learningVersionId = ride.isSimulated ? nil : VehicleLearningService.shared.active(vehicleId: ride.vehicleId, calibrationId: profile?.id)?.id
        calibrationStatus = profile.map { "安装校准 v\($0.version) · 动态倾角待验证" } ?? "尚未采样安装校准"
        do {
            journal = try TelemetryJournal(rideId: ride.id)
            context.insert(ride); try saveChanges(context); currentRide = ride
            UserDefaults.standard.set(ride.id.uuidString, forKey: "activeRideID")
            elapsedSeconds = 0; recentEvents = []; demoProgress = 0; demoSecond = -1; lastMilestoneKM = 0; demoWallStart = Date()
            watchSummary = nil; UserDefaults.standard.removeObject(forKey: "motuo.watch.lastSummary")
            resetVehicleEstimator(ride, profile: profile)
            resetSegment(); beginRoadlog(ride, vehicle: vehicle); startSensors()
            if settings.watchHaptics { WatchBridge.shared.sendHaptic(.start) }
        } catch {
            context.delete(ride); journal = nil
            errorMessage = "无法开始记录：\(error.localizedDescription)"
        }
    }
    func pause() {
        guard let ride = currentRide, isRecording else { return }
        checkpointDuration(); ride.status = "paused"; ride.segmentStartedAt = nil
        stopSensors(); roadlog.pause(); speedMPS = nil; turnDirection = 0; longitudinalTrend = 0; gpsTrend.reset(); vehicleState = nil
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
            resetSegment()
            if vehicleEstimator.source != (ride.isSimulated ? "simulated" : "inferred") || (ride.isSimulated && demoReplay == nil) {
                resetVehicleEstimator(ride, profile: SensorCalibrationService.shared.profile(for: ride.vehicleId))
            }
            if roadlog.active { roadlog.resume() } else { beginRoadlog(ride, vehicle: nil) }
            startSensors(); errorMessage = nil
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
        stopSensors(); roadlog.pause(); ride.segmentStartedAt = nil
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
        roadlog.finish()
        lastFinishedRide = ride; currentRide = nil; journal = nil; speedMPS = nil; vehicleState = nil; demoReplay = nil
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
    /// Starts the roadlog for a real ride when the mode is on. A resumed ride after termination gets a new package
    /// (same rideId); the earlier one was recovered and sealed at launch.
    private func beginRoadlog(_ ride: Ride, vehicle: Vehicle?) {
        guard !ride.isSimulated, settings?.roadlogEnabled == true, let context else { return }
        let vehicleId = ride.vehicleId
        let vehicle = vehicle ?? (try? context.fetch(FetchDescriptor<Vehicle>(predicate: #Predicate { $0.id == vehicleId })))?.first
        let maintenance = (try? context.fetch(FetchDescriptor<MaintenanceEntry>(predicate: #Predicate { $0.vehicleId == vehicleId }))) ?? []
        roadlog.begin(.init(rideId: ride.id, startedAt: Date(), simulated: false,
                            vehicle: vehicle.map { RoadlogRecorder.vehicleMetadata($0, maintenance: maintenance) },
                            calibration: RoadlogRecorder.calibrationMetadata(SensorCalibrationService.shared.profile(for: vehicleId)),
                            rawAudio: settings?.roadlogRawAudio == true),
                      motionManager: motionManager, locationManager: locationManager)
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
        vehicleEstimator.setShiftSensitivity(signalProcessor.shiftDeepFraction)
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
            // With a roadlog the shared manager runs at 100 Hz; the legacy path is decimated back to 50 Hz so
            // TelemetryJournal, the signal heuristics and the inertial bridge see the same rate as before.
            let sink = roadlog.sink, rate = sink == nil ? 50.0 : RoadlogRecorder.motionHz
            let legacy = MotionDecimator(sourceHz: rate, targetHz: 50)
            motionManager.deviceMotionUpdateInterval = 1 / rate
            motionManager.startDeviceMotionUpdates(using: sink == nil ? .xArbitraryZVertical : RoadlogRecorder.referenceFrame, to: motionQueue) { [weak self] data, error in
                guard let data else { return }
                sink?.motion(data)
                guard legacy.accept(data.timestamp) else { return }
                let sample = MotionValues(segmentId: motionSegmentID, timestamp: data.timestamp, ax: data.userAcceleration.x * 9.80665,
                    ay: data.userAcceleration.y * 9.80665, az: data.userAcceleration.z * 9.80665,
                    rx: data.rotationRate.x, ry: data.rotationRate.y, rz: data.rotationRate.z,
                    gx: data.gravity.x, gy: data.gravity.y, gz: data.gravity.z)
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
        vehicleEstimator.motion(t: value.timestamp, userAcceleration: SIMD3(value.ax, value.ay, value.az) / 9.80665,
                                gravity: SIMD3(value.gx, value.gy, value.gz), rotation: SIMD3(value.rx, value.ry, value.rz))
        handleVehicleEvents()
    }
    private func addEvent(_ event: RideEvent) {
        guard let ride = currentRide else { return }
        roadlog.signalEvent(event)
        var events = ride.events; events.append(event); ride.events = events
        recentEvents = Array(events.suffix(10).reversed())
    }
    private func resetVehicleEstimator(_ ride: Ride, profile: CalibrationProfile?) {
        vehicleEstimator = VehicleStateEstimator(simulated: ride.isSimulated, calibrationForward: ride.isSimulated ? nil : profile?.forward.vector)
        vehicleEstimator.setShiftSensitivity(signalProcessor.shiftDeepFraction)
        vehicleState = nil; lastSoundUptime = 0
        demoReplay = ride.isSimulated ? VehicleReplay.bundledSynthetic.map(VehicleReplayCursor.init) : nil
    }
    /// Recalibrate the automatic mount estimate (控制中心, only while stopped). Returns false while moving.
    @discardableResult func recalibrateMount() -> Bool {
        guard vehicleState.map({ $0.motion == .stopped }) ?? true else { return false }
        vehicleEstimator.recalibrateMount(); vehicleState = vehicleEstimator.snapshot()
        if let sink = roadlog.sink { sink.event("vehicle_mount_recalibrate", source: "user") }
        return true
    }
    var mountStatusLabel: String {
        guard let m = vehicleState?.mount else { return "骑行中自动估计（停车时可重新校准）" }
        switch m.status {
        case .converged: return "已自动收敛 · 置信度 \(Int((m.confidence * 100).rounded()))%"
        case .calibrated: return "使用人工安装校准作初值 · 自动估计中"
        case .learning: return "自动估计中 · 需要几段直线加减速"
        }
    }
    /// 10 Hz: microphone features and the inertial speed into the estimator, then publish the snapshot.
    private func feedVehicleTick() {
        let now = ProcessInfo.processInfo.systemUptime
        if isSimulated {
            if demoReplay != nil { demoReplay!.advance(to: demoProgress, estimator: &vehicleEstimator) }
        } else {
            let sound = EngineSoundService.shared
            if sound.live, let f = sound.features, sound.sampleUptime > lastSoundUptime { lastSoundUptime = sound.sampleUptime; vehicleEstimator.acoustic(t: sound.sampleUptime, rmsDbfs: f.db) }
            if speedMPS == nil, let estimate = inertialPresentation { vehicleEstimator.imuSpeed(t: now, speed: estimate.speed) }
            vehicleEstimator.advance(now)
        }
        handleVehicleEvents()
        guard tickNumber % 3 == 0 else { return }
        let snapshot = vehicleEstimator.snapshot()
        vehicleState = isSimulated && demoReplay == nil ? nil : snapshot
        if roadlog.active, vehicleState != nil { roadlog.vehicleState(snapshot) }
    }
    private func handleVehicleEvents() {
        for event in vehicleEstimator.drainEvents() {
            if roadlog.active { roadlog.vehicleEvent(event) }
            let demoStart = demoWallStart, clock = telemetryClock, simulated = isSimulated
            let wall: (Double) -> Date? = { t in simulated ? demoStart?.addingTimeInterval(t) : clock.motion(uptime: t)?.timestamp }
            if let ride = signalProcessor.rideEvent(event, wall: wall, speed: speedMPS, simulated: isSimulated) { addEvent(ride) }
        }
    }
    static func vehicleLabel(_ v: VehicleStateSnapshot, speed: Double?) -> String? {
        if v.turn != .none { return v.turn == .left ? "左转趋势" : "右转趋势" }
        switch v.motion {
        case .stopped: return v.engine == .revving ? "临时停车 · 轰油门" : v.engine == .idle ? "临时停车 · 怠速" : v.engine == .off ? "临时停车 · 熄火" : "临时停车"
        case .launching: return "起步"
        case .accelerating: return "加速趋势"
        case .braking: return "减速趋势"
        case .hardBraking: return "急减速"
        case .coasting: return "滑行"
        case .cruising: return speed == nil ? nil : "行驶中"
        }
    }
    private func tick() {
        tickNumber += 1
        if tickNumber % 30 == 0 {
            let info = ProcessInfo.processInfo
            switch info.thermalState { case .fair: thermalState = "fair"; case .serious: thermalState = "serious"; case .critical: thermalState = "critical"; default: thermalState = "nominal" }
            thermalLimited = info.thermalState == .serious || info.thermalState == .critical
            lowPowerMode = info.isLowPowerModeEnabled
        }
        guard let ride = currentRide else { return }
        if isRecording { feedVehicleTick() }
        if isRecording, roadlog.active {
            let now = ProcessInfo.processInfo.systemUptime
            if tickNumber % 3 == 0 { roadlog.inferredSpeed(inertialPresentation, anchorAge: velocityBridge.anchorAge(at: now)) }
            if tickNumber % 30 == 0 { roadlog.inferredSignal(trend: longitudinalTrend, turn: turnDirection, acceleration: accelerationIntensity, rotation: rotationIntensity) }
        }
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
    /// Demo speed profile (km/h, explicitly simulated): launch, climb through 20…100, brake to a stop, roll again. 76 s loop.
    nonisolated static let demoProfile: [(t: Double, kmh: Double)] = [(0,0),(1,6),(3,15),(5,24),(7,32),(9,40),(11,47),(13,53),(15,58),(17,62),(19,66),(22,74),(25,82),(28,90),(31,97),(33,101),(35,104),(38,99),(41,84),(44,62),(47,40),(50,20),(52,8),(53,0),(56,0),(58,9),(61,24),(64,33),(68,38),(72,30),(76,0)]
    nonisolated static func demoSpeedKmh(at t: Double) -> Double {
        let profile = demoProfile, cycle = profile[profile.count - 1].t
        let x = max(0, t).truncatingRemainder(dividingBy: cycle)
        for i in 1..<profile.count where x <= profile[i].t {
            let a = profile[i - 1], b = profile[i]
            return a.kmh + (b.kmh - a.kmh) * (x - a.t) / max(0.001, b.t - a.t)
        }
        return 0
    }
    private func demoTick() {
        guard let ride = currentRide else { return }
        demoProgress += 1 / 30
        let t = demoProgress, second = Int(t)
        // Like GPS, the demo produces one discrete reading per second; the cockpit shows it unchanged until the next one.
        if second != demoSecond {
            demoSecond = second
            // DEMO speed: the bundled synthetic replay's 1 Hz GPS (its GPS outage shows as no reading); profile fallback.
            let reading: Double? = if let cursor = demoReplay { cursor.speed(at: Double(second)) } else { Self.demoSpeedKmh(at: Double(second)) / 3.6 }
            let kph = (reading ?? 0) * 3.6
            speedMPS = reading; speedSampleTime = ProcessInfo.processInfo.systemUptime; speedSampleElapsed = elapsedSeconds
            if reading != nil { ride.maxSpeedMPS = max(ride.maxSpeedMPS, kph / 3.6); ride.validSpeedSamples += 1 }
            longitudinalTrend = gpsTrend.update(speed: speedMPS, accuracy: 0.1, timestamp: Date(), now: Date())
            let a = t / 200
            if let point = telemetryClock.motion(uptime: ProcessInfo.processInfo.systemUptime) {
                journal?.append(.init(timestamp: point.timestamp, monotonicS: point.elapsed,
                    source: "simulated", stream: "simulation", segmentId: telemetryClock.id.uuidString, speedMPS: kph / 3.6, latitude: 31.2304 + sin(a) * 0.016,
                    longitude: 121.4737 + (1 - cos(a)) * 0.021, horizontalAccuracyM: 5, speedAccuracyMPS: 0.5,
                    accelerationX: accelerationIntensity * 5, rotationZ: turnDirection * 0.3, quality: "valid"))
            }
            if demoReplay == nil, second > 0, second % 22 == 0 {
                addEvent(.init(kind: "turn", timestamp: Date(), windowStart: Date().addingTimeInterval(-2), windowEnd: Date().addingTimeInterval(2), confidence: 0.45, source: "simulated"))
            }
        }
        let speed = speedMPS ?? 0
        if let v = vehicleState {
            turnDirection = v.turn == .left ? -min(1, abs(v.yawRateDegS) / 25) : v.turn == .right ? min(1, abs(v.yawRateDegS) / 25) : 0
            accelerationIntensity = max(v.accelIntensity, v.brakeIntensity); rotationIntensity = abs(turnDirection) * 0.6
        } else {
            turnDirection = sin(t / 5) * 0.7
            accelerationIntensity = 0.14 + min(0.5, abs(Double(longitudinalTrend)) * 0.3)
            rotationIntensity = abs(turnDirection) * 0.6
        }
        ride.distanceM += speed / 30
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
        roadlog.location(locations)
        for location in locations.sorted(by: { $0.timestamp < $1.timestamp }) {
            let now = Date()
            guard location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 100,
                  abs(now.timeIntervalSince(location.timestamp)) <= 10,
                  let sampleElapsed = telemetryClock.location(timestamp: location.timestamp),
                  lastLocation == nil || location.timestamp > lastLocation!.timestamp else { continue }
            lastLocation = location; locationAccuracy = location.horizontalAccuracy
            // Same monotonic base as CoreMotion: uptime now minus the fix's age.
            vehicleEstimator.gps(t: ProcessInfo.processInfo.systemUptime - now.timeIntervalSince(location.timestamp), speed: location.speed >= 0 ? location.speed : nil,
                                 accuracy: location.speedAccuracy >= 0 ? location.speedAccuracy : 99, horizontalAccuracy: location.horizontalAccuracy)
            speedMPS = SpeedQuality.accepted(speed: location.speed, accuracy: location.speedAccuracy, timestamp: location.timestamp, now: now)
            if speedMPS != nil {
                let uptime = ProcessInfo.processInfo.systemUptime
                speedSampleTime = uptime; speedSampleElapsed = ride.durationS + max(0, uptime - segmentMonotonicStart)
            }
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
    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) { if isRecording, !isSimulated { roadlog.heading(newHeading) } }
    func locationManagerShouldDisplayHeadingCalibration(_ manager: CLLocationManager) -> Bool { false }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { roadlog.locationError(error); locationStatus = "定位暂不可用"; speedMPS = nil; longitudinalTrend = 0; gpsTrend.reset() }
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
    var gx: Double; var gy: Double; var gz: Double
}
