import Foundation
import CoreMotion
import Observation
import UIKit
import simd

struct CalibrationAxis: Codable, Sendable {
    var x: Double; var y: Double; var z: Double
    init(_ vector: SIMD3<Double>) { x = vector.x; y = vector.y; z = vector.z }
    var vector: SIMD3<Double> { SIMD3(x, y, z) }
}
struct CalibrationProfile: Codable, Identifiable, Sendable {
    var id: UUID
    var vehicleId: UUID
    var installationId: String
    var deviceModel: String
    var mountName: String
    var forwardHint: String
    var createdAt: Date
    var version: Int
    var sampleCount: Int
    var up: CalibrationAxis
    var forward: CalibrationAxis
    var right: CalibrationAxis
    var accelerationBias: CalibrationAxis
    var rotationRMS: Double
    var accelerationRMS: Double
    /// Coordinates are mount-relative observations, not validated vehicle lean angles.
    func projected(_ value: SIMD3<Double>) -> SIMD3<Double> {
        SIMD3(simd_dot(value, right.vector), simd_dot(value, forward.vector), simd_dot(value, up.vector))
    }
}
enum MountForwardHint: String, CaseIterable, Identifiable {
    case top = "手机顶部朝前", right = "手机右侧朝前", left = "手机左侧朝前", outward = "屏幕朝向前方"
    var id: String { rawValue }
    var vector: SIMD3<Double> {
        switch self { case .top: SIMD3(0,1,0); case .right: SIMD3(1,0,0); case .left: SIMD3(-1,0,0); case .outward: SIMD3(0,0,1) }
    }
}
struct CalibrationReading: Sendable {
    var timestamp: Double
    var gravity: SIMD3<Double>
    var acceleration: SIMD3<Double>
    var rotation: SIMD3<Double>
}
enum CalibrationMath {
    static func basis(readings: [CalibrationReading], forwardHint: SIMD3<Double>) throws -> (SIMD3<Double>, SIMD3<Double>, SIMD3<Double>, SIMD3<Double>, Double, Double) {
        guard readings.count >= 60, let first = readings.first, let last = readings.last,
              last.timestamp - first.timestamp >= 1.4 else { throw APIClientError(message:"有效采样不足，请保持扶正静止后重试") }
        guard readings.allSatisfy({ $0.gravity.x.isFinite && $0.gravity.y.isFinite && $0.gravity.z.isFinite && $0.acceleration.x.isFinite && $0.acceleration.y.isFinite && $0.acceleration.z.isFinite && $0.rotation.x.isFinite && $0.rotation.y.isFinite && $0.rotation.z.isFinite }) else { throw APIClientError(message:"传感器样本无效") }
        let count = Double(readings.count)
        let gravity = readings.reduce(SIMD3<Double>.zero) { $0 + $1.gravity } / count
        let bias = readings.reduce(SIMD3<Double>.zero) { $0 + $1.acceleration } / count
        let gyroRMS = sqrt(readings.reduce(0.0) { $0 + simd_length_squared($1.rotation) } / count)
        let accelerationRMS = sqrt(readings.reduce(0.0) { $0 + simd_length_squared($1.acceleration) } / count)
        let gravitySpread = sqrt(readings.reduce(0.0) { $0 + simd_length_squared($1.gravity-gravity) } / count)
        guard (0.9...1.1).contains(simd_length(gravity)), gyroRMS < 0.10, accelerationRMS < 0.35, gravitySpread < 0.025 else { throw APIClientError(message:"采样期间存在移动或振动。请熄火、扶正车辆并保持静止") }
        let up = -simd_normalize(gravity)
        let projected = forwardHint - simd_dot(forwardHint, up) * up
        guard simd_length(projected) > 0.25 else { throw APIClientError(message:"所选手机方向接近竖直，无法确定车头方向，请选择实际朝向前方的手机边或屏幕方向") }
        let forward = simd_normalize(projected)
        let right = simd_normalize(simd_cross(forward, up))
        return (up, forward, right, bias, gyroRMS, accelerationRMS)
    }
}
@MainActor @Observable final class SensorCalibrationService {
    static let shared = SensorCalibrationService()
    private(set) var sampling = false
    private(set) var status = "停车扶正后采样"
    private(set) var profiles: [CalibrationProfile] = []
    private(set) var selectionRevision = 0
    @ObservationIgnored private let motion = CMMotionManager()
    @ObservationIgnored private var readings: [CalibrationReading] = []
    @ObservationIgnored private var generation = UUID()
    private var file: URL { FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("calibrations.json") }
    init() { profiles = (try? JSONDecoder().decode([CalibrationProfile].self, from:Data(contentsOf:file))) ?? [] }
    func profile(for vehicleId: UUID) -> CalibrationProfile? {
        _ = selectionRevision
        let selected = UserDefaults.standard.string(forKey:"calibration.active."+vehicleId.uuidString)
        return profiles.first { $0.vehicleId == vehicleId && $0.id.uuidString == selected }
    }
    func activate(_ profile: CalibrationProfile) { UserDefaults.standard.set(profile.id.uuidString,forKey:"calibration.active."+profile.vehicleId.uuidString); selectionRevision += 1 }
    func cancel() { generation = UUID(); motion.stopDeviceMotionUpdates(); sampling = false; readings = [] }
    func eraseAll() throws {
        cancel()
        if FileManager.default.fileExists(atPath:file.path) { try FileManager.default.removeItem(at:file) }
        for profile in profiles { UserDefaults.standard.removeObject(forKey:"calibration.active."+profile.vehicleId.uuidString) }
        UserDefaults.standard.removeObject(forKey:"calibration.installation")
        profiles = []; selectionRevision += 1
    }
    func sample(vehicleId: UUID, mountName: String, forwardHint: MountForwardHint) async {
        guard !sampling else { return }
        guard motion.isDeviceMotionAvailable else { status = "此设备无可用动态传感器；演示模式不会生成校准"; return }
        sampling = true; readings = []; let current = UUID(); generation = current
        status = "保持静止，正在采样…"
        motion.deviceMotionUpdateInterval = 1/50
        motion.startDeviceMotionUpdates(using:.xArbitraryZVertical,to:.main) { [weak self] data, _ in
            guard let data else { return }
            let reading = CalibrationReading(timestamp:data.timestamp,gravity:SIMD3(data.gravity.x,data.gravity.y,data.gravity.z),acceleration:SIMD3(data.userAcceleration.x,data.userAcceleration.y,data.userAcceleration.z)*9.80665,rotation:SIMD3(data.rotationRate.x,data.rotationRate.y,data.rotationRate.z))
            Task { @MainActor in guard let self, self.generation == current else { return }; self.readings.append(reading) }
        }
        do { try await Task.sleep(for:.seconds(2.3)) } catch { cancel(); return }
        guard generation == current else { return }
        motion.stopDeviceMotionUpdates(); sampling = false
        do {
            let basis = try CalibrationMath.basis(readings:readings,forwardHint:forwardHint.vector)
            let defaults = UserDefaults.standard
            let installation = defaults.string(forKey:"calibration.installation") ?? UUID().uuidString
            defaults.set(installation,forKey:"calibration.installation")
            let version = (profiles.filter { $0.vehicleId == vehicleId }.map(\.version).max() ?? 0)+1
            let profile = CalibrationProfile(id:UUID(),vehicleId:vehicleId,installationId:installation,deviceModel:UIDevice.current.model,mountName:mountName.trimmingCharacters(in:.whitespacesAndNewlines),forwardHint:forwardHint.rawValue,createdAt:Date(),version:version,sampleCount:readings.count,up:.init(basis.0),forward:.init(basis.1),right:.init(basis.2),accelerationBias:.init(basis.3),rotationRMS:basis.4,accelerationRMS:basis.5)
            var updated = profiles; updated.append(profile)
            try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
            try JSONEncoder().encode(updated).write(to:file,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])
            profiles = updated; activate(profile); status = "校准 v\(version) 已保存 · \(readings.count) 个真实样本"
        } catch { status = error.localizedDescription }
        readings = []
    }
}
