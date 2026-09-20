import XCTest
@testable import Motuo

@MainActor private final class MemoryAPITokens: APIClientTokenStore {
    var values: [String: String] = [:]
    var writes: [(String, String)] = []
    func read(account: String) -> String? { values[account] }
    func save(_ token: String, account: String) throws { values[account] = token; writes.append((account, token)) }
    func remove(account: String) { values.removeValue(forKey: account) }
}

// Each response is resumed by the test after a real asynchronous suspension.
// Production URL construction/auth headers are exercised; no external service is contacted.
@MainActor private final class DelayedAPITransport: APIClientTransport {
    struct Pending {
        let request: URLRequest
        var data: CheckedContinuation<(Data, URLResponse), Error>?
        var file: CheckedContinuation<(URL, URLResponse), Error>?
    }
    var pending: [Pending] = []
    var onStart: (() -> Void)?
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            pending.append(.init(request: request, data: continuation)); onStart?()
        }
    }
    func upload(for request: URLRequest, from data: Data) async throws -> (Data, URLResponse) {
        try await self.data(for: request)
    }
    func download(for request: URLRequest) async throws -> (URL, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            pending.append(.init(request: request, file: continuation)); onStart?()
        }
    }
    func reply(_ index: Int, body: String = "{}", status: Int = 200) {
        let response = HTTPURLResponse(url: pending[index].request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        let continuation = pending[index].data!; pending[index].data = nil
        continuation.resume(returning: (Data(body.utf8), response))
    }
    func replyFile(_ index: Int, file: URL, status: Int = 200) {
        let response = HTTPURLResponse(url: pending[index].request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        let continuation = pending[index].file!; pending[index].file = nil
        continuation.resume(returning: (file, response))
    }
}

@MainActor private final class APIHarness {
    let a = "https://garage-a.example"
    let b = "https://garage-b.example"
    let transport = DelayedAPITransport()
    let tokens = MemoryAPITokens()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let suite = "MotuoAPIClientTests." + UUID().uuidString
    var cache: URL { root.appendingPathComponent("cache") }
    func client(paired: Bool = false) -> APIClient {
        if paired { tokens.values[a] = "old-a-token" }
        return APIClient(baseURL: a, transport: transport, tokenStore: tokens,
                         defaults: UserDefaults(suiteName: suite)!, cacheDirectory: cache)
    }
    func incomingFile() throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent(UUID().uuidString + ".pdf")
        try Data("%PDF-1.7 test evidence".utf8).write(to: file)
        return file
    }
    func cleanup() { try? FileManager.default.removeItem(at: root); UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
    func pairing(_ token: String) -> String { "{\"token\":\"\(token)\",\"deviceId\":\"device\",\"ownerId\":\"owner\"}" }
}

final class APIClientTests: XCTestCase {
    @MainActor func testDelayedPairCannotSaveTokenAfterHostSwitchEvenIfHostSwitchesBack() async throws {
        let h = APIHarness(); defer { h.cleanup() }; let client = h.client()
        let started = expectation(description: "pair started")
        h.transport.onStart = { started.fulfill() }
        let pair = Task { try await client.pair(code: "first", deviceName: "phone") }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(h.transport.pending[0].request.url?.absoluteString, h.a + "/v1/pair")
        XCTAssertNil(h.transport.pending[0].request.value(forHTTPHeaderField: "Authorization"))
        client.baseURL = h.b
        client.baseURL = h.a
        h.transport.reply(0, body: h.pairing("stale-token"))
        do { try await pair.value; XCTFail("stale pairing must fail") } catch {}
        XCTAssertTrue(h.tokens.writes.isEmpty)
        XCTAssertNil(h.tokens.values[h.a]); XCTAssertNil(h.tokens.values[h.b])
        XCTAssertFalse(client.isPaired)
    }

    @MainActor func testUnpairWhilePairingDoesNotRestoreCredentials() async throws {
        let h = APIHarness(); defer { h.cleanup() }; let client = h.client(paired: true)
        let started = expectation(description: "pair started")
        h.transport.onStart = { started.fulfill() }
        let pair = Task { try await client.pair(code: "replacement", deviceName: "phone") }
        await fulfillment(of: [started], timeout: 2)
        client.unpair()
        h.transport.reply(0, body: h.pairing("stale-token"))
        do { try await pair.value; XCTFail("unpaired connection must reject response") } catch {}
        XCTAssertTrue(h.tokens.writes.isEmpty); XCTAssertNil(h.tokens.values[h.a])
        XCTAssertFalse(client.isPaired); XCTAssertEqual(client.statusMessage, "本机已解除配对")
    }

    @MainActor func testNewestPairingWinsWhenResponsesArriveOutOfOrder() async throws {
        let h = APIHarness(); defer { h.cleanup() }; let client = h.client()
        let firstStarted = expectation(description: "first started")
        h.transport.onStart = { firstStarted.fulfill() }
        let first = Task { try await client.pair(code: "first", deviceName: "phone") }
        await fulfillment(of: [firstStarted], timeout: 2)
        let secondStarted = expectation(description: "second started")
        h.transport.onStart = { secondStarted.fulfill() }
        let second = Task { try await client.pair(code: "second", deviceName: "phone") }
        await fulfillment(of: [secondStarted], timeout: 2)
        h.transport.reply(1, body: h.pairing("new-token")); try await second.value
        h.transport.reply(0, body: h.pairing("old-token"))
        do { try await first.value; XCTFail("older attempt must fail") } catch {}
        XCTAssertEqual(h.tokens.writes.count, 1)
        XCTAssertEqual(h.tokens.values[h.a], "new-token"); XCTAssertTrue(client.isPaired)
    }

    @MainActor func testRequestAndUploadRejectPriorHostResponsesWithoutChangingNewHostStatus() async throws {
        struct Response: Decodable { let value: String }
        let h = APIHarness(); defer { h.cleanup() }; let client = h.client(paired: true)
        let started = expectation(description: "both requests started"); started.expectedFulfillmentCount = 2
        h.transport.onStart = { started.fulfill() }
        let query = Task<Response, Error> { try await client.request("/v1/vehicles") }
        let upload = Task { try await client.upload("/v1/rides/ride/chunks/0", data: Data("data".utf8), sha256: "digest") }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(h.transport.pending.allSatisfy { $0.request.url?.host == "garage-a.example" && $0.request.value(forHTTPHeaderField: "Authorization") == "Bearer old-a-token" })
        client.baseURL = h.b
        let status = client.statusMessage
        for index in h.transport.pending.indices {
            h.transport.reply(index, body: "{\"error\":{\"code\":\"old\",\"message\":\"old garage failure\"}}", status: 401)
        }
        do { _ = try await query.value; XCTFail("old query must fail") } catch let error as APIClientError { XCTAssertNil(error.statusCode) }
        do { try await upload.value; XCTFail("old upload must fail") } catch let error as APIClientError { XCTAssertNil(error.statusCode) }
        XCTAssertEqual(client.statusMessage, status)
    }

    @MainActor func testUnpairDuringDownloadDeletesTemporaryFileAndCannotRecreateCache() async throws {
        let h = APIHarness(); defer { h.cleanup() }; let client = h.client(paired: true)
        let started = expectation(description: "download started")
        h.transport.onStart = { started.fulfill() }
        let download = Task { try await client.download("/v1/manuals/manual/file") }
        await fulfillment(of: [started], timeout: 2)
        let temporary = try h.incomingFile()
        client.unpair()
        h.transport.replyFile(0, file: temporary)
        do { _ = try await download.value; XCTFail("unpaired download must fail") } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: h.cache.path))
        XCTAssertFalse(client.isPaired)
    }

    @MainActor func testCurrentDownloadMovesFileToCacheAndRejectsErrorFileWithoutLeakingIt() async throws {
        let h = APIHarness(); defer { h.cleanup() }; let client = h.client(paired: true)
        let started = expectation(description: "download started")
        h.transport.onStart = { started.fulfill() }
        let download = Task { try await client.download("/v1/manuals/manual/file") }
        await fulfillment(of: [started], timeout: 2)
        let temporary = try h.incomingFile()
        h.transport.replyFile(0, file: temporary)
        let cached = try await download.value
        XCTAssertTrue(FileManager.default.fileExists(atPath: cached.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: temporary.path))
        let cacheHit = try await client.download("/v1/manuals/manual/file")
        XCTAssertEqual(cacheHit, cached)
        XCTAssertEqual(h.transport.pending.count, 1)
        let errorStarted = expectation(description: "error download started")
        h.transport.onStart = { errorStarted.fulfill() }
        let failed = Task { try await client.download("/v1/manuals/other/file") }
        await fulfillment(of: [errorStarted], timeout: 2)
        let errorFile = try h.incomingFile()
        h.transport.replyFile(1, file: errorFile, status: 404)
        do { _ = try await failed.value; XCTFail("404 must fail") } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: errorFile.path))
    }
}
