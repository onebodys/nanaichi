import Foundation
import NanaichiDomain
import Security
import Synchronization

/// アカウントのセッションのトークン（ADR 0029）。`Authorization: Bearer` に付ける。
/// 持っていればアカウントに繋がるので、ログやエラーに出さない（`Sensitive`）
public struct SessionToken: Hashable, Sendable {
    public let value: Sensitive<String>

    public init?(_ text: String) {
        guard !text.isEmpty else { return nil }
        value = Sensitive(text)
    }

    var authorization: String { "Bearer \(value.unwrap())" }
}

/// トークンの置き場所。アプリは Keychain（`KeychainTokenStore`）、テストはメモリに置く
public protocol TokenStore: Sendable {
    /// 置いてあるトークン。ログインしていなければ nil
    func load() throws(TokenStoreError) -> SessionToken?
    /// 置き換える
    func save(_ token: SessionToken) throws(TokenStoreError)
    /// 消す。置いていなくても成功する
    func delete() throws(TokenStoreError)
}

/// Keychain が断った。`status` は Security の `OSStatus`
public struct TokenStoreError: Error, Hashable, Sendable {
    public let status: OSStatus
}

/// Keychain の汎用パスワードにトークンを置く。この端末だけで使い（バックアップや別の端末へ移さない）、
/// 起動して一度ロックを解いたあとは、バックグラウンドの同期でも読める
public struct KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String

    public init(service: String = "app.nanaichi.session-token", account: String = "account") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // macOS でも iOS と同じ Keychain を使う。署名した（Keychain の entitlement がある）アプリでだけ使える
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    public func load() throws(TokenStoreError) -> SessionToken? {
        var found: CFTypeRef?
        let status = SecItemCopyMatching(
            query.merging([kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]) { $1 }
                as CFDictionary,
            &found)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw TokenStoreError(status: status) }
        guard let data = found as? Data else { throw TokenStoreError(status: errSecDecode) }
        return SessionToken(String(decoding: data, as: UTF8.self))
    }

    public func save(_ token: SessionToken) throws(TokenStoreError) {
        try delete()
        let attributes = query.merging([
            kSecValueData as String: Data(token.value.unwrap().utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]) { $1 }
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw TokenStoreError(status: status) }
    }

    public func delete() throws(TokenStoreError) {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw TokenStoreError(status: status) }
    }
}

/// メモリにトークンを置く。アプリを閉じると消える。署名していないビルド（CI の UI テストなど）は
/// Keychain を使えないので、そこではこれを使う
public final class InMemoryTokenStore: TokenStore {
    private let token: Mutex<SessionToken?>

    public init(_ token: SessionToken? = nil) {
        self.token = Mutex(token)
    }

    public func load() -> SessionToken? { token.withLock { $0 } }
    public func save(_ token: SessionToken) { self.token.withLock { $0 = token } }
    public func delete() { token.withLock { $0 = nil } }
}
