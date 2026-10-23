import Foundation
import simd

/// Replay file (same layout as the de-identified real-ride export: gps / motion / acoustic column arrays, t = seconds
/// since start) merged into one time-ordered stream for VehicleStateEstimator. Used by unit tests (synthetic replay in
/// the bundle; a real fixture only via MOTUO_REPLAY_FIXTURE, never copied into the repo) and by DEMO rides, which loop
/// the bundled synthetic replay (explicitly simulated).
struct VehicleReplay {
    enum Sample {
        case motion(t: Double, ua: SIMD3<Double>, gravity: SIMD3<Double>, rot: SIMD3<Double>)
        case gps(t: Double, speed: Double?, accuracy: Double, horizontal: Double)
        case acoustic(t: Double, rms: Double)
        var t: Double { switch self { case let .motion(t, _, _, _), let .gps(t, _, _, _), let .acoustic(t, _): t } }
        var rank: Int { switch self { case .gps: 0; case .acoustic: 1; case .motion: 2 } }
    }
    let samples: [Sample]
    let duration: Double
    let synthetic: Bool
    /// GPS speed samples (t, m/s) — the DEMO ride's 1 Hz speed readings.
    let gpsSpeeds: [(t: Double, speed: Double)]

    init(data: Data) throws {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw APIClientError(message: "回放文件不是 JSON 对象") }
        func column(_ object: [String: Any]?, _ key: String) -> [Double?] { (object?[key] as? [Any])?.map { ($0 as? NSNumber)?.doubleValue } ?? [] }
        var out: [Sample] = []
        let m = root["motion"] as? [String: Any]
        let mt = column(m, "t"), cols = ["user_acc_x", "user_acc_y", "user_acc_z", "gravity_x", "gravity_y", "gravity_z", "rot_x", "rot_y", "rot_z"].map { column(m, $0) }
        out.reserveCapacity(mt.count + 4000)
        for i in mt.indices {
            guard let t = mt[i], cols.allSatisfy({ i < $0.count && $0[i] != nil }) else { continue }
            let v = cols.map { $0[i]! }
            out.append(.motion(t: t, ua: SIMD3(v[0], v[1], v[2]), gravity: SIMD3(v[3], v[4], v[5]), rot: SIMD3(v[6], v[7], v[8])))
        }
        let g = root["gps"] as? [String: Any]
        let gt = column(g, "t"), gv = column(g, "speed_mps"), ga = column(g, "speed_acc_mps"), gh = column(g, "h_acc_m")
        var speeds: [(Double, Double)] = []
        for i in gt.indices {
            guard let t = gt[i] else { continue }
            let speed = i < gv.count ? gv[i] : nil
            out.append(.gps(t: t, speed: speed, accuracy: (i < ga.count ? ga[i] : nil) ?? 0.5, horizontal: (i < gh.count ? gh[i] : nil) ?? 5))
            if let speed { speeds.append((t, speed)) }
        }
        let a = root["acoustic"] as? [String: Any]
        let at = column(a, "t"), ar = column(a, "rms_dbfs")
        for i in at.indices { if let t = at[i], i < ar.count, let r = ar[i] { out.append(.acoustic(t: t, rms: r)) } }
        out.sort { $0.t != $1.t ? $0.t < $1.t : $0.rank < $1.rank }
        samples = out
        duration = (root["durationS"] as? NSNumber)?.doubleValue ?? out.last?.t ?? 0
        synthetic = root["synthetic"] as? Bool ?? false
        gpsSpeeds = speeds
    }

    static func feed(_ sample: Sample, into estimator: inout VehicleStateEstimator, offset: Double = 0) {
        switch sample {
        case let .motion(t, ua, gravity, rot): estimator.motion(t: t + offset, userAcceleration: ua, gravity: gravity, rotation: rot)
        case let .gps(t, speed, accuracy, horizontal): estimator.gps(t: t + offset, speed: speed, accuracy: accuracy, horizontalAccuracy: horizontal)
        case let .acoustic(t, rms): estimator.acoustic(t: t + offset, rmsDbfs: rms)
        }
    }

    /// The bundled synthetic replay (fixtures/vehicle-state/synthetic-ride.json), parsed once.
    static let bundledSynthetic: VehicleReplay? = {
        guard let url = Bundle.main.url(forResource: "synthetic-ride", withExtension: "json"), let data = try? Data(contentsOf: url) else { return nil }
        return try? VehicleReplay(data: data)
    }()
}

/// Plays a replay in (looped) replay time: each `advance(to:)` feeds every sample up to that time. Loop k is offset by
/// k × duration so the estimator always sees monotonic time.
struct VehicleReplayCursor {
    let replay: VehicleReplay
    private(set) var index = 0, loop = 0
    init(_ replay: VehicleReplay) { self.replay = replay }
    var offset: Double { Double(loop) * replay.duration }
    mutating func advance(to t: Double, estimator: inout VehicleStateEstimator) {
        guard replay.duration > 0, !replay.samples.isEmpty else { return }
        while true {
            if index >= replay.samples.count { index = 0; loop += 1 }
            let s = replay.samples[index]
            guard s.t + offset <= t else { return }
            VehicleReplay.feed(s, into: &estimator, offset: offset); index += 1
        }
    }
    /// Latest replay GPS speed at or before t (looped), for the DEMO ride's 1 Hz readings.
    func speed(at t: Double) -> Double? {
        guard replay.duration > 0 else { return nil }
        let local = t.truncatingRemainder(dividingBy: replay.duration)
        var lo = 0, hi = replay.gpsSpeeds.count - 1, best: (t: Double, speed: Double)?
        while lo <= hi { let mid = (lo + hi) / 2; if replay.gpsSpeeds[mid].t <= local { best = replay.gpsSpeeds[mid]; lo = mid + 1 } else { hi = mid - 1 } }
        // Inside the replay's GPS outage the DEMO keeps showing the last reading (like the real cockpit's short inertial
        // bridge, the number stays readable); the estimator itself still sees the outage and falls back to IMU only.
        return best?.speed ?? replay.gpsSpeeds.first?.speed
    }
}
