import AppKit
import AuthenticationServices
import NanaichiAccount
import NanaichiDomain

/// ログインしているときの記録先（GLOSSARY の「アカウント」）と、その後始末
struct SignedIn {
    let backend: any Backend
    /// タスクと ToDo の設定。アカウントの記録先にだけある（ADR 0026）
    let tasks: any TaskBackend
    let user: @Sendable () async -> Result<AccountUser, BackendError>
    /// この Mac の記録の束をアカウントへ取り込む（ADR 0020）
    let sendImportBatch: @Sendable (ImportBatch) async -> Result<ImportReceipt, ImportCallError>
    /// ログアウトする。サーバーのセッションを消し（届かなくても）、手元のトークンを消し、同期を閉じる
    let signOut: @Sendable () async -> Void
    /// ログインが切れていた。手元のトークンを消し、同期を閉じる
    let forget: @Sendable () async -> Void
}

/// 起動したときに、置いてあるトークンから記録先を決めた結果
enum RestoredAccount {
    case signedOut
    case signedIn(SignedIn)
    /// トークンの置き場所を読めなかった。画面に出す文言
    case unreadable(String)
}

/// ログインを試した結果
enum SignInResult {
    case signedIn(SignedIn)
    /// ログインの画面を閉じた。何も出さない
    case cancelled
    /// 画面に出す文言
    case failed(String)
}

/// ログインとトークンの置き場所。リリースのビルドは Google と Keychain を使う。
/// `onExpired` は、その記録先でログインが切れていた（401）ときに呼ばれる。何回呼ばれてもよい
struct AccountGateway {
    let restore: (_ onExpired: @escaping @Sendable () -> Void) -> RestoredAccount
    let signIn: @MainActor (_ onExpired: @escaping @Sendable () -> Void) async -> SignInResult
}

extension AccountGateway {
    /// Keychain の項目の名前（ADR 0029 の「アプリはトークンを Keychain に置く」）
    static let keychainService = "app.nanaichi.mac"

    /// 本番のサーバーにログインし、トークンを `tokens` に置く。
    /// 記録先の時計のずれは、画面と同じ時計 `clock` で測る
    static func live(clock: AppClock, tokens: any TokenStore) -> AccountGateway {
        let nativeSignIn = NativeSignIn()

        @Sendable func signedIn(_ token: SessionToken, onExpired: @escaping @Sendable () -> Void) -> SignedIn {
            let backend = AccountBackend(token: token, clock: clock.now, onSignedOut: onExpired)
            return SignedIn(
                backend: backend,
                tasks: backend,
                user: { await backend.getMe() },
                sendImportBatch: { await backend.sendImportBatch($0) },
                signOut: {
                    // 届かなくてもトークンは 7 日で切れるので、結果にかかわらず手元のトークンを消す（ADR 0029）
                    _ = await nativeSignIn.signOut(token)
                    try? tokens.delete()
                    await backend.close()
                },
                forget: {
                    try? tokens.delete()
                    await backend.close()
                })
        }

        return AccountGateway(
            restore: { onExpired in
                do {
                    return try tokens.load().map { .signedIn(signedIn($0, onExpired: onExpired)) } ?? .signedOut
                } catch {
                    return .unreadable("ログインの情報を Keychain から読めなかったので、この Mac の記録で開きました。")
                }
            },
            signIn: { onExpired in
                // ログインを始めるたびに作り直す。INVALID_GRANT のあとも、同じコードで引き換え直さずここからやり直す
                let pkce = PKCE.random()
                switch await WebAuthentication().open(nativeSignIn.startURL(pkce)) {
                case .cancelled: return .cancelled
                case .unavailable: return .failed("ログインの画面を開けませんでした。")
                case .returned(let url):
                    switch NativeSignIn.callback(url) {
                    case .code(let code):
                        switch await nativeSignIn.exchange(code, pkce: pkce) {
                        case .success(let token):
                            do {
                                try tokens.save(token)
                            } catch {
                                // 置けなければ次に開いたときにログインしていないので、サーバーのセッションも残さない
                                _ = await nativeSignIn.signOut(token)
                                return .failed("ログインの情報を Keychain に保存できませんでした。")
                            }
                            return .signedIn(signedIn(token, onExpired: onExpired))
                        case .failure(let error): return .failed(exchangeFailureMessageOf(error))
                        }
                    case .failed(.emailNotAllowed): return .failed("このメールアドレスでは登録できません。")
                    case .failed(.signInFailed), nil: return .failed("ログインできませんでした。")
                    }
                }
            })
    }
}

/// コードをトークンに引き換えられなかったときの文言
private func exchangeFailureMessageOf(_ error: BackendError) -> String {
    switch error {
    case .unreachable: "通信できませんでした。もう一度お試しください。"
    case .rejected(.invalidGrant): "ログインの期限が切れました。もう一度ログインしてください。"
    case .rejected(.rateLimited): "ログインを続けて試しすぎました。1分ほど待ってからお試しください。"
    case .rejected, .storageFailed, .broken: "ログインできませんでした。"
    }
}

/// ブラウザを開いた結果
private enum WebAuthenticationResult {
    case returned(URL)
    case cancelled
    case unavailable
}

/// `ASWebAuthenticationSession` で、ログインの入口を開き、`nanaichi://` に戻るのを待つ（ADR 0029）。
/// Safari とは cookie を分け、ログインの流れで作ったセッションを Safari に残さない
@MainActor
private final class WebAuthentication: NSObject, ASWebAuthenticationPresentationContextProviding {
    /// 開いている間は持っておく（離すとログインの画面が閉じる）
    private var session: ASWebAuthenticationSession?

    func open(_ url: URL) async -> WebAuthenticationResult {
        await withCheckedContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url, callback: .customScheme(NativeSignIn.callbackScheme)
            ) { callback, error in
                if let callback {
                    continuation.resume(returning: .returned(callback))
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(returning: .cancelled)
                } else {
                    continuation.resume(returning: .unavailable)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            self.session = session
            // 始められなかったときは完了の処理が呼ばれない
            if !session.start() { continuation.resume(returning: .unavailable) }
        }
    }

    nonisolated func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { NSApp.keyWindow ?? NSApp.mainWindow ?? ASPresentationAnchor() }
    }
}
