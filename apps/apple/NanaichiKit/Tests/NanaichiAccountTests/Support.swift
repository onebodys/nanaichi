import Foundation
import Synchronization
import Testing

@testable import NanaichiAccount
@testable import NanaichiDomain

let server = URL(string: "https://nanaichi.test")!
let token = SessionToken("token-123")!

// MARK: - Web の API の実際の応答（NanaichiDomainTests と同じファイル）

/// 例ごとの JSON（`Any` は Sendable でないので、例ごとに JSON のまま持つ）
private let fixtures: [String: Data] = {
    let url = URL(filePath: #filePath).deletingLastPathComponent().appending(
        path: "../NanaichiDomainTests/Fixtures/api-responses.json")
    do {
        guard let all = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            fatalError("応答の例がオブジェクトではない: \(url.path)")
        }
        return all.compactMapValues { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
    } catch {
        fatalError("応答の例を読めない: \(url.path) \(error)")
    }
}()

/// 応答の例 `name` の、ステータスと本文
func fixture(_ name: String) -> StubResponse {
    guard let json = fixtures[name], let response = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
        let status = response["status"] as? Int,
        let body = response["body"], let data = try? JSONSerialization.data(withJSONObject: body)
    else { fatalError("応答の例がない: \(name)") }
    return .http(status: status, body: data)
}

/// 応答の例 `name` の本文を、ドメインの型に戻したもの
func decoded<T: Decodable>(_: T.Type, _ name: String) -> T {
    guard case .http(_, let body) = fixture(name), let value = try? JSONDecoder().decode(T.self, from: body) else {
        fatalError("応答の例を \(T.self) として読めない: \(name)")
    }
    return value
}

/// JSON の文字列を、キーの順をそろえた形にする（送った本文と期待する本文を比べるため）
func canonicalJSON(_ data: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: data),
        let canonical = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else { return nil }
    return String(decoding: canonical, as: UTF8.self)
}

func canonicalJSON(_ text: String) -> String? { canonicalJSON(Data(text.utf8)) }

// MARK: - URLProtocol でサーバーの代わりをする

enum StubResponse: Sendable {
    case http(status: Int, body: Data)
    /// 届かない（オフラインなど）
    case unreachable

    static func text(_ status: Int, _ body: String) -> StubResponse { .http(status: status, body: Data(body.utf8)) }
}

struct RecordedRequest: Sendable {
    let method: String
    /// 符号化したままのパスとクエリ
    let path: String
    let query: String?
    let headers: [String: String]
    let body: Data?
}

/// テストごとのサーバーの代わり。`session` で送ったリクエストを記録し、`respond` の応答を返す。
/// テストは並んで走るので、どのテストのリクエストかを `X-Stub-Id` のヘッダで見分ける
final class StubServer: Sendable {
    private static let servers = Mutex<[String: StubServer]>([:])

    private let id = UUID().uuidString
    private let respond: @Sendable (RecordedRequest) -> StubResponse
    private let recorded = Mutex<[RecordedRequest]>([])
    let session: URLSession

    init(_ respond: @escaping @Sendable (RecordedRequest) -> StubResponse) {
        self.respond = respond
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Stub-Id": id]
        session = URLSession(configuration: configuration)
        Self.servers.withLock { $0[id] = self }
    }

    convenience init(_ response: StubResponse) {
        self.init { _ in response }
    }

    var requests: [RecordedRequest] { recorded.withLock { $0 } }

    fileprivate static func handle(_ request: URLRequest) -> StubResponse? {
        guard let id = request.value(forHTTPHeaderField: "X-Stub-Id"),
            let server = servers.withLock({ $0[id] }), let url = request.url,
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        var headers = request.allHTTPHeaderFields ?? [:]
        headers["X-Stub-Id"] = nil
        let recorded = RecordedRequest(
            method: request.httpMethod ?? "GET", path: components.percentEncodedPath,
            query: components.percentEncodedQuery, headers: headers, body: bodyOf(request))
        server.recorded.withLock { $0.append(recorded) }
        return server.respond(recorded)
    }

