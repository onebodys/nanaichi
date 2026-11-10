import NanaichiDomain

public typealias ChangeAdvanceModeStore = SessionStore & AdvanceModeStore

/// 変えた結果
public enum AdvanceModeChangeResult: Hashable, Sendable {
    /// 新しい進め方を記録した。`snapshot` は変えたあとの現在のセッション（進め方が状態を変えうる）
    case changed(AdvanceMode, snapshot: SessionSnapshot)
    /// いまと同じ進め方だったので、何も記録していない
    case unchanged(AdvanceMode)

    public var mode: AdvanceMode {
        switch self {
        case .changed(let mode, _), .unchanged(let mode): mode
        }
    }
}

/// フェーズの進め方を変える（GLOSSARY の「フェーズの進め方」、ADR 0016）。
///
/// いまの進め方の読み込み → 同じなら何もしない → 変更の記録 → 変えたあとの現在のセッションの読み込み。
/// セッションの途中でも、変えた時刻から効く。想定内の失敗はない
public func changeAdvanceMode(_ store: some ChangeAdvanceModeStore, to mode: AdvanceMode, now: Instant) throws
    -> AdvanceModeChangeResult
{
    let current = try getAdvanceMode(store, now: now)
    if current == mode { return .unchanged(current) }
    try store.saveAdvanceModeChange(AdvanceModeChange(at: now, mode: mode))
    return .changed(mode, snapshot: try getCurrentSession(store, now: now))
}
