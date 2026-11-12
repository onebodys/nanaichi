/// これから時間が過ぎて起きるフェーズの切り替わり（GLOSSARY の「フェーズの切り替わり」）。
/// `to` は移る先のフェーズ。手動の切り替わりでは、切り替え待ちになる時刻と、そのあと進めれば始まるフェーズ
public struct UpcomingPhaseChange: Hashable, Sendable {
    public let at: Instant
    public let to: Phase

    public init(at: Instant, to: Phase) {
        self.at = at
        self.to = to
    }
}

extension Session {
    /// 時刻 `now` から先、人が何も操作しなければ起きるフェーズの切り替わりを、早い順に `limit` 件まで。
    ///
    /// 通知を前もって予約するのに使う（ADR 0003）。切り替わりの時刻はどれも記録済みの操作イベントから
    /// 計算できるので、画面を開いていなくても届く。次の場合はそこで止まる:
    ///
    /// - 一時停止中・待機中・切り替え待ち: 人が操作するまで時計が進まない
    /// - 手動の切り替わり: 切り替え待ちになる1件を含め、その先は人が進めるまで決まらない（ADR 0016）
    /// - 自動終了: 記入も操作もないまま過ぎれば、その先のフェーズは来ない
    public func upcomingPhaseChanges(after now: Instant, limit: Int) -> [UpcomingPhaseChange] {
        var changes: [UpcomingPhaseChange] = []
        var previous = stateAt(now)
        while changes.count < limit, let endsAt = runningEndOf(previous) {
            let current = stateAt(endsAt)
            guard case .phaseChanged(let to) = phaseChangeBetween(previous, current) else { break }
            changes.append(UpcomingPhaseChange(at: endsAt, to: to))
            previous = current
        }
        return changes
    }
}

/// 時計が進んでいるフェーズの終わる時刻。止まっている・フェーズにいなければ nil
private func runningEndOf(_ state: TimerState) -> Instant? {
    guard let inPhase = InPhase(state) else { return nil }
    switch inPhase.clock {
    case .running(let endsAt): return endsAt
    case .paused: return nil
    }
}
