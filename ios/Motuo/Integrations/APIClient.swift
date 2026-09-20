import Foundation
import Observation
import Security
import CryptoKit

struct APIClientError: LocalizedError {
    let message: String
    var statusCode: Int? = nil
    var errorDescription: String? { message }
}
private final class APIRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor protocol APIClientTransport {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
    func upload(for request: URLRequest, from data: Data) async throws -> (Data, URLResponse)
    func download(for request: URLRequest) async throws -> (URL, URLResponse)
}
@MainActor private final class URLSessionAPITransport: APIClientTransport {
    private let session: URLSession
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 45; config.timeoutIntervalForResource = 300
        config.httpShouldSetCookies = false; config.urlCache = nil
        session = URLSession(configuration: config, delegate: APIRedirectPolicy(), delegateQueue: nil)
    }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) { try await session.data(for: request) }
    func upload(for request: URLRequest, from data: Data) async throws -> (Data, URLResponse) { try await session.upload(for: request, from: data) }
    func download(for request: URLRequest) async throws -> (URL, URLResponse) { try await session.download(for: request) }
}
@MainActor protocol APIClientTokenStore {
    func read(account: String) -> String?
    func save(_ token: String, account: String) throws
    func remove(account: String)
}
@MainActor @Observable final class APIClient {
    static let shared = APIClient()
    var baseURL: String {
        didSet {
            guard oldValue != baseURL else { return }
            connectionGeneration &+= 1
            defaults.set(baseURL, forKey: "motuo.api.baseURL")
            token = tokenStore.read(account: baseURL)
            isPaired = token != nil
            clearManualCache()
            statusMessage = isPaired ? "已切换私人车库" : "连接你的私人车库"
        }
    }
    private(set) var isPaired = false
    private(set) var statusMessage = "连接你的私人车库"
    @ObservationIgnored private var token: String?
    @ObservationIgnored private let transport: any APIClientTransport
    @ObservationIgnored private let tokenStore: any APIClientTokenStore
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let manualCache: URL
    @ObservationIgnored private var connectionGeneration: UInt64 = 0
    private struct ConnectionIdentity {
        let generation: UInt64
        let account: String
        let token: String?
    }
    private var identity: ConnectionIdentity { .init(generation: connectionGeneration, account: baseURL, token: token) }
    private func requireCurrent(_ identity: ConnectionIdentity) throws {
        try Task.checkCancellation()
        guard identity.generation == connectionGeneration, identity.account == baseURL else {
            throw APIClientError(message: "私人车库连接已变更，请重试")
        }
    }
    static var encoder: JSONEncoder {
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; e.outputFormatting = [.sortedKeys]; return e
    }
    static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: text) else { throw APIClientError(message: "服务器日期格式无效") }
            return date
        }; return d
    }
    init(baseURL: String? = nil, transport: (any APIClientTransport)? = nil,
         tokenStore: (any APIClientTokenStore)? = nil, defaults: UserDefaults = .standard,
         cacheDirectory: URL? = nil) {
        self.defaults = defaults
        self.transport = transport ?? URLSessionAPITransport()
        self.tokenStore = tokenStore ?? KeychainAPITokenStore()
        self.manualCache = cacheDirectory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("MotuoManuals", isDirectory: true)
        self.baseURL = baseURL ?? defaults.string(forKey: "motuo.api.baseURL") ?? "https://motuo.yundongyl.cn"
        token = self.tokenStore.read(account: self.baseURL); isPaired = token != nil
    }
    func pair(code: String, deviceName: String) async throws {
        struct PairResponse: Decodable { let token: String; let deviceId: String; let ownerId: String }
        // The newest pairing attempt supersedes earlier requests and attempts.
        connectionGeneration &+= 1
        let current = identity
        var req = try makeRequest("/v1/pair", method: "POST", identity: current, authenticated: false)
        req.httpBody = try JSONSerialization.data(withJSONObject: ["code": code.trimmingCharacters(in: .whitespacesAndNewlines), "deviceName": deviceName])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await transport.data(for: req)
        try requireCurrent(current)
        try validate(response, data: data)
        let result = try Self.decoder.decode(PairResponse.self, from: data)
        // No suspension between validating the request identity and saving its token.
        try tokenStore.save(result.token, account: current.account)
        connectionGeneration &+= 1
        clearManualCache()
        defaults.removeObject(forKey: "accountDeletion.localCleanupPending")
        token = result.token; isPaired = true; statusMessage = "已连接私人车库"
    }
    func unpair() {
        connectionGeneration &+= 1
        tokenStore.remove(account: baseURL)
        token = nil; isPaired = false; statusMessage = "本机已解除配对"
        clearManualCache()
    }
    func request<Response: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Response {
        let current = identity
        var req = try makeRequest(path, method: method, identity: current)
        req.httpBody = body
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await transport.data(for: req)
        try requireCurrent(current)
        try validate(response, data: data)
        // DELETE endpoints may intentionally return no content.
        return try Self.decoder.decode(Response.self, from: data.isEmpty ? Data("{}".utf8) : data)
    }
    func upload(_ path: String, data: Data, sha256: String) async throws {
        let current = identity
        var req = try makeRequest(path, method: "PUT", identity: current)
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(sha256, forHTTPHeaderField: "X-Content-SHA256")
        let (body, response) = try await transport.upload(for: req, from: data)
        try requireCurrent(current)
        try validate(response, data: body)
    }
    func download(_ path: String) async throws -> URL {
        let current = identity
        let request = try makeRequest(path, method: "GET", identity: current)
        guard isPaired else { throw APIClientError(message:"请先配对私人车库") }
        let name = SHA256.hash(data:Data((current.account+path).utf8)).map { String(format:"%02x",$0) }.joined()+".pdf"
        let output = manualCache.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath:output.path) { return output }
        let (file, response) = try await transport.download(for: request)
        // URLSession's temporary file must also be removed on stale/error responses.
        defer { try? FileManager.default.removeItem(at: file) }
        try requireCurrent(current)
        try validate(response, data: Data())
        try FileManager.default.createDirectory(at:manualCache,withIntermediateDirectories:true)
        if FileManager.default.fileExists(atPath:output.path) { try? FileManager.default.removeItem(at:file); return output }
        // Keep at most two maximum-sized manuals. Only this app's private PDF cache is pruned.
        let existing = (try? FileManager.default.contentsOfDirectory(at:manualCache,includingPropertiesForKeys:[.fileSizeKey,.contentModificationDateKey])) ?? []
        let incoming = (try? file.resourceValues(forKeys:[.fileSizeKey]).fileSize) ?? 0
        var total = existing.reduce(incoming) { $0 + ((try? $1.resourceValues(forKeys:[.fileSizeKey]).fileSize) ?? 0) }
        for old in existing.sorted(by:{ ((try? $0.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < ((try? $1.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }) where total > 512*1024*1024 {
            let bytes = (try? old.resourceValues(forKeys:[.fileSizeKey]).fileSize) ?? 0
            try FileManager.default.removeItem(at:old); total -= bytes
        }
        try FileManager.default.moveItem(at: file, to: output)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: output.path)
        return output
    }
    func clearManualCache() { try? FileManager.default.removeItem(at:manualCache) }
    private func makeRequest(_ path: String, method: String, identity: ConnectionIdentity, authenticated: Bool = true) throws -> URLRequest {
        guard let base = URLComponents(string: identity.account), let host = base.host,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              base.scheme == "https" || (base.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)),
              path.hasPrefix("/v1/"), !path.contains(".."), !path.contains("\\"),
              let url = URL(string: identity.account.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path), url.host == host
        else { throw APIClientError(message: "请填写有效的 HTTPS 私人车库地址") }
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated, let token = identity.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }
    private func validate(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw APIClientError(message: "没有收到有效服务响应") }
        guard (200..<300).contains(http.statusCode) else {
            struct Envelope: Decodable { struct Detail: Decodable { let code: String; let message: String }; let error: Detail }
            let detail = try? Self.decoder.decode(Envelope.self, from: data)
            let message = detail?.error.message ?? "服务暂不可用（\(http.statusCode)）"
            statusMessage = message
            throw APIClientError(message: message, statusCode:http.statusCode)
        }
    }
}
@MainActor private final class KeychainAPITokenStore: APIClientTokenStore {
    func remove(account: String) {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: "cn.yundongyl.motuo.device", kSecAttrAccount: account] as CFDictionary)
    }
    func read(account: String) -> String? {
        let query: [CFString: Any] = [kSecClass:kSecClassGenericPassword, kSecAttrService:"cn.yundongyl.motuo.device", kSecAttrAccount:account, kSecReturnData:true, kSecMatchLimit:kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    func save(_ token: String, account: String) throws {
        let query: [CFString:Any] = [kSecClass:kSecClassGenericPassword, kSecAttrService:"cn.yundongyl.motuo.device", kSecAttrAccount:account]
        let values: [CFString:Any] = [kSecValueData:Data(token.utf8), kSecAttrAccessible:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let existing = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if existing == errSecItemNotFound {
            var item = query; values.forEach { item[$0.key] = $0.value }
            let status = SecItemAdd(item as CFDictionary, nil)
            guard status == errSecSuccess else { throw keychainError(status) }
        } else if existing != errSecSuccess { throw keychainError(existing) }
    }
    private func keychainError(_ status: OSStatus) -> APIClientError {
        // OSStatus is diagnostic, never include the item query, account or token.
        let detail = SecCopyErrorMessageString(status, nil) as String? ?? "Keychain unavailable"
        return APIClientError(message: "设备凭据未保存，请检查应用签名与钥匙串（\(status)：\(detail)）")
    }
}
