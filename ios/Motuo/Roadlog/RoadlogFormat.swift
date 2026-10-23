import Foundation
import CryptoKit
import zlib

/// Roadlog package schema v1. docs/ROADLOG_FORMAT.md is the human spec; tools/roadlog reads the same layout.
enum Roadlog {
    static let schema = "motuo.roadlog"
    static let schemaVersion = 1
    static let chunkSpanS = 60.0
    static let chunkBytes = 4 * 1024 * 1024
    static let containerIdentifier = "iCloud.cn.yundongyl.motuo"

    /// Local packages live in the app's Documents (visible in the Files app via UIFileSharingEnabled).
    static var localRoot: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Roadlog", isDirectory: true)
    }
    static func packageName(start: Date, rideId: UUID) -> String {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss'Z'"
        return f.string(from: start) + "_" + rideId.uuidString
    }
    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func iso(_ date: Date) -> String { date.formatted(.iso8601.year().month().day().timeZone(separator: .omitted).time(includingFractionalSeconds: true).timeSeparator(.colon).dateSeparator(.dash)) }
}

struct RoadlogColumn: Codable, Equatable, Sendable {
    var name: String; var unit: String; var description: String
    var integer = false
    init(_ name: String, _ unit: String, _ description: String, integer: Bool = false) {
        self.name = name; self.unit = unit; self.description = description; self.integer = integer
    }
    enum CodingKeys: String, CodingKey { case name, unit, description }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name); unit = try c.decode(String.self, forKey: .unit); description = try c.decode(String.self, forKey: .description)
        integer = ["int", "0/1"].contains(unit)
    }
}

/// One CSV stream. `source` is fixed per stream: measured sensors, app inference, or simulated (synthetic packages only).
struct RoadlogStreamSpec: Sendable {
    var name: String
    var source: String
    var requestedHz: Double?
    var columns: [RoadlogColumn]
    var frame: String
    /// Sample spacing above this is recorded as a gap (nil: device-driven, no gap detection).
    var gapThresholdS: Double?
    var header: String { columns.map(\.name).joined(separator: ",") }
}

