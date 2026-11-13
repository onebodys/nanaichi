import Foundation
import NanaichiDomain

/// アカウントの記録先への1つのリクエスト
struct ApiRequest: Sendable {
    enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
        case put = "PUT"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    let method: Method
    /// `/api/` のあとのパス。各部分は符号化する前のもの
    let path: [String]
    var query: [(String, String)] = []
    var body: Data? = nil

    static func get(_ path: String..., query: [(String, String)] = []) -> ApiRequest {
        ApiRequest(method: .get, path: path, query: query)
    }

    static func send(_ method: Method, _ path: String..., json: some Encodable) -> ApiRequest {
        // 送る本文はドメインの型と、それを並べただけの構造体なので、JSON にできないのは実装の誤り
        guard let body = try? JSONEncoder().encode(json) else { preconditionFailure("本文を JSON にできない") }
        return ApiRequest(method: method, path: path, body: body)
    }

    static func send(_ method: Method, _ path: String...) -> ApiRequest {
        ApiRequest(method: method, path: path)
    }
}

/// HTTP の API の通信層（TS の `requestApi`、ADR 0009）。送る → 受け取る → 本文をドメインの型で検証する。
///
/// 失敗は Web と同じく `BackendError` にする。届かない（オフラインなど）は `unreachable`、エラーの本文は
/// `rejected`、本文がドメインの型にもエラーの本文にも合わなければ `broken`。HTTP のステータスは
/// 成功かどうかを分けるのにだけ使う
struct ApiClient: Sendable {
    let server: URL
    let session: URLSession
    /// `Authorization: Bearer` に付けるトークン。ログインの引き換えのように、まだ持っていなければ nil
    let token: SessionToken?
    /// ログインが切れていた（`UNAUTHENTICATED`）とき、失敗を返す前に呼ぶ
    let onSignedOut: @Sendable () -> Void

    func call<Value: Decodable>(_ request: ApiRequest, as _: Value.Type = Value.self) async
        -> Result<Value, BackendError>
    {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest(request))
        } catch {
            return .failure(.unreachable)
        }
        guard let response = response as? HTTPURLResponse else { return .failure(.broken) }
        let result = Self.decode(Value.self, status: response.statusCode, body: data)
        if case .failure(.rejected(.unauthenticated)) = result { onSignedOut() }
        return result
    }

    /// 429（送りすぎ）を、Retry-After とともに失敗の1つとして返す（取り込みの束を待って送り直すため）。
    /// それ以外は `call` と同じ
    func callRetryingAfter<Value: Decodable>(_ request: ApiRequest, as _: Value.Type = Value.self) async
        -> Result<Value, ImportCallError>
    {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest(request))
        } catch {
            return .failure(.backend(.unreachable))
        }
        guard let response = response as? HTTPURLResponse else { return .failure(.backend(.broken)) }
        if response.statusCode == 429 {
            return .failure(.rateLimited(retryAfterMs: Self.retryAfterMs(response.value(forHTTPHeaderField: "Retry-After"))))
        }
        let result = Self.decode(Value.self, status: response.statusCode, body: data)
        if case .failure(.rejected(.unauthenticated)) = result { onSignedOut() }
        return result.mapError(ImportCallError.backend)
    }

    /// Retry-After（秒）をミリ秒にする。読めなければ 10 秒（Web と同じ）
    static func retryAfterMs(_ header: String?) -> Int {
        guard let seconds = header.flatMap(Double.init), seconds.isFinite, seconds > 0 else { return 10_000 }
        return Int(seconds * 1000)
    }

    private func urlRequest(_ request: ApiRequest) -> URLRequest {
        var urlRequest = URLRequest(url: AccountServer.url(server, path: request.path, query: request.query))
        urlRequest.httpMethod = request.method.rawValue
        if let token { urlRequest.setValue(token.authorization, forHTTPHeaderField: "Authorization") }
        if let body = request.body {
            urlRequest.httpBody = body
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return urlRequest
    }

    static func decode<Value: Decodable>(_: Value.Type, status: Int, body: Data) -> Result<Value, BackendError> {
        let decoder = JSONDecoder()
        guard (200..<300).contains(status) else {
            guard let error = try? decoder.decode(ApiErrorBody.self, from: body) else { return .failure(.broken) }
            return .failure(.rejected(error.error))
        }
        guard let value = try? decoder.decode(Value.self, from: body) else { return .failure(.broken) }
        return .success(value)
    }
}

/// 中身を読まない応答（ログアウトの `{ "success": true }` など）。JSON であることだけを確かめる
struct IgnoredBody: Decodable {
    init(from _: any Decoder) {}
}
