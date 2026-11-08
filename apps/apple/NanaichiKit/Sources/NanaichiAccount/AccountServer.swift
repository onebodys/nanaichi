import Foundation

/// アカウントの記録先（UserDO）を置くサーバー
public enum AccountServer {
    /// 本番（ADR 0021 の正規の origin）
    public static let production: URL = {
        guard let url = URL(string: "https://nanaichi.app") else { preconditionFailure("本番の URL が URL として読めない") }
        return url
    }()

    /// 同期の WebSocket（`GET /api/ws`、ADR 0012）。https のサーバーなら wss、http（開発）なら ws
    static func syncURL(_ server: URL) -> URL {
        url(server, scheme: server.scheme == "http" ? "ws" : "wss", path: ["ws"], query: [])
    }

    /// `server` の `/api/<path>?<query>`。パスの各部分とクエリの値は JS の `encodeURIComponent` と同じく符号化する。
    /// `URLQueryItem` は `+` を符号化せず、サーバーは `+` を空白と読むので使わない（`Etc/GMT+9` が壊れる）
    static func url(_ server: URL, scheme: String? = nil, path: [String], query: [(String, String)]) -> URL {
        guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else {
            preconditionFailure("サーバーの URL が URL として読めない: \(server)")
        }
        if let scheme { components.scheme = scheme }
        components.percentEncodedPath = "/api/" + path.map(encodeURIComponent).joined(separator: "/")
        components.percentEncodedQuery =
            query.isEmpty ? nil : query.map { "\(encodeURIComponent($0))=\(encodeURIComponent($1))" }.joined(separator: "&")
        guard let url = components.url else { preconditionFailure("API の URL を作れない: \(components)") }
        return url
    }
}

private let uriComponentCharacters = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

func encodeURIComponent(_ text: String) -> String {
    // Swift の String は正しい Unicode なので、符号化に失敗することはない
    guard let encoded = text.addingPercentEncoding(withAllowedCharacters: uriComponentCharacters) else {
        preconditionFailure("URL の部分として符号化できない")
    }
    return encoded
}
