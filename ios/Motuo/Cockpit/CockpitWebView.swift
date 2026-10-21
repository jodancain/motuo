import SwiftUI
import WebKit

/// The bundle serves rendering code only. Recording and credentials never enter WebKit.
final class CockpitAssetHandler: NSObject, WKURLSchemeHandler {
    static func resource(_ url: URL, root: URL) -> URL? {
        guard url.scheme == "motuo", url.host == "bundle" else { return nil }
        let path = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).standardizedFileURL.resolvingSymlinksInPath()
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        guard file.path.hasPrefix(base), ["html","js","css","glb","png","jpg","svg","txt","woff2"].contains(file.pathExtension) else { return nil }
        return file
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let root=Bundle.main.url(forResource:"Cockpit",withExtension:nil), let url=urlSchemeTask.request.url,
              let file=Self.resource(url,root:root), let data=try? Data(contentsOf:file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let types=["html":"text/html","js":"text/javascript","css":"text/css","glb":"model/gltf-binary","png":"image/png","jpg":"image/jpeg","svg":"image/svg+xml","txt":"text/plain","woff2":"font/woff2"]
        let response=HTTPURLResponse(url:url,statusCode:200,httpVersion:"HTTP/1.1",headerFields:["Content-Type":types[file.pathExtension] ?? "application/octet-stream","Content-Length":String(data.count),"Access-Control-Allow-Origin":"*","Cache-Control":"no-cache"] )!
        urlSchemeTask.didReceive(response);urlSchemeTask.didReceive(data);urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { }
}

/// Which reviewed web cockpit was bundled (scripts/prepare-native-cockpit.py writes Cockpit/cockpit-manifest.json).
enum CockpitBundle {
    static let variant: String = {
        guard let url=Bundle.main.url(forResource:"Cockpit",withExtension:nil)?.appendingPathComponent("cockpit-manifest.json"),
              let data=try? Data(contentsOf:url),let json=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
              let value=json["variant"] as? String,["v2","v3"].contains(value) else{return "v2"}
        return value
    }()
    static var isV3:Bool{variant=="v3"}
}

/// A validated message from the web layer. Only allowlisted actions, and only the payload keys each one may carry.
struct CockpitCommand:Equatable {
    // Every action either web cockpit can send (v3 native-adapter.js NATIVE_ACTIONS ∪ v2 native-runtime.js).
    // Tests scan the bundled web sources and fail if any posted action is missing here.
    static let commands:Set<String>=["ready","primary","finish","demoStart","countdown","countdownCancel","microphone","stopMicrophone","musicToggle","musicNext","musicPrevious","musicLibrary","garage","history","settings","navigation","appearance","share","wrappedShown","rideDetail","wrappedDone"]
    var action:String
    var paint:String?=nil, finish:String?=nil, world:String?=nil
    var image:Data?=nil
    static let paints:Set<String>=["panda","stealth","glacier","ember","violet"]
    static let finishes:Set<String>=["gloss","satin"]
    static let worlds:Set<String>=["neon","sunset","snow","cosmic"]
    static let maxImageBytes=16*1024*1024
    static func parse(_ body:Any)->CockpitCommand?{
        guard let body=body as? [String:Any],let action=body["action"] as? String,commands.contains(action) else{return nil}
        let allowed:Set<String>
        switch action{case "appearance":allowed=["action","paint","finish","world"];case "share":allowed=["action","png"];default:allowed=["action"]}
        guard Set(body.keys).isSubset(of:allowed) else{return nil}
        var command=CockpitCommand(action:action)
        if action=="appearance"{
            command.paint=(body["paint"] as? String).flatMap{paints.contains($0) ? $0:nil}
            command.finish=(body["finish"] as? String).flatMap{finishes.contains($0) ? $0:nil}
            command.world=(body["world"] as? String).flatMap{worlds.contains($0) ? $0:nil}
            guard command.paint != nil || command.finish != nil || command.world != nil else{return nil}
        }
        if action=="share"{
            // The comic page arrives as a PNG data URL; it is decoded here and only ever handed to the system share sheet.
            let prefix="data:image/png;base64,"
            guard let url=body["png"] as? String,url.hasPrefix(prefix),url.utf8.count<=maxImageBytes*4/3+prefix.count+4,
                  let data=Data(base64Encoded:String(url.dropFirst(prefix.count))),data.count<=maxImageBytes,
                  data.starts(with:[0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]) else{return nil}
            command.image=data
        }
        return command
    }
}

struct CockpitWebView: UIViewRepresentable {
    var snapshot: String
    var isActive: Bool = true
    var onCommand: (CockpitCommand)->Void
    var onError: (String?)->Void
    func makeCoordinator()->Coordinator { Coordinator(onCommand:onCommand,onError:onError) }
    func makeUIView(context:Context)->WKWebView {
        let configuration=WKWebViewConfiguration()
        configuration.setURLSchemeHandler(CockpitAssetHandler(),forURLScheme:"motuo")
        configuration.userContentController.add(context.coordinator,name:"motuo")
        configuration.defaultWebpagePreferences.allowsContentJavaScript=true
        let view=WKWebView(frame:.zero,configuration:configuration)
        // Same ink as the launch screen and the page, so cold start → first cockpit frame never flashes white.
        let ink=UIColor(red:0x0B/255,green:0x0A/255,blue:0x12/255,alpha:1)
        view.isOpaque=false;view.backgroundColor=ink;view.scrollView.backgroundColor=ink;view.underPageBackgroundColor=ink
        // The page lays itself out with viewport-fit=cover + env(safe-area-inset-*); WebKit passes the view's own safe area
        // (Dynamic Island / notch side, home indicator) through even though the scroll view does not inset its content.
        view.scrollView.isScrollEnabled=false;view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces=false;view.scrollView.pinchGestureRecognizer?.isEnabled=false
        view.navigationDelegate=context.coordinator;view.uiDelegate=context.coordinator
        view.accessibilityIdentifier="native.cockpit"
        context.coordinator.webView=view;context.coordinator.snapshot=snapshot
        view.load(URLRequest(url:URL(string:"motuo://bundle/index.html")!))
        return view
    }
    func updateUIView(_ view:WKWebView,context:Context) {
        context.coordinator.onCommand=onCommand;context.coordinator.onError=onError
        // Kept alive behind other tabs (no reload, no GLB re-parse); hidden from accessibility while not shown.
        view.accessibilityElementsHidden = !isActive
        context.coordinator.snapshot=snapshot;context.coordinator.push()
    }
    static func dismantleUIView(_ view:WKWebView,coordinator:Coordinator) {
        coordinator.ready=false;view.stopLoading();view.configuration.userContentController.removeScriptMessageHandler(forName:"motuo")
        view.navigationDelegate=nil;view.uiDelegate=nil;coordinator.webView=nil
    }
    @MainActor final class Coordinator:NSObject,WKScriptMessageHandler,WKNavigationDelegate,WKUIDelegate {
        weak var webView:WKWebView?
        var snapshot="{}",ready=false,inFlight=false
        var onCommand:(CockpitCommand)->Void
        var onError:(String?)->Void
        init(onCommand:@escaping(CockpitCommand)->Void,onError:@escaping(String?)->Void){self.onCommand=onCommand;self.onError=onError}
        static let commands=CockpitCommand.commands
        func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage){
            guard message.frameInfo.isMainFrame,message.frameInfo.securityOrigin.protocol == "motuo",message.frameInfo.securityOrigin.host == "bundle",
                  let command=CockpitCommand.parse(message.body) else{return}
            if command.action=="ready"{ready=true;onError(nil);push()}else{onCommand(command)}
        }
        func push(){
            guard ready,!inFlight,let webView else{return};inFlight=true
            // JSON is passed as a value, never interpolated from arbitrary text into code.
            let payload=snapshot
            Task{[weak self,weak webView] in
                guard let webView else{self?.inFlight=false;return}
                do{_ = try await webView.callAsyncJavaScript("window.MotuoNativeReceive(JSON.parse(payload))",arguments:["payload":payload],in:nil,contentWorld:.page)}
                catch{if self?.ready == true{self?.ready=false;self?.onError("座舱暂时不可用：\(error.localizedDescription)")}}
                self?.inFlight=false
            }
        }
        func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){
            let url=navigationAction.request.url
            decisionHandler(url?.scheme=="motuo" && url?.host=="bundle" ? .allow:.cancel)
        }
        func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:Error){onError(error.localizedDescription)}
        func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:Error){onError(error.localizedDescription)}
        func webViewWebContentProcessDidTerminate(_ webView:WKWebView){ready=false;onError("座舱已被系统回收；骑行记录仍由原生服务保存，可重新载入。");onCommand(CockpitCommand(action:"stopMicrophone"))}
        func webView(_ webView:WKWebView,requestMediaCapturePermissionFor origin:WKSecurityOrigin,initiatedByFrame frame:WKFrameInfo,type:WKMediaCaptureType,decisionHandler:@escaping(WKPermissionDecision)->Void){decisionHandler(.deny)}
    }
}