enum RoadlogStreams {
    private static let t = RoadlogColumn("t_mono", "s", "ProcessInfo.systemUptime 秒；与 CoreMotion 时间戳同一时基，见 clock.jsonl")
    private static let tu = RoadlogColumn("t_unix", "s", "原始墙钟时间（1970 UTC 秒）")
    static let deviceAxes = "CoreMotion 设备坐标：x 指向屏幕右侧，y 指向屏幕顶部，z 垂直屏幕向外（右手系）；与手机在车上的安装方向有关，见 manifest.calibration"
    private static func xyz(_ unit: String, _ what: String) -> [RoadlogColumn] {
        ["x", "y", "z"].map { RoadlogColumn($0, unit, "\(what) \($0) 轴") }
    }
    static func motionColumns(prefix: String = "") -> [RoadlogColumn] {
        [t] + ["x", "y", "z"].map { RoadlogColumn("user_acc_\($0)", "g", "去除重力后的用户加速度 \($0)（1 g = 9.80665 m/s²）") }
        + ["x", "y", "z"].map { RoadlogColumn("gravity_\($0)", "g", "重力方向 \($0)") }
        + ["x", "y", "z"].map { RoadlogColumn("rot_\($0)", "rad/s", "校准后角速度 \($0)") }
        + ["w", "x", "y", "z"].map { RoadlogColumn("q_\($0)", "1", "姿态四元数 \($0)（参考系见 manifest.settings.attitudeReferenceFrame）") }
        + ["x", "y", "z"].map { RoadlogColumn("mag_\($0)", "uT", "校准磁场 \($0)") }
        + [RoadlogColumn("mag_accuracy", "int", "磁场校准精度：-1 未校准，0 低，1 中，2 高", integer: true),
           RoadlogColumn("heading_deg", "deg", "CMDeviceMotion.heading（参考系支持时；否则空）")]
    }
    static let motion = RoadlogStreamSpec(name: "motion", source: "measured", requestedHz: 100, columns: motionColumns(), frame: deviceAxes, gapThresholdS: 0.5)
    static let accelRaw = RoadlogStreamSpec(name: "accel_raw", source: "measured", requestedHz: 100, columns: [t] + xyz("g", "原始加速度（含重力）"), frame: deviceAxes, gapThresholdS: 0.5)
    static let gyroRaw = RoadlogStreamSpec(name: "gyro_raw", source: "measured", requestedHz: 100, columns: [t] + xyz("rad/s", "原始陀螺（未校准零偏）"), frame: deviceAxes, gapThresholdS: 0.5)
    static let magRaw = RoadlogStreamSpec(name: "mag_raw", source: "measured", requestedHz: 50, columns: [t] + xyz("uT", "原始磁力计（未校准，含设备偏置）"), frame: deviceAxes, gapThresholdS: 0.5)
    static let batchedAccel = RoadlogStreamSpec(name: "batched_accel", source: "measured", requestedHz: 800, columns: [t] + xyz("g", "批量高频加速度"), frame: deviceAxes, gapThresholdS: 0.5)
    static let batchedMotion = RoadlogStreamSpec(name: "batched_motion", source: "measured", requestedHz: 200, columns: motionColumns(), frame: deviceAxes, gapThresholdS: 0.5)
    static let altimeter = RoadlogStreamSpec(name: "altimeter", source: "measured", requestedHz: nil, columns: [t, RoadlogColumn("rel_alt_m", "m", "相对开始时的高度变化（气压计）"), RoadlogColumn("pressure_kpa", "kPa", "气压")], frame: "相对高度以本流第一条为 0", gapThresholdS: nil)
    static let absAltitude = RoadlogStreamSpec(name: "abs_altitude", source: "measured", requestedHz: nil, columns: [t, RoadlogColumn("altitude_m", "m", "绝对高度（系统融合 GPS 与气压）"), RoadlogColumn("accuracy_m", "m", "精度"), RoadlogColumn("precision_m", "m", "精密度")], frame: "海平面高度", gapThresholdS: nil)
    static let location = RoadlogStreamSpec(name: "location", source: "measured", requestedHz: 1, columns: [t, tu,
        RoadlogColumn("lat", "deg", "纬度 WGS84（未做 GCJ-02 偏移）"), RoadlogColumn("lon", "deg", "经度 WGS84"),
        RoadlogColumn("alt_m", "m", "海拔（平均海平面）"), RoadlogColumn("ellipsoidal_alt_m", "m", "WGS84 椭球高"),
        RoadlogColumn("h_acc_m", "m", "水平精度（负值无效，写空）"), RoadlogColumn("v_acc_m", "m", "垂直精度"),
        RoadlogColumn("speed_mps", "m/s", "GPS 速度"), RoadlogColumn("speed_acc_mps", "m/s", "速度精度"),
        RoadlogColumn("course_deg", "deg", "航向（真北，顺时针）"), RoadlogColumn("course_acc_deg", "deg", "航向精度"),
        RoadlogColumn("floor", "int", "楼层（一般为空）", integer: true),
        RoadlogColumn("sim_by_software", "0/1", "sourceInformation.isSimulatedBySoftware", integer: true),
        RoadlogColumn("from_accessory", "0/1", "sourceInformation.isProducedByAccessory", integer: true)],
        frame: "WGS84；t_mono 由 t_unix 经 clock.jsonl 换算", gapThresholdS: 3)
    static let heading = RoadlogStreamSpec(name: "heading", source: "measured", requestedHz: nil, columns: [t, tu,
        RoadlogColumn("magnetic_deg", "deg", "磁北航向"), RoadlogColumn("true_deg", "deg", "真北航向（需定位，负值写空）"),
        RoadlogColumn("accuracy_deg", "deg", "航向误差"), RoadlogColumn("raw_x", "uT", "原始地磁 x"), RoadlogColumn("raw_y", "uT", "原始地磁 y"), RoadlogColumn("raw_z", "uT", "原始地磁 z")],
        frame: "CLHeading，相对设备 y 轴（顶部）方向；t_mono 由 t_unix 换算", gapThresholdS: nil)
    static let acousticBandEdgesHz: [Double] = (0...16).map { 31.5 * pow(2, Double($0) * log2(24000 / 31.5) / 16) }
    static let acoustic = RoadlogStreamSpec(name: "acoustic", source: "measured", requestedHz: nil, columns: [t,
        RoadlogColumn("rms_dbfs", "dBFS", "帧 RMS"), RoadlogColumn("peak_dbfs", "dBFS", "帧峰值"), RoadlogColumn("clipped", "0/1", "是否削波（|x|>0.98）", integer: true)]
        + (0..<16).map { RoadlogColumn(String(format: "band_%02d", $0), "dBFS", "对数频带 \($0) 平均能量，边界见 manifest.streams.acoustic.bandEdgesHz") },
        frame: "手机麦克风混合环境声，非发动机转速", gapThresholdS: nil)
    static let inferredIMUSpeed = RoadlogStreamSpec(name: "inferred_imu_speed", source: "inferred", requestedHz: nil, columns: [t,
        RoadlogColumn("speed_mps", "m/s", "GPS 锚定的短时 IMU 积分估速（推断，非测量）"), RoadlogColumn("uncertainty_mps", "m/s", "估计 1σ 误差"), RoadlogColumn("anchor_age_s", "s", "距离最近 GPS 锚点的时间")],
        frame: "InertialVelocityBridge，仅 GPS 缺失时有值", gapThresholdS: nil)
    static let inferredSignal = RoadlogStreamSpec(name: "inferred_signal", source: "inferred", requestedHz: 1, columns: [t,
        RoadlogColumn("longitudinal_trend", "int", "GPS 速度趋势：1 加速，-1 减速，0 无", integer: true),
        RoadlogColumn("turn_direction", "1", "GPS 航向变化推断的转向（-1 左 … 1 右）"),
        RoadlogColumn("acceleration_intensity", "1", "仪表用加速度强度（0…1）"), RoadlogColumn("rotation_intensity", "1", "仪表用转动强度（0…1）")],
        frame: "RideEngine 每秒推断状态", gapThresholdS: nil)

