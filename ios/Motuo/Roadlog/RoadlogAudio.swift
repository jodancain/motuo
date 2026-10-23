import Foundation
import AVFoundation
import Accelerate

/// Bridges EngineSoundService's existing microphone tap to the roadlog. The microphone itself is still only started by
/// the user in the cockpit (existing permission/indicator rules); the roadlog never opens it.
final class RoadlogAudioTap: @unchecked Sendable {
    static let shared = RoadlogAudioTap()
    private let lock = NSLock()
    private var processor: RoadlogAudioProcessor?
    func attach(_ value: RoadlogAudioProcessor) { lock.lock(); processor = value; lock.unlock() }
    func detach() { lock.lock(); let old = processor; processor = nil; lock.unlock(); old?.inputStopped() }
    /// Called on the audio render thread: copies the samples and returns immediately.
    func deliver(_ buffer: AVAudioPCMBuffer, uptime: Double) {
        lock.lock(); let target = processor; lock.unlock()
        guard let target, let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        let samples = Array(UnsafeBufferPointer(start: data, count: Int(buffer.frameLength)))
        target.receive(samples, sampleRate: buffer.format.sampleRate, endUptime: uptime)
    }
    func inputStopped() { lock.lock(); let target = processor; lock.unlock(); target?.inputStopped() }
}

/// Acoustic features (20–50 Hz frames) and, only when the separate switch is on, AAC mono segments.
final class RoadlogAudioProcessor: @unchecked Sendable {
    static let frameSize = 1024
    static let segmentS = 300.0
    private let writer: RoadlogPackageWriter
    private let queue = DispatchQueue(label: "cn.yundongyl.motuo.roadlog.audio", qos: .utility)
    private let lock = NSLock()
    private var _rawEnabled: Bool
    private var _live = false
    private var setup: FFTSetup?
    private let window: [Float]
    private var file: AVAudioFile?
    private var converter: AVAudioConverter?
    private var segment = 0
    private var segmentStart = 0.0
    private var segmentEnd = 0.0
    private var inputRate = 0.0
    private let lowFrequency = LowFrequencySpectrum()
    var rawEnabled: Bool { lock.lock(); defer { lock.unlock() }; return _rawEnabled }
    var microphoneLive: Bool { lock.lock(); defer { lock.unlock() }; return _live }

    init(writer: RoadlogPackageWriter, rawAudio: Bool) {
        self.writer = writer; _rawEnabled = rawAudio
        setup = vDSP_create_fftsetup(vDSP_Length(log2(Double(Self.frameSize))), FFTRadix(kFFTRadix2))
        var w = [Float](repeating: 0, count: Self.frameSize); vDSP_hann_window(&w, vDSP_Length(Self.frameSize), Int32(vDSP_HANN_DENORM)); window = w
    }
    deinit { if let setup { vDSP_destroy_fftsetup(setup) } }

    func receive(_ samples: [Float], sampleRate: Double, endUptime: Double) {
        queue.async { [self] in
            lock.lock(); let first = !_live; _live = true; let raw = _rawEnabled; lock.unlock()
            if first {
                writer.streamStatus("acoustic", "recorded", reason: nil, t: endUptime)
                writer.log(.events, ["type": "microphone_on", "t_mono": endUptime, "sampleRate": sampleRate])
            }
            for frame in lowFrequency.push(samples, sampleRate: sampleRate, endUptime: endUptime) { writer.append("acoustic_lf", [frame.t] + frame.db.map { Optional($0) }) }
            // Split into 1024-sample frames (≈47 Hz at 48 kHz) regardless of the tap's buffer size.
            let count = samples.count / Self.frameSize
            for i in 0..<count {
                let frame = Array(samples[(i * Self.frameSize)..<((i + 1) * Self.frameSize)])
                let t = endUptime - Double(samples.count - (i + 1) * Self.frameSize) / sampleRate
                writer.append("acoustic", features(frame, sampleRate: sampleRate, t: t))
            }
            if raw { writeRaw(samples, sampleRate: sampleRate, endUptime: endUptime) }
        }
    }
    func inputStopped() {
        queue.async { [self] in
            lock.lock(); let was = _live; _live = false; lock.unlock()
            if was { writer.log(.events, ["type": "microphone_off"]) }
            closeSegment()
        }
    }
    func stopRaw(reason: String) {
        queue.async { [self] in
            lock.lock(); let was = _rawEnabled; _rawEnabled = false; lock.unlock()
            if was { writer.log(.events, ["type": "raw_audio_stopped", "reason": reason]); closeSegment() }
        }
    }
    func close() async { await withCheckedContinuation { continuation in queue.async { [self] in closeSegment(); continuation.resume() } } }

