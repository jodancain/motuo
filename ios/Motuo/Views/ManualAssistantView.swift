import SwiftUI
import UniformTypeIdentifiers
import PDFKit
import CryptoKit

struct ManualAssistantView:View {
    var vehicle:Vehicle
    @Environment(\.dismiss) private var dismiss
    @State private var manuals:[ManualRecord]=[]
    @State private var importing=false
    @State private var question=""
    @State private var answer:ManualAnswer?
    @State private var busy=false
    @State private var status="导入这辆摩托对应的维修手册，保留原页码与证据。"
    @State private var progress=0.0
    @State private var preview:ManualPreview?
    @State private var showPair=false
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:22) {
                    PageTitle(eyebrow:"MACHINE KNOWLEDGE",title:"读懂你的摩托",subtitle:"\(vehicle.make) \(vehicle.model) · 手册里的答案，有据可查。")
                    if !APIClient.shared.isPaired { Panel { VStack(alignment:.leading,spacing:12) { Text("先连接你的私人 NAS").font(.system(size:17,weight:.semibold));Text("原始手册与解析结果存放在私人服务。连接后即可导入 PDF，并按原始页码核对回答。").font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(5);ActionButton(title:"配对私人车库",symbol:"link",primary:false) { showPair=true } } } }
                    else { ActionButton(title:"导入维修手册 PDF",symbol:"doc.badge.plus",primary:false) { importing=true }.disabled(busy) }
                    if busy { ProgressView(value:progress).tint(Cyber.accent) }
                    Text(status).font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(5)
                    ForEach(manuals) { manual in
                        Button { Task { await openManual(manual.id,name:manual.fileName,page:1) } } label:{ Panel { HStack(alignment:.top,spacing:12) { Image(systemName:"book.closed.fill").font(.system(size:22)).foregroundStyle(Cyber.cyan);VStack(alignment:.leading,spacing:7) { Text(manual.fileName).font(.system(size:14,weight:.medium)).foregroundStyle(.white).lineLimit(2);Text("\(manual.pageCount) 页 · \(manualStatus(manual))").font(.system(size:11)).foregroundStyle(Cyber.muted);if let error=manual.error { Text(error).font(.system(size:11)).foregroundStyle(Cyber.orange) } };Spacer();Image(systemName:"arrow.up.right").foregroundStyle(Cyber.accent) } } }.buttonStyle(.plain).disabled(manual.status != "ready")
                    }
                    Panel(accent:Cyber.cyan.opacity(0.2)) {
                        VStack(alignment:.leading,spacing:16) {
                            HStack { Image(systemName:"sparkle.magnifyingglass").foregroundStyle(Cyber.cyan);Text("基于手册提问").font(.system(size:17,weight:.semibold)) }
                            TextField("例如：如何检查制动片磨损？",text:$question,axis:.vertical).lineLimit(3...6).font(.system(size:14)).padding(14).background(Cyber.ink,in:RoundedRectangle(cornerRadius:12))
                            ActionButton(title:busy ? "正在处理":"查找原文证据",symbol:"arrow.up") { Task { await ask() } }.disabled(busy || question.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !APIClient.shared.isPaired)
                        }
                    }
                    if let answer {
                        Panel { VStack(alignment:.leading,spacing:15) {
                            HStack { Text("手册回答").font(.system(size:18,weight:.semibold));Spacer();StatusPill(text:answer.source == "ai" ? "AI + 原文" : answer.source == "extractive" ? "原文检索":"证据不足",color:answer.source == "no_evidence" ? Cyber.orange:Cyber.cyan) }
                            Text(answer.answer).font(.system(size:14)).lineSpacing(7).textSelection(.enabled)
                            ForEach(answer.limitations,id:\.self) { Text($0).font(.system(size:11)).foregroundStyle(Cyber.orange).lineSpacing(4) }
                            ForEach(answer.citations) { citation in
                                Button { Task { await openManual(citation.manualId,name:citation.fileName,page:citation.page) } } label:{ VStack(alignment:.leading,spacing:8) {
                                    HStack { Image(systemName:"doc.text.magnifyingglass");Text("PDF 第 \(citation.page) 页");if let printed=citation.printedPage,!printed.isEmpty { Text("· 印刷页 \(printed)") };Spacer();Image(systemName:"arrow.up.right") }.font(.system(size:11,weight:.semibold)).foregroundStyle(Cyber.cyan)
                                    Text(citation.quote).font(.system(size:12)).foregroundStyle(Cyber.muted).lineSpacing(4).lineLimit(8)
                                }.padding(13).background(Cyber.ink,in:RoundedRectangle(cornerRadius:12)) }.buttonStyle(.plain)
                            }
                        } }
                    }
                    Text("回答需核对车型、年份与 ABS 版本；扭矩、间隙和维修步骤以引用原页为准。资料不足时不会补写数值。").font(.system(size:11)).foregroundStyle(Cyber.muted).lineSpacing(5)
                }.padding(24).frame(maxWidth:800)
            }.background(Cyber.ink).navigationTitle("维修手册").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement:.topBarTrailing) { Button("完成") { dismiss() } } }
        }.fileImporter(isPresented:$importing,allowedContentTypes:[.pdf]) { result in
            switch result { case .success(let url):Task { await upload(url) };case .failure(let error):status=error.localizedDescription }
        }
        .sheet(item:$preview) { item in NavigationStack { PDFDocumentView(url:item.url,page:item.page).navigationTitle(item.name).navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement:.topBarTrailing) { Button("完成") { preview=nil } } } } }
        .sheet(isPresented:$showPair,onDismiss:{Task{await loadManuals()}}) { PairingView() }
        .task {
            await loadManuals()
            while !Task.isCancelled {
                do { try await Task.sleep(for:.seconds(5)) } catch { break }
                if manuals.contains(where:{["queued","processing"].contains($0.status)}) { await loadManuals() }
            }
        }
    }
    private func manualStatus(_ manual:ManualRecord)->String {
        switch manual.status { case "ready":return "可引用";case "uploading":return "上传中";case "queued":return "等待解析";case "processing":return "解析中 \(manual.progress)%";default:return "解析未完成" }
    }
    private func loadManuals() async {
        guard APIClient.shared.isPaired else { return }
        do { let response:ItemsResponse<ManualRecord>=try await APIClient.shared.request("/v1/manuals?vehicleId=\(vehicle.id.uuidString)");manuals=response.items }
        catch { status=error.localizedDescription }
    }
    private func ask() async {
        busy=true;progress=0;defer{busy=false}
        do { let body=try JSONSerialization.data(withJSONObject:["vehicleId":vehicle.id.uuidString,"question":question]);answer=try await APIClient.shared.request("/v1/manuals/ask",method:"POST",body:body);status="回答已返回，点击证据可核对原始 PDF 页。" }
        catch { status="提问未完成：\(error.localizedDescription)" }
    }
    private func openManual(_ id:String,name:String,page:Int) async {
        status="正在读取手册原件…"
        do { let url=try await APIClient.shared.download("/v1/manuals/\(id)/file");preview = .init(url:url,name:name,page:page);status="原件已就绪" }
        catch { status=error.localizedDescription }
    }
    private func upload(_ url:URL) async {
        let access=url.startAccessingSecurityScopedResource();defer{if access{url.stopAccessingSecurityScopedResource()}}
        busy=true;progress=0;defer{busy=false}
        do {
            let size=(try url.resourceValues(forKeys:[.fileSizeKey])).fileSize ?? 0
            guard size>0,size<=256*1024*1024 else { throw APIClientError(message:"PDF 必须小于 256 MiB 且不可为空") }
            status="校验 PDF 文件…"
            let handle=try FileHandle(forReadingFrom:url);defer{try? handle.close()}
            var hasher=SHA256()
            while let data=try handle.read(upToCount:4*1024*1024),!data.isEmpty { hasher.update(data:data);try Task.checkCancellation();await Task.yield() }
            let hash=hasher.finalize().map{String(format:"%02x",$0)}.joined();try handle.seek(toOffset:0)
            let _:EmptyAPIResponse=try await APIClient.shared.request("/v1/vehicles/\(vehicle.id.uuidString)",method:"PUT",body:try APIClient.encoder.encode(vehicle.payload))
            struct InitResponse:Codable{var id:String;var chunkSize:Int;var status:String}
            let metadata=try JSONSerialization.data(withJSONObject:["vehicleId":vehicle.id.uuidString,"fileName":url.lastPathComponent,"totalBytes":size,"sha256":hash])
            let ticketKey="manualUpload."+TelemetryJournal.hash(Data((APIClient.shared.baseURL+vehicle.id.uuidString+hash).utf8))
            let upload:InitResponse
            if let saved=UserDefaults.standard.data(forKey:ticketKey),let pending=try? JSONDecoder().decode(InitResponse.self,from:saved) {
                upload=pending;status="恢复同一份手册上传，已提交分块将幂等校验。"
            } else {
                upload=try await APIClient.shared.request("/v1/manuals",method:"POST",body:metadata)
                UserDefaults.standard.set(try JSONEncoder().encode(upload),forKey:ticketKey)
            }
            guard upload.chunkSize>0,upload.chunkSize<=4*1024*1024 else { throw APIClientError(message:"服务器分块大小无效") }
            var sequence=0;var uploaded=0
            while let data=try handle.read(upToCount:upload.chunkSize),!data.isEmpty {
                try Task.checkCancellation();status="正在上传手册 \(Int(Double(uploaded)/Double(size)*100))%"
                try await APIClient.shared.upload("/v1/manuals/\(upload.id)/chunks/\(sequence)",data:data,sha256:TelemetryJournal.hash(data))
                uploaded+=data.count;sequence+=1;progress=Double(uploaded)/Double(size)
            }
            let _:EmptyAPIResponse=try await APIClient.shared.request("/v1/manuals/\(upload.id)/complete",method:"POST",body:try JSONSerialization.data(withJSONObject:["expectedChunks":sequence]))
            UserDefaults.standard.removeObject(forKey:ticketKey)
            status="上传完成。NAS 正在解析页码与原文，完成后可提问。";await loadManuals()
        } catch { status="导入未完成：\(error.localizedDescription)。重新选择同一份 PDF 可恢复上传。" }
    }
}
private struct ManualPreview:Identifiable { var id=UUID();var url:URL;var name:String;var page:Int }
private struct PDFDocumentView: UIViewControllerRepresentable {
    var url: URL; var page: Int
    func makeUIViewController(context: Context) -> PDFReaderController { PDFReaderController(url: url, targetPage: page) }
    func updateUIViewController(_ controller: PDFReaderController, context: Context) { }
}

