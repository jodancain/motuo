import Foundation
import CoreMotion
import CoreLocation
import Observation
import UIKit

/// Thread-safe entry point used by sensor callbacks (motion queue, audio thread). Converts sensor objects to rows and
/// applies the storage degradation level; everything else is the writer's job.
final class RoadlogSink: @unchecked Sendable {
    let writer: RoadlogPackageWriter
    let audio: RoadlogAudioProcessor
    private let lock = NSLock()
    private var _level = 0
    private var lastMotionT: Double?
    private var lastLocationUptime: Double?
    private var _mapping: RoadlogClockMapping
    init(writer: RoadlogPackageWriter, mapping: RoadlogClockMapping, rawAudio: Bool) {
        self.writer = writer; _mapping = mapping
        audio = RoadlogAudioProcessor(writer: writer, rawAudio: rawAudio)
    }
    var level: Int { lock.lock(); defer { lock.unlock() }; return _level }
    var mapping: RoadlogClockMapping { lock.lock(); defer { lock.unlock() }; return _mapping }
    func setLevel(_ value: Int) { lock.lock(); _level = value; lock.unlock(); writer.setDegradation(value); if value >= 1 { audio.stopRaw(reason: "low_storage") } }
    func updateMapping(_ value: RoadlogClockMapping, reason: String) { lock.lock(); _mapping = value; lock.unlock(); writer.clock(value, reason: reason) }
    func secondsSinceLocation(now: Double) -> Double? { lock.lock(); defer { lock.unlock() }; return lastLocationUptime.map { now - $0 } }

    /// Generic row input (sensor conversions and the synthetic test both end here).
    func feed(_ stream: String, _ values: [Double?]) {
        guard level < 3 else { return }
        if level >= 2, ["accel_raw", "gyro_raw", "mag_raw", "batched_accel", "batched_motion"].contains(stream) { return }
        if stream == "motion", level >= 2, let t = values.first ?? nil {
            lock.lock(); let skip = lastMotionT.map { t - $0 < 0.0395 } ?? false; if !skip { lastMotionT = t }; lock.unlock()   // 100 → 25 Hz
            if skip { return }
        }
        writer.append(stream, values)
    }
    static func motionValues(_ m: CMDeviceMotion) -> [Double?] {
        let q = m.attitude.quaternion, f = m.magneticField
        let heading: Double? = m.heading >= 0 ? m.heading : nil
        let accuracy: Double = f.accuracy == .uncalibrated ? -1 : f.accuracy == .low ? 0 : f.accuracy == .medium ? 1 : 2
        let hasField = f.accuracy != .uncalibrated || f.field.x != 0 || f.field.y != 0 || f.field.z != 0
        return [m.timestamp, m.userAcceleration.x, m.userAcceleration.y, m.userAcceleration.z,
                m.gravity.x, m.gravity.y, m.gravity.z, m.rotationRate.x, m.rotationRate.y, m.rotationRate.z,
                q.w, q.x, q.y, q.z, hasField ? f.field.x : nil, hasField ? f.field.y : nil, hasField ? f.field.z : nil, accuracy, heading]
    }
    func motion(_ m: CMDeviceMotion) { feed("motion", Self.motionValues(m)) }
    func accelerometer(_ d: CMAccelerometerData) { feed("accel_raw", [d.timestamp, d.acceleration.x, d.acceleration.y, d.acceleration.z]) }
    func gyro(_ d: CMGyroData) { feed("gyro_raw", [d.timestamp, d.rotationRate.x, d.rotationRate.y, d.rotationRate.z]) }
    func magnetometer(_ d: CMMagnetometerData) { feed("mag_raw", [d.timestamp, d.magneticField.x, d.magneticField.y, d.magneticField.z]) }
    func altitude(_ d: CMAltitudeData) { feed("altimeter", [d.timestamp, d.relativeAltitude.doubleValue, d.pressure.doubleValue]) }
    func absoluteAltitude(_ d: CMAbsoluteAltitudeData) { feed("abs_altitude", [d.timestamp, d.altitude, d.accuracy, d.precision]) }
    func location(_ l: CLLocation) {
        let unix = l.timestamp.timeIntervalSince1970, t = mapping.mono(forUnix: unix)
        lock.lock(); lastLocationUptime = ProcessInfo.processInfo.systemUptime; lock.unlock()
        let valid = { (v: Double) -> Double? in v >= 0 && v.isFinite ? v : nil }
        let source = l.sourceInformation
        feed("location", [t, unix, l.coordinate.latitude, l.coordinate.longitude,
                          l.verticalAccuracy >= 0 ? l.altitude : nil, l.verticalAccuracy >= 0 ? l.ellipsoidalAltitude : nil,
                          valid(l.horizontalAccuracy), valid(l.verticalAccuracy), valid(l.speed), valid(l.speedAccuracy),
                          valid(l.course), valid(l.courseAccuracy), l.floor.map { Double($0.level) },
                          source.map { $0.isSimulatedBySoftware ? 1 : 0 }, source.map { $0.isProducedByAccessory ? 1 : 0 }])
    }
    func heading(_ h: CLHeading) {
        let unix = h.timestamp.timeIntervalSince1970
        feed("heading", [mapping.mono(forUnix: unix), unix, h.magneticHeading >= 0 ? h.magneticHeading : nil, h.trueHeading >= 0 ? h.trueHeading : nil,
                         h.headingAccuracy >= 0 ? h.headingAccuracy : nil, h.x, h.y, h.z])
    }
    func event(_ type: String, source: String = "app", t: Double = ProcessInfo.processInfo.systemUptime, _ fields: [String: Any] = [:]) {
        var object = fields; object["type"] = type; object["source"] = source; object["t_mono"] = t
        writer.log(.events, object)
    }
}

