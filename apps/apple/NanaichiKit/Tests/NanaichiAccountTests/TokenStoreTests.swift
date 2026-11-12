import Foundation
import Security
import Testing

@testable import NanaichiAccount

/// Keychain（Data Protection Keychain）は、Keychain の entitlement のある署名したアプリでだけ使える。
/// `swift test` のテストのプロセスにはないので、使えないときは確かめない
private let keychainAvailable: Bool = {
    let store = KeychainTokenStore(service: "app.nanaichi.test.probe")
    do {
        try store.save(token)
        try store.delete()
        return true
    } catch {
        return false
    }
}()

private func roundTrip(_ store: some TokenStore) throws {
    try store.delete()
    #expect(try store.load() == nil)
    try store.save(token)
    #expect(try store.load() == token)
    let renewed = try #require(SessionToken("token-456"))
    try store.save(renewed)
    #expect(try store.load() == renewed)
    try store.delete()
    #expect(try store.load() == nil)
    try store.delete()
}

@Suite("トークンの置き場所")
struct TokenStoreTests {
    @Test("置いたトークンを読み、置き換え、消せる（メモリ）")
    func inMemory() throws {
        try roundTrip(InMemoryTokenStore())
    }

    @Test("置いたトークンを読み、置き換え、消せる（Keychain）", .enabled(if: keychainAvailable))
    func keychain() throws {
        try roundTrip(KeychainTokenStore(service: "app.nanaichi.test.\(UUID().uuidString)"))
    }
}
