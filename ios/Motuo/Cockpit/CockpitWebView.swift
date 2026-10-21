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

struct CockpitWebView: UIViewRepresentable {
    var snapshot: String
    var onCommand: (String)->Void
    var onError: (String?)->Void
    func makeCoordinator()->Coordinator { Coordinator(onCommand:onCommand,onError:onError) }
    func makeUIView(context:Context)->WKWebView {
        let configuration=WKWebViewConfiguration()
        configuration.setURLSchemeHandler(CockpitAssetHandler(),forURLScheme:"motuo")
        configuration.userContentController.add(context.coordinator,name:"motuo")
        configuration.defaultWebpagePreferences.allowsContentJavaScript=true
        let view=WKWebView(frame:.zero,configuration:configuration)
        view.isOpaque=false;view.backgroundColor = .black;view.scrollView.backgroundColor = .black
        view.scrollView.isScrollEnabled=false;view.scrollView.contentInsetAdjustmentBehavior = .never
        view.navigationDelegate=context.coordinator;view.uiDelegate=context.coordinator
        view.accessibilityIdentifier="native.cockpit"
        context.coordinator.webView=view;context.coordinator.snapshot=snapshot
        view.load(URLRequest(url:URL(string:"motuo://bundle/index.html")!))
        return view
    }
    func updateUIView(_ view:WKWebView,context:Context) {
        context.coordinator.onCommand=onCommand;context.coordinator.onError=onError
        context.coordinator.snapshot=snapshot;context.coordinator.push()
    }
    static func dismantleUIView(_ view:WKWebView,coordinator:Coordinator) {
        coordinator.ready=false;view.stopLoading();view.configuration.userContentController.removeScriptMessageHandler(forName:"motuo")
        view.navigationDelegate=nil;view.uiDelegate=nil;coordinator.webView=nil
    }
    @MainActor final class Coordinator:NSObject,WKScriptMessageHandler,WKNavigationDelegate,WKUIDelegate {
        weak var webView:WKWebView?
        var snapshot="{}",ready=false,inFlight=false
        var onCommand:(String)->Void
        var onError:(String?)->Void
        init(onCommand:@escaping(String)->Void,onError:@escaping(String?)->Void){self.onCommand=onCommand;self.onError=onError}
        static let commands:Set<String>=["ready","primary","finish","demoStart","microphone","stopMicrophone","musicToggle","musicNext","musicPrevious","musicLibrary","garage","history","settings","navigation","wrappedShown","rideDetail","wrappedDone"]
        func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage){
            guard message.frameInfo.isMainFrame,message.frameInfo.securityOrigin.protocol == "motuo",message.frameInfo.securityOrigin.host == "bundle",
                  let body=message.body as? [String:Any],body.count==1,let action=body["action"] as? String,Self.commands.contains(action) else{return}
            if action=="ready"{ready=true;onError(nil);push()}else{onCommand(action)}
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
        func webViewWebContentProcessDidTerminate(_ webView:WKWebView){ready=false;onError("座舱已被系统回收；骑行记录仍由原生服务保存，可重新载入。");onCommand("stopMicrophone")}
        func webView(_ webView:WKWebView,requestMediaCapturePermissionFor origin:WKSecurityOrigin,initiatedByFrame frame:WKFrameInfo,type:WKMediaCaptureType,decisionHandler:@escaping(WKPermissionDecision)->Void){decisionHandler(.deny)}
    }
}
