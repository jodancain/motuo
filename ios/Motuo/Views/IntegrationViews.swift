import SwiftUI
import MusicKit

struct MusicLibraryView:View {
    @Environment(\.dismiss) private var dismiss
    @State private var query=""
    private var music:MusicService { .shared }
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:22) {
                    PageTitle(eyebrow:"RIDE SOUNDTRACK",title:"给这一程配乐",subtitle:"Apple Music 曲库与个人歌单。")
                    Panel {
                        VStack(spacing:18) {
                            HStack(spacing:18) { Image(systemName:"music.note").font(.system(size:36,weight:.light)).foregroundStyle(Cyber.accent).frame(width:65,height:65).background(Cyber.accent.opacity(0.07),in:RoundedRectangle(cornerRadius:16)); VStack(alignment:.leading,spacing:7) { Text(music.currentTitle).font(.system(size:18,weight:.semibold)); Text(music.currentArtist).font(.system(size:12)).foregroundStyle(Cyber.muted) };Spacer() }
                            HStack(spacing:40) { Button { Task { await music.skipPrevious() } } label:{ Image(systemName:"backward.end.fill") }; Button { Task { await music.togglePlayback() } } label:{ Image(systemName:music.isPlaying ? "pause.fill":"play.fill").font(.system(size:22)).frame(width:55,height:55).background(Cyber.accent,in:Circle()).foregroundStyle(Cyber.ink) }; Button { Task { await music.skipNext() } } label:{ Image(systemName:"forward.end.fill") } }.font(.system(size:20)).foregroundStyle(.white)
                            Text(music.statusMessage).font(.system(size:11)).foregroundStyle(Cyber.muted).multilineTextAlignment(.center)
                        }.frame(maxWidth:.infinity)
                    }
                    if music.state == "unauthorized" || music.state == "denied" { ActionButton(title:"连接 Apple Music",symbol:"music.note") { Task { await music.authorize() } } }
                    HStack { Image(systemName:"magnifyingglass").foregroundStyle(Cyber.muted);TextField("歌曲、歌手",text:$query).submitLabel(.search).onSubmit { Task { await music.search(query) } };Button("搜索") { Task { await music.search(query) } } }.padding(15).background(Cyber.panel,in:RoundedRectangle(cornerRadius:14))
                    if !music.songs.isEmpty {
                        Eyebrow(text:"SEARCH RESULTS")
                        ForEach(music.songs) { song in Button { Task { await music.play(song) } } label:{ HStack(spacing:12) { if let artwork=song.artwork { ArtworkImage(artwork,width:44,height:44).clipShape(RoundedRectangle(cornerRadius:8)) } else { Image(systemName:"music.note").frame(width:44,height:44).background(Cyber.panel,in:RoundedRectangle(cornerRadius:8)) };VStack(alignment:.leading,spacing:5) { Text(song.title).font(.system(size:14,weight:.medium)).foregroundStyle(.white);Text(song.artistName).font(.system(size:11)).foregroundStyle(Cyber.muted) };Spacer();Image(systemName:"play.circle").foregroundStyle(Cyber.accent) }.padding(.vertical,4) }.buttonStyle(.plain) }
                    }
                    if !music.playlists.isEmpty { Eyebrow(text:"YOUR PLAYLISTS");ForEach(music.playlists) { playlist in Button { Task { await music.playPlaylist(playlist) } } label:{ HStack { Image(systemName:"music.note.list").foregroundStyle(Cyber.accent);Text(playlist.name).foregroundStyle(.white);Spacer();Image(systemName:"play.fill").font(.system(size:12)) }.padding(16).background(Cyber.panel,in:RoundedRectangle(cornerRadius:14)) } } }
                    Panel { VStack(alignment:.leading,spacing:8) { Text("其他音乐平台").font(.system(size:14,weight:.semibold));Text("网易云 / QQ 音乐可在原 App 播放。此版本不读取或控制它们的播放内容。").font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(4) } }
                }.padding(24).frame(maxWidth:760)
            }.background(Cyber.ink).navigationTitle("音乐").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement:.topBarTrailing) { Button("完成") { dismiss() } } }
        }
    }
}

struct NavigationSearchView:View {
    @Environment(\.dismiss) private var dismiss
    @State private var query=""
    private var navigation:NavigationService { .shared }
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:22) {
                    PageTitle(eyebrow:"NEXT DESTINATION",title:"把路交给旅程",subtitle:"选择地点，在高德中确认摩托路线。")
                    HStack { Image(systemName:"magnifyingglass").foregroundStyle(Cyber.cyan);TextField("搜索地点或地址",text:$query).submitLabel(.search).onSubmit { Task { await navigation.search(query) } };Button("搜索") { Task { await navigation.search(query) } } }.padding(16).background(Cyber.panel,in:RoundedRectangle(cornerRadius:16))
                    Text(navigation.statusMessage).font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(5)
                    ForEach(navigation.results) { place in
                        Button { navigation.openDirections(latitude:place.latitude,longitude:place.longitude,name:place.name) } label:{ Panel { HStack(alignment:.top,spacing:14) { Image(systemName:"mappin.circle.fill").font(.system(size:24)).foregroundStyle(Cyber.cyan);VStack(alignment:.leading,spacing:7) { Text(place.name).font(.system(size:16,weight:.semibold)).foregroundStyle(.white);Text(place.subtitle).font(.system(size:11)).foregroundStyle(Cyber.muted).lineLimit(3) };Spacer();Image(systemName:"arrow.up.right").foregroundStyle(Cyber.accent) } } }.buttonStyle(.plain)
                    }
                    if navigation.results.isEmpty { EmptyState(symbol:"point.topleft.down.to.point.bottomright.curvepath",title:"寻找下一站",detail:"内嵌摩托导航仍需服务商授权。\n外部导航期间，已开启的骑行可继续后台定位记录。") }
                }.padding(24).frame(maxWidth:760)
            }.background(Cyber.ink).navigationTitle("导航").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement:.topBarTrailing) { Button("完成") { dismiss() } } }
        }
    }
}
