import Foundation
import Testing

@testable import NanaichiAccount
@testable import NanaichiDomain

@Suite("ネイティブアプリのログイン")
struct NativeSignInTests {
    @Test("code_challenge は code_verifier の SHA-256 を base64url にしたもの（RFC 7636 の付録 B）")
    func challenge() throws {
        let pkce = try #require(PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test("作るたびに違う、43 文字の code_verifier を作る")
    func random() {
        let first = PKCE.random()
        let second = PKCE.random()
        #expect(first.verifier.count == 43)
        #expect(PKCE(verifier: first.verifier) == first)
        #expect(first != second)
        #expect(first.challenge.count == 43)
    }

    @Test(
        "code_verifier は unreserved の文字で 43〜128 文字",
        arguments: [
            (String(repeating: "a", count: 42), false), (String(repeating: "a", count: 43), true),
            (String(repeating: "a", count: 128), true), (String(repeating: "a", count: 129), false),
            (String(repeating: "a", count: 42) + "+", false), (String(repeating: "a", count: 39) + "-._~", true),
        ])
    func verifier(_ text: String, _ valid: Bool) {
        #expect((PKCE(verifier: text) != nil) == valid)
    }

    @Test("ログインの入口は challenge と S256 をクエリに付ける")
    func startURL() throws {
        let pkce = try #require(PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        #expect(
            NativeSignIn().startURL(pkce).absoluteString
                == "https://nanaichi.app/api/native-auth/start?code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
        )
    }

    @Test(
        "アプリに戻ってきた URL から、コードかログインできなかった理由を読む",
        arguments: [
            ("nanaichi://auth/callback?code=abc_123", SignInCallback?.some(.code(SignInCode(rawValue: "abc_123")))),
            ("nanaichi://auth/callback?error=EMAIL_NOT_ALLOWED", .failed(.emailNotAllowed)),
            ("nanaichi://auth/callback?error=SIGN_IN_FAILED", .failed(.signInFailed)),
            ("nanaichi://auth/callback?error=SOMETHING_NEW", .failed(.signInFailed)),
            ("nanaichi://auth/callback", .failed(.signInFailed)),
            ("nanaichi://auth/callback?code=", .failed(.signInFailed)),
            ("nanaichi://other?code=abc", nil),
            ("https://nanaichi.app/auth/callback?code=abc", nil),
        ])
    func callback(_ url: String, _ expected: SignInCallback?) throws {
        #expect(NativeSignIn.callback(try #require(URL(string: url))) == expected)
    }

    @Test("コードと code_verifier を送ってトークンに引き換える。トークンはまだないので Bearer は付けない")
    func exchange() async throws {
        let stub = StubServer(.text(200, #"{"token":"signed.token"}"#))
        let pkce = PKCE.random()

        let result = await NativeSignIn(server: server, session: stub.session).exchange(
            SignInCode(rawValue: "the-code"), pkce: pkce)

        #expect(result == .success(SessionToken("signed.token")!))
        let request = try #require(stub.requests.only)
        #expect(request.method == "POST")
        #expect(request.path == "/api/native-auth/token")
        #expect(request.headers["Authorization"] == nil)
        #expect(
            request.body.flatMap(canonicalJSON)
                == canonicalJSON(#"{"code":"the-code","code_verifier":"\#(pkce.verifier)"}"#))
    }

    @Test("使えないコードは INVALID_GRANT で断られる（新しい code_verifier でログインし直す）")
    func invalidGrant() async {
        let stub = StubServer(.text(400, #"{"error":"INVALID_GRANT"}"#))
        let result = await NativeSignIn(server: server, session: stub.session).exchange(
            SignInCode(rawValue: "used"), pkce: .random())
        #expect(result == .failure(.rejected(.invalidGrant)))
    }

    @Test("引き換えの応答に使えるトークンがなければ broken、届かなければ unreachable")
    func exchangeFailures() async {
        let empty = StubServer(.text(200, #"{"token":""}"#))
        let offline = StubServer(.unreachable)
        let code = SignInCode(rawValue: "c")
        #expect(
            await NativeSignIn(server: server, session: empty.session).exchange(code, pkce: .random())
                == .failure(.broken))
        #expect(
            await NativeSignIn(server: server, session: offline.session).exchange(code, pkce: .random())
                == .failure(.unreachable))
    }

    @Test("ログアウトはトークンを Bearer に付けて送る")
    func signOut() async throws {
        let stub = StubServer(.text(200, #"{"success":true}"#))

        let result = await NativeSignIn(server: server, session: stub.session).signOut(token)

        #expect((try? result.get()) != nil)
        let request = try #require(stub.requests.only)
        #expect(request.method == "POST")
        #expect(request.path == "/api/auth/sign-out")
        #expect(request.headers["Authorization"] == "Bearer token-123")
        #expect(request.body == nil)
    }

    @Test("トークンは文字列にしても伏せる")
    func tokenIsRedacted() {
        #expect("\(token)".contains("token-123") == false)
    }
}