/// Decimates a 100 Hz device-motion feed back to the legacy 50 Hz so TelemetryJournal and the signal heuristics are unchanged.
final class MotionDecimator: @unchecked Sendable {
    let minimumInterval: Double
    private var last: Double?
    init(sourceHz: Double, targetHz: Double) { minimumInterval = sourceHz > targetHz ? 0.75 / targetHz : 0 }
    func accept(_ t: Double) -> Bool {
        if let last, t - last < minimumInterval { return false }
        last = t; return true
    }
}

struct RoadlogThresholds: Sendable {
    var stopRawAudio: Int64 = 2 << 30
    var reduceIMU: Int64 = 1 << 30
    var stopRoadlog: Int64 = 300 << 20
    func level(free: Int64) -> Int { free < stopRoadlog ? 3 : free < reduceIMU ? 2 : free < stopRawAudio ? 1 : 0 }
}

struct RoadlogStartInfo {
    var rideId: UUID
    var startedAt = Date()
    var simulated = false
    var vehicle: [String: Any]?
    var calibration: [String: Any]?
    var rawAudio = false
}

/// Owns the roadlog lifecycle for one ride: package, extra sensors, device/clock monitor, storage degradation, seal and
/// hand-off to the upload queue. DEMO rides never reach `begin`; `simulated` exists only for synthetic tests.
@MainActor @Observable final class RoadlogRecorder {
    static let shared = RoadlogRecorder()
    static let motionHz = 100.0
    nonisolated static var referenceFrame: CMAttitudeReferenceFrame {
        CMMotionManager.availableAttitudeReferenceFrames().contains(.xMagneticNorthZVertical) ? .xMagneticNorthZVertical : .xArbitraryCorrectedZVertical
    }
    private(set) var active = false
    private(set) var stats = RoadlogLiveStats()
    private(set) var packageId: String?
    private(set) var lastError: String?
    @ObservationIgnored private(set) var sink: RoadlogSink?
    @ObservationIgnored let root: URL
    @ObservationIgnored var thresholds = RoadlogThresholds()
    @ObservationIgnored var freeBytes: () -> Int64? = { RoadlogRecorder.availableCapacity(Roadlog.localRoot) }
    @ObservationIgnored var upload: RoadlogUploadQueue?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var tickCount = 0
    @ObservationIgnored private var gpsLost = false
    @ObservationIgnored private var paused = false
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private weak var motionManager: CMMotionManager?
    @ObservationIgnored private weak var locationManager: CLLocationManager?
    @ObservationIgnored private let altimeter = CMAltimeter()
    @ObservationIgnored private let sensorQueue: OperationQueue = { let q = OperationQueue(); q.name = "motuo.roadlog.sensors"; q.maxConcurrentOperationCount = 1; q.qualityOfService = .userInitiated; return q }()
    @ObservationIgnored private var sealing: [String: Task<Void, Never>] = [:]

