import NanaichiDomain

/// 現在のセッションのスナップショットを返す。
///
/// 想定内の失敗はない。セッションがなければ（自動終了の時刻を過ぎていた場合も）`noSession` を返す
public func getCurrentSession(_ store: some SessionStore, now: Instant) throws -> SessionSnapshot {
    let open = try loadOpenSession(store, now: now)
    let revision = try store.currentRevision()
    return open?.snapshot(at: now, revision: revision) ?? .noSession(serverTime: now, revision: revision)
}
