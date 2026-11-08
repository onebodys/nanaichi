import CryptoKit
import Foundation
import NanaichiDomain

/// PKCE（RFC 7636）の code_verifier と、その S256 の code_challenge。
/// verifier はアプリから出さず、challenge だけをログインの入口に送る（ADR 0029）
public struct PKCE: Hashable, Sendable {
    /// ログや `dump` に出さないよう包む。送るときだけ `unwrap()` で取り出す
    public let verifier: Sensitive<String>

    /// verifier は unreserved の文字（`A-Z a-z 0-9 - . _ ~`）で 43〜128 文字
    public init?(verifier: String) {
        let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        guard (43...128).contains(verifier.count), verifier.allSatisfy(unreserved.contains) else { return nil }
        self.verifier = Sensitive(verifier)
    }

    /// 32 バイトの乱数を base64url にした 43 文字の verifier。ログインを始めるたびに作り直す
    public static func random() -> PKCE {
        var generator = SystemRandomNumberGenerator()
        let bytes = Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        guard let pkce = PKCE(verifier: base64URL(bytes)) else { preconditionFailure("乱数の verifier が形に合わない") }
        return pkce
    }

    /// `BASE64URL(SHA256(ASCII(verifier)))`
    public var challenge: String { base64URL(Data(SHA256.hash(data: Data(verifier.unwrap().utf8)))) }
}

private func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// ログインを終えたブラウザがアプリに戻すコード。60 秒のうちに1回だけ引き換えられる
public struct SignInCode: Hashable, Sendable {
    /// ログや `dump` に出さないよう包む。送るときだけ `unwrap()` で取り出す
    public let rawValue: Sensitive<String>

    public init(rawValue: String) { self.rawValue = Sensitive(rawValue) }
}

/// ログインできなかった理由（`nanaichi://auth/callback?error=…`）
public enum SignInFailure: String, Hashable, Sendable {
    /// 許可リストに載っていない
    case emailNotAllowed = "EMAIL_NOT_ALLOWED"
    /// それ以外。理由は区別しない
    case signInFailed = "SIGN_IN_FAILED"
}

/// アプリに戻ってきたログインの結果
public enum SignInCallback: Hashable, Sendable {
    case code(SignInCode)
    case failed(SignInFailure)
}

/// ネイティブアプリのログイン（ADR 0029）。ブラウザを開くこと（`ASWebAuthenticationSession`）は画面に任せ、
/// その前後のURLとトークンの引き換えをここで行う。
///
/// 1. `PKCE.random()` を作り、`startURL(_:)` を `ASWebAuthenticationSession` で開く（`callbackScheme` で戻り、
///    `prefersEphemeralWebBrowserSession = true`）
/// 2. 戻ってきた URL を `callback(_:)` で読む
/// 3. コードなら `exchange(_:pkce:)` でトークンに引き換える。`rejected(.invalidGrant)` なら、
///    同じコードで引き換え直さず、新しい `PKCE` で 1 からやり直す
public struct NativeSignIn: Sendable {
    /// ブラウザがアプリに戻すカスタム URL スキーム。Info.plist の `CFBundleURLTypes` に登録する
    public static let callbackScheme = "nanaichi"

    private let server: URL
    private let session: URLSession

    public init(server: URL = AccountServer.production, session: URLSession = .shared) {
        self.server = server
        self.session = session
    }

    /// ログインの入口（`GET /api/native-auth/start`）
    public func startURL(_ pkce: PKCE) -> URL {
        AccountServer.url(
            server, path: ["native-auth", "start"],
            query: [("code_challenge", pkce.challenge), ("code_challenge_method", "S256")])
    }

    /// `nanaichi://auth/callback?code=…` か `?error=…` を読む。ログインの戻り先でない URL なら nil。
    /// 知らない `error` と、コードもエラーもない戻り先は `signInFailed` にする
    public static func callback(_ url: URL) -> SignInCallback? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme == callbackScheme, components.host == "auth", components.path == "/callback"
        else { return nil }
        let items = components.queryItems ?? []
        if let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty {
            return .code(SignInCode(rawValue: code))
        }
        let error = items.first { $0.name == "error" }?.value
        return .failed(error.flatMap(SignInFailure.init(rawValue:)) ?? .signInFailed)
    }

    /// コードを、そのログインを始めた `pkce` と一緒にトークンへ引き換える（`POST /api/native-auth/token`）
    public func exchange(_ code: SignInCode, pkce: PKCE) async -> Result<SessionToken, BackendError> {
        let api = ApiClient(server: server, session: session, token: nil, onSignedOut: {})
        let request = ApiRequest.send(
            .post, "native-auth", "token", json: ExchangeBody(code: code.rawValue.unwrap(), codeVerifier: pkce.verifier.unwrap()))
        return await api.call(request, as: TokenBody.self).flatMap { body in
            SessionToken(body.token).map(Result.success) ?? .failure(.broken)
        }
    }

    /// ログアウトする（`POST /api/auth/sign-out`）。サーバーのセッションを消し、このトークンは使えなくなる。
    /// 結果にかかわらず、アプリは手元のトークンを消す（届かなくても、トークンは 7 日で切れる）
    public func signOut(_ token: SessionToken) async -> Result<Void, BackendError> {
        let api = ApiClient(server: server, session: session, token: token, onSignedOut: {})
        return await api.call(.send(.post, "auth", "sign-out"), as: IgnoredBody.self).map { _ in () }
    }
}

private struct ExchangeBody: Encodable {
    let code: String
    let codeVerifier: String

    enum CodingKeys: String, CodingKey {
        case code
        case codeVerifier = "code_verifier"
    }
}

private struct TokenBody: Decodable {
    let token: String
}
