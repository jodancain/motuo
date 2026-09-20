import Foundation
import MusicKit
import AVFoundation
import Observation

@MainActor @Observable final class MusicService {
    static let shared = MusicService()
    private(set) var state = "unauthorized"
    private(set) var statusMessage = "连接 Apple Music，让骑行有自己的配乐"
    private(set) var currentTitle = "你的骑行配乐"
    private(set) var currentArtist = "Apple Music"
    private(set) var isPlaying = false
    private(set) var songs: [Song] = []
    private(set) var playlists: [Playlist] = []
    private(set) var canPlay = false
    @ObservationIgnored private var monitor: Task<Void, Never>?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var searchGeneration = 0
    init() {
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { notification in
            let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                Task { @MainActor in ApplicationMusicPlayer.shared.pause(); MusicService.shared.statusMessage = "耳机已断开，音乐已暂停"; MusicService.shared.refreshPlayback() }
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { notification in
            let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if type == AVAudioSession.InterruptionType.began.rawValue {
                Task { @MainActor in MusicService.shared.statusMessage = "音频被系统中断"; MusicService.shared.refreshPlayback() }
            }
        })
    }
    func authorize() async {
        let result = await MusicAuthorization.request()
        guard result == .authorized else { state = "denied"; statusMessage = "尚未获得 Apple Music 授权，可在系统设置中开启"; return }
        state = "authorized"
        do {
            let subscription = try await MusicSubscription.current
            canPlay = subscription.canPlayCatalogContent
            statusMessage = canPlay ? "Apple Music 已就绪" : "曲库播放需要有效的 Apple Music 订阅"
            var request = MusicLibraryRequest<Playlist>(); request.limit = 50
            playlists = Array(try await request.response().items)
        } catch { statusMessage = "已授权，曲库暂不可用：\(error.localizedDescription)" }
        startMonitoring()
    }
    func search(_ query: String) async {
        searchGeneration += 1; let generation = searchGeneration
        guard MusicAuthorization.currentStatus == .authorized else { statusMessage = "请先连接 Apple Music"; return }
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { songs = []; return }
        state = "searching"
        do {
            var request = MusicCatalogSearchRequest(term: term, types: [Song.self]); request.limit = 25
            let response = try await request.response()
            guard generation == searchGeneration else { return }
            songs = Array(response.songs); state = "authorized"
            statusMessage = songs.isEmpty ? "没有找到匹配歌曲" : "找到 \(songs.count) 首歌曲"
        } catch { if generation == searchGeneration { state = "error"; statusMessage = error.localizedDescription } }
    }
    func play(_ song: Song) async {
        guard canPlay else { statusMessage = "当前账号不可播放曲库内容"; return }
        do {
            try configureAudio()
            ApplicationMusicPlayer.shared.queue = ApplicationMusicPlayer.Queue(for: [song])
            try await ApplicationMusicPlayer.shared.play()
            currentTitle = song.title; currentArtist = song.artistName
            startMonitoring(); refreshPlayback()
        } catch { state = "error"; statusMessage = "播放失败：\(error.localizedDescription)" }
    }
    func playPlaylist(_ playlist: Playlist) async {
        guard canPlay else { statusMessage = "当前账号不可播放曲库内容"; return }
        do {
            let detailed = try await playlist.with([.tracks])
            guard let tracks = detailed.tracks, !tracks.isEmpty else { statusMessage = "这个歌单暂无可播放歌曲"; return }
            try configureAudio()
            ApplicationMusicPlayer.shared.queue = ApplicationMusicPlayer.Queue(for: tracks)
            try await ApplicationMusicPlayer.shared.play(); startMonitoring(); refreshPlayback()
        } catch { statusMessage = "歌单播放失败：\(error.localizedDescription)" }
    }
    func togglePlayback() async {
        let player = ApplicationMusicPlayer.shared
        if player.state.playbackStatus == .playing { player.pause(); refreshPlayback(); return }
        guard MusicAuthorization.currentStatus == .authorized else { await authorize(); return }
        do { try configureAudio(); try await player.play(); startMonitoring(); refreshPlayback() }
        catch { statusMessage = "请先选择歌曲或歌单" }
    }
    func skipNext() async { do { try await ApplicationMusicPlayer.shared.skipToNextEntry(); refreshPlayback() } catch { statusMessage = "已经是最后一首" } }
    func skipPrevious() async { do { try await ApplicationMusicPlayer.shared.skipToPreviousEntry(); refreshPlayback() } catch { statusMessage = "已经是第一首" } }
    private func configureAudio() throws {
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
        try AVAudioSession.sharedInstance().setActive(true)
    }
    private func refreshPlayback() {
        let player = ApplicationMusicPlayer.shared
        isPlaying = player.state.playbackStatus == .playing
        if let entry = player.queue.currentEntry { currentTitle = entry.title; currentArtist = entry.subtitle ?? "Apple Music" }
        if isPlaying { state = "playing"; statusMessage = "正在播放" }
        else if state == "playing" { state = "paused"; statusMessage = "已暂停" }
    }
    private func startMonitoring() {
        guard monitor == nil else { return }
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                self?.refreshPlayback()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}
