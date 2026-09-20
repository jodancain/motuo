import Foundation
import MapKit
import UIKit
import Observation
import AVFoundation

struct APINavigationPlace: Identifiable {
    let id: String
    let name: String
    let subtitle: String
    let latitude: Double
    let longitude: Double
}
struct APINavigationInstruction: Codable {
    let maneuver: String
    let distanceM: Double
    let remainingM: Double
    let remainingSeconds: Double
    let generatedAt: Date
}
@MainActor @Observable final class NavigationService: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = NavigationService()
    var query = ""
    private(set) var statusMessage = "摩托内嵌导航待高德授权；可打开高德选择摩托路线"
    private(set) var results: [APINavigationPlace] = []
    private(set) var embeddedAvailable = false
    private(set) var destinationName: String?
    private(set) var instruction: APINavigationInstruction?
    @ObservationIgnored private var searchTask: MKLocalSearch?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let speech = AVSpeechSynthesizer()
    override init() { super.init(); speech.delegate = self }
    func clear() {
        generation += 1; searchTask?.cancel(); searchTask = nil; query = ""; results = []; destinationName = nil; instruction = nil
        speech.stopSpeaking(at: .immediate); statusMessage = "摩托内嵌导航待高德授权；可打开高德选择摩托路线"
    }
    func search(_ query: String) async {
        self.query = query; generation += 1; let current = generation
        searchTask?.cancel()
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { results = []; return }
        let request = MKLocalSearch.Request(); request.naturalLanguageQuery = query
        let search = MKLocalSearch(request: request); searchTask = search
        do {
            let response = try await search.start()
            guard current == generation else { return }
            results = response.mapItems.enumerated().map { index, item in
                APINavigationPlace(id: "\(index)-\(item.placemark.coordinate.latitude)", name: item.name ?? "目的地", subtitle: item.placemark.title ?? "", latitude: item.placemark.coordinate.latitude, longitude: item.placemark.coordinate.longitude)
            }
            statusMessage = "选地点后打开高德，并在高德确认摩托路线"
        } catch { if current == generation { statusMessage = "地点搜索暂不可用：\(error.localizedDescription)" } }
    }
    func openDirections(latitude: Double, longitude: Double, name: String) {
        guard latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude), (-180...180).contains(longitude) else { statusMessage = "目的地坐标无效"; return }
        // Documented marker URI deliberately does not choose a car/bicycle route.
        // The user selects motorcycle routing in AMap; external instructions cannot be read back.
        var components = URLComponents(string: "https://uri.amap.com/marker")!
        components.queryItems = [URLQueryItem(name:"position",value:"\(longitude),\(latitude)"),URLQueryItem(name:"name",value:name),URLQueryItem(name:"src",value:"motuo"),URLQueryItem(name:"coordinate",value:"wgs84"),URLQueryItem(name:"callnative",value:"1")]
        guard let url = components.url else { return }
        destinationName = name; instruction = nil
        UIApplication.shared.open(url) { success in Task { @MainActor in
            self.statusMessage = success ? "已打开高德；请在高德选择摩托路线。HUD 不读取外部导航指令。" : "无法打开高德，请检查安装与网络"
        } }
    }
    /// Only an authorized embedded provider may supply real instructions.
    func acceptEmbeddedInstruction(_ value: APINavigationInstruction) {
        guard embeddedAvailable, abs(value.generatedAt.timeIntervalSinceNow) < 15 else { return }
        instruction = value
    }
    func speak(_ text: String) {
        guard embeddedAvailable, !text.isEmpty else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            let utterance = AVSpeechUtterance(string:text); utterance.voice = AVSpeechSynthesisVoice(language:"zh-CN"); speech.speak(utterance)
        } catch { statusMessage = "语音播报不可用" }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            try? AVAudioSession.sharedInstance().setActive(false, options:.notifyOthersOnDeactivation)
            if MusicService.shared.isPlaying { try? AVAudioSession.sharedInstance().setCategory(.playback); try? AVAudioSession.sharedInstance().setActive(true) }
        }
    }
}