    /// RMS / peak (dBFS) and 16 log-spaced band energies (Hann window, Parseval-normalised; full-scale sine ≈ -3 dBFS).
    func features(_ frame: [Float], sampleRate: Double, t: Double) -> [Double?] {
        let n = frame.count
        var rms: Float = 0, peak: Float = 0
        vDSP_rmsqv(frame, 1, &rms, vDSP_Length(n)); vDSP_maxmgv(frame, 1, &peak, vDSP_Length(n))
        let db = { (v: Float) -> Double in max(-160, 20 * log10(Double(max(v, 1e-8)))) }
        var row: [Double?] = [t, db(rms), db(peak), peak > 0.98 ? 1 : 0]
        guard let setup, n == Self.frameSize else { return row + Array(repeating: nil, count: 16) }
        var windowed = [Float](repeating: 0, count: n); vDSP_vmul(frame, 1, window, 1, &windowed, 1, vDSP_Length(n))
        var real = [Float](repeating: 0, count: n / 2), imag = [Float](repeating: 0, count: n / 2)
        var power = [Float](repeating: 0, count: n / 2)
        real.withUnsafeMutableBufferPointer { r in imag.withUnsafeMutableBufferPointer { i in
            var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
            windowed.withUnsafeBufferPointer { src in
                src.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { vDSP_ctoz($0, 2, &split, 1, vDSP_Length(n / 2)) }
            }
            vDSP_fft_zrip(setup, &split, 1, vDSP_Length(log2(Double(n))), FFTDirection(FFT_FORWARD))
            split.imagp[0] = 0; split.realp[0] = 0        // drop DC (and the packed Nyquist term)
            vDSP_zvmags(&split, 1, &power, 1, vDSP_Length(n / 2))
        } }
        // zrip returns 2×DFT; one-sided energy relative to a full-scale signal with the Hann window's energy (n·3/8).
        let scale = 2.0 / (4.0 * Double(n) * Double(n) * 0.375)
        let edges = RoadlogStreams.acousticBandEdgesHz, binHz = sampleRate / Double(n)
        for band in 0..<16 {
            row.append(Self.bandEnergy(power, lo: edges[band], hi: edges[band + 1], binHz: binHz, nyquist: sampleRate / 2).map { max(-160, 10 * log10(max($0 * scale, 1e-16))) })
        }
        return row
    }
    /// Band energy (raw FFT power units). Bands narrower than two bins (band_00…band_04 at 46.9 Hz bins; band_01 was
    /// always empty in schema 1.0) take the power interpolated at the band's geometric centre times its width in bins.
    static func bandEnergy(_ power: [Float], lo: Double, hi: Double, binHz: Double, nyquist: Double) -> Double? {
        guard lo < nyquist, binHz > 0, power.count > 2 else { return nil }
        let first = Int((lo / binHz).rounded(.up)), last = min(power.count - 1, Int((hi / binHz).rounded(.down)))
        if (hi - lo) / binHz >= 2, first >= 1, first <= last { var sum = 0.0; for k in first...last { sum += Double(power[k]) }; return sum }
        let x = min(Double(power.count - 1), max(1, sqrt(lo * hi) / binHz)), k = Int(x.rounded(.down)), f = x - Double(k)
        let p = Double(power[k]) * (1 - f) + Double(power[min(power.count - 1, k + 1)]) * f
        return p * (hi - lo) / binHz
    }

    private func writeRaw(_ samples: [Float], sampleRate: Double, endUptime: Double) {
        do {
            if file == nil || inputRate != sampleRate || endUptime - segmentStart >= Self.segmentS { closeSegment(); try openSegment(sampleRate: sampleRate, start: endUptime - Double(samples.count) / sampleRate) }
            guard let file, let converter,
                  let input = AVAudioPCMBuffer(pcmFormat: converter.inputFormat, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
            input.frameLength = AVAudioFrameCount(samples.count)
            samples.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
            let capacity = AVAudioFrameCount(Double(samples.count) * converter.outputFormat.sampleRate / sampleRate) + 32
            guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return }
            var consumed = false, error: NSError?
            converter.convert(to: output, error: &error) { _, status in
                if consumed { status.pointee = .noDataNow; return nil }
                consumed = true; status.pointee = .haveData; return input
            }
            if let error { throw error }
            if output.frameLength > 0 { try file.write(from: output) }
            segmentEnd = endUptime
        } catch {
            writer.log(.events, ["type": "raw_audio_error", "message": error.localizedDescription]); closeSegment()
            lock.lock(); _rawEnabled = false; lock.unlock()
        }
    }
    private func openSegment(sampleRate: Double, start: Double) throws {
        segment += 1; inputRate = sampleRate; segmentStart = start; segmentEnd = start
        let folder = writer.directory.appendingPathComponent("audio", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(String(format: "%04d.m4a", segment))
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000]
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        guard let inputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inputFormat, to: file.processingFormat) else { throw RoadlogError.write("音频格式转换不可用") }
        self.file = file; self.converter = converter
        writer.log(.events, ["type": "raw_audio_segment", "seq": segment, "file": "audio/" + url.lastPathComponent, "t_mono": start])
    }
    private func closeSegment() {
        guard file != nil else { return }
        file?.close(); file = nil; converter = nil   // finalises the m4a container (moov atom)
        writer.audioSegment(seq: segment, file: String(format: "audio/%04d.m4a", segment), tStart: segmentStart, tEnd: segmentEnd)
    }
}