    static let all: [RoadlogStreamSpec] = [motion, accelRaw, gyroRaw, magRaw, batchedAccel, batchedMotion, altimeter, absAltitude, location, heading, acoustic, inferredIMUSpeed, inferredSignal]
    static func spec(_ name: String) -> RoadlogStreamSpec? { all.first { $0.name == name } }
}

enum RoadlogCSV {
    /// Missing values stay empty, never 0. Plain decimal, no locale.
    static func row(_ values: [Double?], columns: [RoadlogColumn]) -> String {
        var out = ""
        out.reserveCapacity(values.count * 10)
        for (i, value) in values.enumerated() {
            if i > 0 { out.append(",") }
            guard let value, value.isFinite else { continue }
            if i == 0 { out.append(String(format: "%.6f", value)) }
            else if i < columns.count, columns[i].integer { out.append(String(Int(value.rounded()))) }
            else if columns[i].name == "t_unix" { out.append(String(format: "%.6f", value)) }
            else if columns[i].name == "lat" || columns[i].name == "lon" { out.append(String(format: "%.8f", value)) }
            else { out.append(compact(value)) }
        }
        out.append("\n")
        return out
    }
    /// Up to 7 significant digits; enough for sensor resolution, shorter than %g's exponent form for small values.
    static func compact(_ v: Double) -> String {
        if v == 0 { return "0" }
        let s = String(format: "%.7g", v)
        guard s.contains("e") else { return s }
        return String(format: "%.9f", v).replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
    }
}

enum RoadlogGzip {
    enum Failure: Error { case zlib(Int32) }
    /// A complete gzip member (RFC 1952) readable by Python's gzip module.
    static func compress(_ data: Data, level: Int32 = 6) throws -> Data {
        var stream = z_stream()
        var status = deflateInit2_(&stream, level, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard status == Z_OK else { throw Failure.zlib(status) }
        defer { deflateEnd(&stream) }
        var output = Data(count: Int(deflateBound(&stream, uLong(data.count))) + 64)
        let produced: Int = try data.withUnsafeBytes { (input: UnsafeRawBufferPointer) in
            try output.withUnsafeMutableBytes { (out: UnsafeMutableRawBufferPointer) in
                stream.next_in = UnsafeMutablePointer(mutating: input.bindMemory(to: Bytef.self).baseAddress)
                stream.avail_in = uInt(data.count)
                stream.next_out = out.bindMemory(to: Bytef.self).baseAddress
                stream.avail_out = uInt(out.count)
                status = deflate(&stream, Z_FINISH)
                guard status == Z_STREAM_END else { throw Failure.zlib(status) }
                return Int(stream.total_out)
            }
        }
        return output.prefix(produced)
    }
    static func decompress(_ data: Data) throws -> Data {
        var stream = z_stream()
        var status = inflateInit2_(&stream, 15 + 32, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard status == Z_OK else { throw Failure.zlib(status) }
        defer { inflateEnd(&stream) }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 256 * 1024)
        try data.withUnsafeBytes { (input: UnsafeRawBufferPointer) in
            stream.next_in = UnsafeMutablePointer(mutating: input.bindMemory(to: Bytef.self).baseAddress)
            stream.avail_in = uInt(data.count)
            repeat {
                let n: Int = buffer.withUnsafeMutableBufferPointer { out in
                    stream.next_out = out.baseAddress; stream.avail_out = uInt(out.count)
                    status = inflate(&stream, Z_NO_FLUSH)
                    return out.count - Int(stream.avail_out)
                }
                guard status == Z_OK || status == Z_STREAM_END else { throw Failure.zlib(status) }
                result.append(contentsOf: buffer[0..<n])
            } while status != Z_STREAM_END
        }
        return result
    }
}

/// Wall-clock ↔ monotonic mapping sample (clock.jsonl). Wall-clock Dates (CLLocation, CLHeading) are converted with the latest one.
struct RoadlogClockMapping: Codable, Equatable, Sendable {
    var mono: Double; var unix: Double
    static func now() -> RoadlogClockMapping {
        let mono = ProcessInfo.processInfo.systemUptime, unix = Date().timeIntervalSince1970
        return .init(mono: mono, unix: unix)
    }
    func mono(forUnix value: Double) -> Double { mono + (value - unix) }
    func unix(forMono value: Double) -> Double { unix + (value - mono) }
}
