import NanaichiDomain

/// 現在のセッションを読み込む。自動終了の時刻を過ぎていれば、ここで閉じて「セッションなし」にする。
///
/// この端末の記録先には alarm がないので、セッションを読むすべてのワークフローがここを通り、
/// 読んだ時点で自動終了を記録に残す（GLOSSARY の「自動終了」）
public func loadOpenSession(_ store: some SessionStore, now: Instant) throws -> Session? {
    guard let session = try store.findOpenSession() else { return nil }
    switch session.stateAt(now) {
    case .ended(let ended):
        try store.closeSession(session.id, ended)
        return nil
    case .idle, .focus, .journal, .breakTime, .awaitingAdvance:
        return session
    }
}