/// 20–500 Hz fine spectrum (≈3.9 Hz resolution) for later engine-order work; collected and shown as the "声浪", never as RPM.
/// Decimates to ≈4 kHz with a boxcar (its first null at 4 kHz suppresses the aliases that would land in 20–500 Hz), then a
/// 1024-point Hann FFT every 1024 decimated samples (≈0.26 s, ≈4 frames/s). Cost: one small FFT per quarter second.
final class LowFrequencySpectrum: @unchecked Sendable {
    static let fftSize = 1024
    struct Frame { var t: Double; var db: [Double] }
    private let setup: FFTSetup?
    private let window: [Float]
    private var buffer: [Float] = [], acc: Float = 0, accCount = 0, factor = 12, rate = 0.0
    private let grid = RoadlogStreams.acousticLFHz
    init() {
        setup = vDSP_create_fftsetup(vDSP_Length(log2(Double(Self.fftSize))), FFTRadix(kFFTRadix2))
        var w = [Float](repeating: 0, count: Self.fftSize); vDSP_hann_window(&w, vDSP_Length(Self.fftSize), Int32(vDSP_HANN_DENORM)); window = w
        buffer.reserveCapacity(Self.fftSize)
    }
    deinit { if let setup { vDSP_destroy_fftsetup(setup) } }
    /// Returns the frames completed by these samples; `endUptime` is the time of the last sample.
    func push(_ samples: [Float], sampleRate: Double, endUptime: Double) -> [Frame] {
        guard sampleRate > 1000, let setup else { return [] }
        if sampleRate != rate { rate = sampleRate; factor = max(1, Int((sampleRate / 4000).rounded())); buffer.removeAll(keepingCapacity: true); acc = 0; accCount = 0 }
        var out: [Frame] = []
        let fs = sampleRate / Double(factor)
        for (i, x) in samples.enumerated() {
            acc += x; accCount += 1
            guard accCount == factor else { continue }
            buffer.append(acc / Float(factor)); acc = 0; accCount = 0
            guard buffer.count == Self.fftSize else { continue }
            let t = endUptime - Double(samples.count - 1 - i) / sampleRate
            out.append(Frame(t: t, db: spectrum(buffer, fs: fs, setup: setup)))
            buffer.removeAll(keepingCapacity: true)
        }
        return out
    }
    private func spectrum(_ x: [Float], fs: Double, setup: FFTSetup) -> [Double] {
        let n = x.count
        var windowed = [Float](repeating: 0, count: n); vDSP_vmul(x, 1, window, 1, &windowed, 1, vDSP_Length(n))
        var real = [Float](repeating: 0, count: n / 2), imag = [Float](repeating: 0, count: n / 2), power = [Float](repeating: 0, count: n / 2)
        real.withUnsafeMutableBufferPointer { r in imag.withUnsafeMutableBufferPointer { im in
            var split = DSPSplitComplex(realp: r.baseAddress!, imagp: im.baseAddress!)
            windowed.withUnsafeBufferPointer { src in src.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) { vDSP_ctoz($0, 2, &split, 1, vDSP_Length(n / 2)) } }
            vDSP_fft_zrip(setup, &split, 1, vDSP_Length(log2(Double(n))), FFTDirection(FFT_FORWARD))
            split.imagp[0] = 0; split.realp[0] = 0
            vDSP_zvmags(&split, 1, &power, 1, vDSP_Length(n / 2))
        } }
        // One-sided PSD relative to full scale (dBFS/Hz): zrip's 2× scaling and the Hann window energy (n·3/8).
        let binHz = fs / Double(n), scale = 2.0 / (4.0 * Double(n) * Double(n) * 0.375) / binHz
        return grid.map { f in
            let x = min(Double(n / 2 - 1), max(0, f / binHz)), k = Int(x.rounded(.down)), w = x - Double(k)
            let p = Double(power[k]) * (1 - w) + Double(power[min(n / 2 - 1, k + 1)]) * w
            return (max(-160, 10 * log10(max(p * scale, 1e-16))) * 10).rounded() / 10
        }
    }
}