private final class PDFReaderController: UIViewController {
    private let url: URL
    private let targetPage: Int
    private let pdfView = PDFView()
    private let pageLabel = UILabel()
    private var didNavigate = false
    init(url: URL, targetPage: Int) { self.url = url; self.targetPage = targetPage; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        pdfView.autoScales = true; pdfView.displayMode = .singlePageContinuous
        pdfView.translatesAutoresizingMaskIntoConstraints = false
        pageLabel.translatesAutoresizingMaskIntoConstraints = false
        pageLabel.font = .monospacedSystemFont(ofSize: 12, weight: .medium)
        pageLabel.textColor = .secondaryLabel; pageLabel.textAlignment = .center
        pageLabel.accessibilityIdentifier = "manual.actualPage"
        view.addSubview(pdfView); view.addSubview(pageLabel)
        NSLayoutConstraint.activate([
            pageLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            pageLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            pageLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pageLabel.heightAnchor.constraint(equalToConstant: 30),
            pdfView.topAnchor.constraint(equalTo: pageLabel.bottomAnchor),
            pdfView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            pdfView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pdfView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(pageChanged), name: .PDFViewPageChanged, object: pdfView)
        pdfView.document = PDFDocument(url: url); pageChanged()
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !didNavigate, let document = pdfView.document, let target = document.page(at: targetPage - 1) else { return }
        // PDFKit's initial autoscale/layout resets scroll position if go(to:) runs in makeUIView.
        pdfView.layoutDocumentView(); pdfView.go(to: target); didNavigate = true; pageChanged()
    }
    @objc private func pageChanged() {
        guard let document = pdfView.document, let page = pdfView.currentPage else { pageLabel.text = "PDF 载入中"; return }
        pageLabel.text = "PDF 第 \(document.index(for: page) + 1) / \(document.pageCount) 页"
    }
}