    init(root: URL = Roadlog.localRoot) { self.root = root }

    nonisolated static func availableCapacity(_ url: URL) -> Int64? {
        let probe = FileManager.default.fileExists(atPath: url.path) ? url : url.deletingLastPathComponent()
        return (try? probe.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
    }

    /// Starts a package. Returns false (and records the reason) when storage is already below the stop threshold or the
    /// package cannot be created; the base ride recording is unaffected either way.
    @discardableResult func begin(_ info: RoadlogStartInfo, motionManager: CMMotionManager? = nil, locationManager: CLLocationManager? = nil) -> Bool {
        guard sink == nil else { return true }
        lastError = nil
        let free = freeBytes()
        if let free, thresholds.level(free: free) >= 3 { lastError = "存储空间不足，本次未采集路谱（基础记录照常）"; return false }
        let mapping = RoadlogClockMapping.now()
        let name = Roadlog.packageName(start: info.startedAt, rideId: info.rideId)
        do {
            let writer = try RoadlogPackageWriter(root: root, session: Self.session(info, packageId: name, mapping: mapping), packageId: name, mapping: mapping)
            let sink = RoadlogSink(writer: writer, mapping: mapping, rawAudio: info.rawAudio)
            self.sink = sink; packageId = name; active = true; stats = RoadlogLiveStats(); tickCount = 0; gpsLost = false; paused = false
            upload?.enqueue(name, simulated: info.simulated, state: .pendingSeal)
            sink.event("ride_start", ["rideId": info.rideId.uuidString])
            recordStaticStatuses(sink)
            recordAccessoryState(sink)
            if let free { applyStorage(free: free) }
            self.motionManager = motionManager; self.locationManager = locationManager
            startSensors()
            startMonitoring()
            return true
        } catch { lastError = "路谱包创建失败：\(error.localizedDescription)"; return false }
    }
    func pause() {
        guard let sink, !paused else { return }
        paused = true
        let t = ProcessInfo.processInfo.systemUptime
        sink.event("ride_pause", t: t); sink.writer.pause(t: t); stopSensors()
    }
    func resume() {
        guard let sink, paused else { return }
        paused = false
        let t = ProcessInfo.processInfo.systemUptime
        sink.updateMapping(.now(), reason: "resume"); sink.event("ride_resume", t: t); sink.writer.resume(t: t); startSensors()
    }
    /// Stops sensors and seals in the background, then hands the package to the upload queue.
    func finish(reason: String = "ride_finish") {
        guard let sink, let name = packageId else { return }
        sink.event(reason)
        if !paused { stopSensors() }
        stopMonitoring(); paused = false
        self.sink = nil; active = false; packageId = nil
        let app = UIApplication.shared
        var background = UIBackgroundTaskIdentifier.invalid
        background = app.beginBackgroundTask(withName: "roadlog.seal") { app.endBackgroundTask(background); background = .invalid }
        sealing[name] = Task { [weak self] in
            let result: Result<Void, Error> = await Task.detached(priority: .utility) {
                await sink.audio.close()
                return Result { try sink.writer.seal(end: .now()) }.map { _ in () }
            }.value
            guard let self else { return }
            if case let .failure(error) = result { self.lastError = "路谱封包失败：\(error.localizedDescription)" }
            self.sealing[name] = nil
            self.upload?.markSealed(name, failed: (try? result.get()) == nil ? self.lastError : nil)
            await self.upload?.process()
            RoadlogBackground.schedule()
            if background != .invalid { app.endBackgroundTask(background) }
        }
    }
    /// Test/synthetic helper: waits for an in-flight seal.
    func waitForSeal(_ name: String) async { await sealing[name]?.value }

    // MARK: feeds from RideEngine (main actor)

    func location(_ locations: [CLLocation]) {
        guard let sink else { return }
        for location in locations { sink.location(location) }
        if gpsLost { gpsLost = false; sink.event("gps_recovered") }
    }
    func heading(_ heading: CLHeading) { sink?.heading(heading) }
    func locationError(_ error: Error) { sink?.event("location_error", ["message": error.localizedDescription]) }
    func signalEvent(_ event: RideEvent) {
        guard let sink else { return }
        let t = sink.mapping.mono(forUnix: event.timestamp.timeIntervalSince1970)
        sink.event("signal_event", source: event.source, t: t, ["kind": event.kind, "confidence": event.confidence, "eventId": event.id.uuidString,
            "windowStart": event.windowStart.timeIntervalSince1970, "windowEnd": event.windowEnd.timeIntervalSince1970])
    }
    func inferredSignal(trend: Int, turn: Double, acceleration: Double, rotation: Double) {
        sink?.feed("inferred_signal", [ProcessInfo.processInfo.systemUptime, Double(trend), turn, acceleration, rotation])
    }
    func inferredSpeed(_ estimate: (speed: Double, uncertainty: Double)?, anchorAge: Double?) {
        guard let estimate else { return }
        sink?.feed("inferred_imu_speed", [ProcessInfo.processInfo.systemUptime, estimate.speed, estimate.uncertainty, anchorAge])
    }
    func accessoryFrame(_ data: Data, transport: String) {
        sink?.writer.log(.accessory, ["type": "frame", "source": "measured", "transport": transport, "base64": data.base64EncodedString(),
                                      "parsed": RoadlogJSON.object(data) ?? NSNull()])
    }

    // MARK: sensors

    private func startSensors() {
        guard let sink, sink.level < 3 else { return }
        if let manager = motionManager, sink.level < 2 {
            if manager.isAccelerometerAvailable {
                manager.accelerometerUpdateInterval = 1 / Self.motionHz
                manager.startAccelerometerUpdates(to: sensorQueue) { data, _ in if let data { sink.accelerometer(data) } }
            }
            if manager.isGyroAvailable {
                manager.gyroUpdateInterval = 1 / Self.motionHz
                manager.startGyroUpdates(to: sensorQueue) { data, _ in if let data { sink.gyro(data) } }
            }
            if manager.isMagnetometerAvailable {
                manager.magnetometerUpdateInterval = 1 / 50
                manager.startMagnetometerUpdates(to: sensorQueue) { data, _ in if let data { sink.magnetometer(data) } }
            }
        }
        if CMAltimeter.isRelativeAltitudeAvailable() {
            altimeter.startRelativeAltitudeUpdates(to: sensorQueue) { data, error in
                if let data { sink.altitude(data) } else if let error { sink.writer.streamStatus("altimeter", "unavailable", reason: error.localizedDescription) }
            }
        }
        if CMAltimeter.isAbsoluteAltitudeAvailable() {
            altimeter.startAbsoluteAltitudeUpdates(to: sensorQueue) { data, error in
                if let data { sink.absoluteAltitude(data) } else if let error { sink.writer.streamStatus("abs_altitude", "unavailable", reason: error.localizedDescription) }
            }
        }
        if let locationManager, CLLocationManager.headingAvailable() {
            locationManager.headingFilter = kCLHeadingFilterNone; locationManager.startUpdatingHeading()
        }
        RoadlogAudioTap.shared.attach(sink.audio)
        AccessoryService.shared.onFrame = { [weak self] data, transport in self?.accessoryFrame(data, transport: transport) }
    }
    private func stopSensors() {
        if let manager = motionManager { manager.stopAccelerometerUpdates(); manager.stopGyroUpdates(); manager.stopMagnetometerUpdates() }
        altimeter.stopRelativeAltitudeUpdates(); altimeter.stopAbsoluteAltitudeUpdates()
        locationManager?.stopUpdatingHeading()
        RoadlogAudioTap.shared.detach()
        AccessoryService.shared.onFrame = nil
    }
    private func recordStaticStatuses(_ sink: RoadlogSink) {
        let w = sink.writer
        w.streamStatus("batched_accel", "unsupported", reason: "iOS SDK 26.5 中 CMBatchedSensorManager 仅标注 watchOS 10+，iPhone 无此 API")
        w.streamStatus("batched_motion", "unsupported", reason: "iOS SDK 26.5 中 CMBatchedSensorManager 仅标注 watchOS 10+，iPhone 无此 API")
        if motionManager == nil && sink.writer.simulated == false { w.streamStatus("accel_raw", "unavailable", reason: "未接入运动管理器") }
        if let m = motionManager {
            if !m.isDeviceMotionAvailable { w.streamStatus("motion", "unsupported", reason: "设备不支持 deviceMotion") }
            if !m.isAccelerometerAvailable { w.streamStatus("accel_raw", "unsupported", reason: "无加速度计") }
            if !m.isGyroAvailable { w.streamStatus("gyro_raw", "unsupported", reason: "无陀螺仪") }
            if !m.isMagnetometerAvailable { w.streamStatus("mag_raw", "unsupported", reason: "无磁力计") }
        }
        if motionManager != nil || locationManager != nil {
            if !CMAltimeter.isRelativeAltitudeAvailable() { w.streamStatus("altimeter", "unsupported", reason: "设备无气压计") }
            if !CMAltimeter.isAbsoluteAltitudeAvailable() { w.streamStatus("abs_altitude", "unsupported", reason: "绝对高度不可用") }
            if !CLLocationManager.headingAvailable() { w.streamStatus("heading", "unsupported", reason: "设备不提供 CLHeading") }
        }
        if !sink.audio.microphoneLive { w.streamStatus("acoustic", "disabled", reason: "麦克风未开启（按原有规则需你在座舱里显式开启；后台自动停止）") }
    }
    private func recordAccessoryState(_ sink: RoadlogSink) {
        let service = AccessoryService.shared
        if service.state == "ready" {
            sink.writer.log(.accessory, ["type": "connected", "source": "measured", "name": service.connectedName, "capabilities": service.capabilities])
        } else {
            sink.writer.log(.accessory, ["type": "none", "source": "app", "note": "骑行开始时没有已连接的配件（状态 \(service.state)）"])
        }
    }

    // MARK: device, clock, storage, GPS watchdog

    private func startMonitoring() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        recordDevice(reason: "start")
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
        let center = NotificationCenter.default
        let changes: [(Notification.Name, String)] = [
            (ProcessInfo.thermalStateDidChangeNotification, "thermal"), (.NSProcessInfoPowerStateDidChange, "low_power"),
            (UIDevice.batteryStateDidChangeNotification, "battery_state"), (UIDevice.orientationDidChangeNotification, "orientation"),
            (UIApplication.didEnterBackgroundNotification, "app_background"), (UIApplication.willEnterForegroundNotification, "app_foreground"),
            (UIApplication.didReceiveMemoryWarningNotification, "memory_warning"), (UIApplication.significantTimeChangeNotification, "wallclock_change"),
        ]
        for (name, reason) in changes {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.deviceChanged(reason) }
            })
        }
    }
    private func stopMonitoring() {
        timer?.invalidate(); timer = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
    }
    private func deviceChanged(_ reason: String) {
        guard let sink else { return }
        if ["app_background", "app_foreground", "memory_warning"].contains(reason) { sink.event(reason) }
        if reason == "wallclock_change" { sink.updateMapping(.now(), reason: "wallclock_change"); return }
        recordDevice(reason: reason)
    }
    func tick() {
        guard let sink else { return }
        tickCount += 1
        let now = ProcessInfo.processInfo.systemUptime
        if tickCount % 10 == 0 { sink.updateMapping(.now(), reason: "periodic") }
        if tickCount % 30 == 0 { recordDevice(reason: "periodic"); checkStorage() }
        if locationManager != nil, !gpsLost, (sink.secondsSinceLocation(now: now) ?? Double(tickCount)) > 4 { gpsLost = true; sink.event("gps_lost") }
        stats = sink.writer.stats
    }
    func checkStorage() { if let free = freeBytes() { applyStorage(free: free) } }
    /// Levels only increase during a ride (no flapping). Level 3 seals the package; the base recording continues.
    func applyStorage(free: Int64) {
        guard let sink else { return }
        let target = thresholds.level(free: free)
        guard target > sink.level else { return }
        let actions = [1: "raw_audio_stopped", 2: "imu_rate_reduced", 3: "roadlog_stopped"]
        for level in (sink.level + 1)...target {
            sink.event("degradation", ["level": level, "action": actions[level]!, "freeBytes": free, "reason": "low_storage"])
        }
        sink.setLevel(target)
        if target >= 1, sink.audio.rawEnabled { sink.writer.streamStatus("acoustic", "degraded", reason: "存储不足，已停止原始声音（声学特征继续）") }
        if target >= 2 {
            sink.writer.streamStatus("motion", "degraded", reason: "存储不足，降至 25 Hz", extra: ["degradedHz": 25])
            for stream in ["accel_raw", "gyro_raw", "mag_raw"] { sink.writer.streamStatus(stream, "degraded", reason: "存储不足，已停止") }
            if let manager = motionManager { manager.stopAccelerometerUpdates(); manager.stopGyroUpdates(); manager.stopMagnetometerUpdates() }
        }
        stats = sink.writer.stats
        if target >= 3 { finish(reason: "roadlog_stopped_low_storage") }
    }
    private func recordDevice(reason: String) {
        guard let sink else { return }
        let device = UIDevice.current, info = ProcessInfo.processInfo
        let battery: Any = device.batteryLevel >= 0 ? Double(device.batteryLevel) : NSNull()
        let states: [UIDevice.BatteryState: String] = [.unplugged: "unplugged", .charging: "charging", .full: "full"]
        let thermal: [ProcessInfo.ThermalState: String] = [.nominal: "nominal", .fair: "fair", .serious: "serious", .critical: "critical"]
        let orientations: [UIDeviceOrientation: String] = [.portrait: "portrait", .portraitUpsideDown: "portraitUpsideDown", .landscapeLeft: "landscapeLeft",
                                                           .landscapeRight: "landscapeRight", .faceUp: "faceUp", .faceDown: "faceDown"]
        let appState: String = switch UIApplication.shared.applicationState { case .active: "active"; case .inactive: "inactive"; default: "background" }
        sink.writer.log(.device, ["type": "device", "source": "measured", "reason": reason,
            "battery_level": battery, "battery_state": states[device.batteryState] ?? "unknown",
            "thermal_state": thermal[info.thermalState] ?? "unknown", "low_power_mode": info.isLowPowerModeEnabled,
            "orientation": orientations[device.orientation] ?? "unknown", "app_state": appState,
            "free_bytes": freeBytes() as Any? ?? NSNull(), "memory_footprint_bytes": Self.memoryFootprint() as Any? ?? NSNull()])
    }
    nonisolated static func memoryFootprint() -> Int? {
        var info = task_vm_info_data_t(), count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return result == KERN_SUCCESS ? Int(info.phys_footprint) : nil
    }

    // MARK: metadata

    nonisolated static func hardwareModel() -> String {
        #if targetEnvironment(simulator)
        return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "simulator"
        #else
        var size = 0; sysctlbyname("hw.machine", nil, &size, nil, 0)
        var bytes = [CChar](repeating: 0, count: size); sysctlbyname("hw.machine", &bytes, &size, nil, 0)
        return String(cString: bytes)
        #endif
    }
    static func session(_ info: RoadlogStartInfo, packageId: String, mapping: RoadlogClockMapping) -> [String: Any] {
        let bundle = Bundle.main
        var simulator = false
        #if targetEnvironment(simulator)
        simulator = true
        #endif
        let frame = referenceFrame == .xMagneticNorthZVertical ? "xMagneticNorthZVertical" : "xArbitraryCorrectedZVertical"
        return [
            "schema": Roadlog.schema, "schemaVersion": Roadlog.schemaVersion, "packageId": packageId, "rideId": info.rideId.uuidString,
            "provenance": info.simulated ? "simulated" : "measured", "startedAtUnix": mapping.unix,
            "app": ["bundleId": bundle.bundleIdentifier ?? "cn.yundongyl.motuo",
                    "version": bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?", "build": bundle.infoDictionary?["CFBundleVersion"] as? String ?? "?"],
            "device": ["model": hardwareModel(), "systemName": UIDevice.current.systemName, "systemVersion": UIDevice.current.systemVersion,
                       "isSimulator": simulator, "idiom": "phone"],
            "vehicle": info.vehicle ?? NSNull(), "calibration": info.calibration ?? NSNull(),
            "settings": ["roadlogEnabled": true, "rawAudioEnabled": info.rawAudio,
                         "requestedRatesHz": ["motion": motionHz, "accel_raw": motionHz, "gyro_raw": motionHz, "mag_raw": 50, "inferred_signal": 1, "location": 1],
                         "locationAccuracy": "kCLLocationAccuracyBestForNavigation", "activityType": "automotiveNavigation", "distanceFilter": "none",
                         "pausesAutomatically": false, "headingFilter": "none", "attitudeReferenceFrame": frame,
                         "legacyTelemetry": "TelemetryJournal 仍按 50 Hz 记录 deviceMotion（从 100 Hz 降采样），与路谱独立"],
            "capabilities": ["batchedSensorManager": ["accelerometerSupported": false, "deviceMotionSupported": false,
                                                      "note": "iOS SDK 26.5 的 CMBatchedSensorManager 仅 watchOS 10+ 可用；iPhone 无 800 Hz/200 Hz 批量接口"],
                             "deviceMotion": CMMotionManager().isDeviceMotionAvailable, "magnetometer": CMMotionManager().isMagnetometerAvailable,
                             "relativeAltitude": CMAltimeter.isRelativeAltitudeAvailable(), "absoluteAltitude": CMAltimeter.isAbsoluteAltitudeAvailable(),
                             "heading": CLLocationManager.headingAvailable(),
                             "availableReferenceFrames": CMMotionManager.availableAttitudeReferenceFrames().rawValue],
        ]
    }
    static func vehicleMetadata(_ vehicle: Vehicle, maintenance: [MaintenanceEntry]) -> [String: Any] {
        // Plate omitted: not needed for analysis and identifies the owner.
        ["id": vehicle.id.uuidString, "name": vehicle.name, "make": vehicle.make, "model": vehicle.model,
         "year": vehicle.year as Any? ?? NSNull(), "abs": vehicle.abs as Any? ?? NSNull(), "displacementCC": vehicle.displacementCC,
         "tyres": vehicle.tyres, "modifications": vehicle.modifications, "odometerKM": vehicle.odometerKM,
         "maintenanceSummary": maintenance.sorted { $0.performedAt > $1.performedAt }.prefix(10).map {
             ["performedAt": Roadlog.iso($0.performedAt), "odometerKM": $0.odometerKM, "category": $0.category]
         }]
    }
    static func calibrationMetadata(_ p: CalibrationProfile?) -> [String: Any]? {
        guard let p else { return nil }
        let row = { (a: CalibrationAxis) in [a.x, a.y, a.z] }
        return ["id": p.id.uuidString, "version": p.version, "mountName": p.mountName, "forwardHint": p.forwardHint, "deviceModel": p.deviceModel,
                "createdAt": Roadlog.iso(p.createdAt), "sampleCount": p.sampleCount, "source": "SensorCalibrationService",
                "matrix": [row(p.right), row(p.forward), row(p.up)],
                "matrixNote": "行依次为车辆右/前/上方向在设备坐标中的单位向量；vehicle = matrix · device（用户加速度需先减 accelerationBias，单位 m/s²）",
                "accelerationBiasMps2": row(p.accelerationBias), "rotationRMS": p.rotationRMS, "accelerationRMS": p.accelerationRMS]
    }
}