    /// URLProtocol に届くリクエストでは、本文が `httpBodyStream` に移っている
    private static func bodyOf(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class StubProtocol: URLProtocol {
    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        switch StubServer.handle(request) {
        case .http(let status, let body):
            guard let url = request.url,
                let response = HTTPURLResponse(
                    url: url, statusCode: status, httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"])
            else { return }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        case .unreachable, nil:
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        }
    }

    override func stopLoading() {}
}

/// 呼ばれた回数を数える
final class Counter: Sendable {
    private let count = Mutex(0)
    var value: Int { count.withLock { $0 } }
    func increment() { count.withLock { $0 += 1 } }
}

// MARK: - 同期の WebSocket の代わり

/// 時計を進めて動かすタイマー
final class ManualScheduler: SyncScheduler {
    private struct Entry {
        let id: Int
        let at: Int64
        let action: @Sendable () async -> Void
    }

    private struct State {
        var now: Int64 = 0
        var lastId = 0
        var entries: [Entry] = []
    }

    private let state = Mutex(State())
    /// 止めても動く。`Task.sleep` のタイマーが、止める前に起きていて遅れて動くのを再現する
    private let firesAfterCancel: Bool

    init(firesAfterCancel: Bool = false) {
        self.firesAfterCancel = firesAfterCancel
    }

    func after(milliseconds: Int64, _ action: @escaping @Sendable () async -> Void) -> any SyncTimer {
        let id = state.withLock { state in
            state.lastId += 1
            state.entries.append(Entry(id: state.lastId, at: state.now + milliseconds, action: action))
            return state.lastId
        }
        if firesAfterCancel { return ManualTimer {} }
        return ManualTimer { [weak self] in self?.state.withLock { $0.entries.removeAll { $0.id == id } } }
    }

    /// `milliseconds` だけ時計を進め、そのあいだに期限が来たタイマーを早い順に動かす
    func advance(by milliseconds: Int64) async {
        let target = state.withLock { $0.now + milliseconds }
        while true {
            let due: Entry? = state.withLock { state in
                guard let next = state.entries.filter({ $0.at <= target }).min(by: { ($0.at, $0.id) < ($1.at, $1.id) })
                else { return nil }
                state.entries.removeAll { $0.id == next.id }
                state.now = next.at
                return next
            }
            guard let due else { break }
            await due.action()
        }
        state.withLock { $0.now = target }
    }
}

private struct ManualTimer: SyncTimer {
    let onCancel: @Sendable () -> Void
    func cancel() { onCancel() }
}

final class FakeSocket: SyncSocket {
    private let onEvent: @Sendable (SyncSocketEvent) async -> Void
    private let state = Mutex<(sent: [String], closed: Bool)>(([], false))

    init(onEvent: @escaping @Sendable (SyncSocketEvent) async -> Void) {
        self.onEvent = onEvent
    }

    var sent: [String] { state.withLock { $0.sent } }
    var closed: Bool { state.withLock { $0.closed } }

    func send(_ text: String) { state.withLock { $0.sent.append(text) } }
    func close() { state.withLock { $0.closed = true } }

    /// サーバーの側で起きたことを届け、受け取った側が扱い終えるまで待つ
    func emit(_ event: SyncSocketEvent) async { await onEvent(event) }
}

/// 開いた同期の WebSocket を順に覚えておく
final class FakeSockets: Sendable {
    private let opened = Mutex<[FakeSocket]>([])

    var all: [FakeSocket] { opened.withLock { $0 } }
    var last: FakeSocket { all[all.count - 1] }

    var open: OpenSyncSocket {
        { [self] onEvent in
            let socket = FakeSocket(onEvent: onEvent)
            opened.withLock { $0.append(socket) }
            return socket
        }
    }
}

/// WebSocket に届いた実際の同期メッセージ（応答の例の `syncMessages`）の `index` 番目の文字列
func syncMessageText(_ index: Int) -> String {
    guard let json = fixtures["syncMessages"], let messages = try? JSONSerialization.jsonObject(with: json) as? [Any],
        let data = try? JSONSerialization.data(withJSONObject: messages[index])
    else { fatalError("同期メッセージの例がない: \(index)") }
    return String(decoding: data, as: UTF8.self)
}
