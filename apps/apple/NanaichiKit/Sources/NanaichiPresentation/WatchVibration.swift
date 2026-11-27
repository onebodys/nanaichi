import NanaichiDomain

/// Watch がフェーズの切り替わりを自分の振動で知らせる範囲（Issue #73、ADR 0033）。Watch が決めて iPhone に伝える。
///
/// iPhone の通知は、iPhone を使っていないあいだ Watch に転送される。Watch も振動で知らせると、手首に二重に届く。
/// そこで切り替わりの時刻で、どちらが知らせるかを分ける。範囲の中の切り替わりは Watch が振動で知らせ、
/// iPhone はその通知を予約しない。範囲の外は iPhone の通知（Watch に転送される）が知らせる。
/// 範囲には期限があるので、Watch が `off` を伝えられないまま止まっても、期限が過ぎれば iPhone の通知に戻る
public enum WatchVibration: Hashable, Sendable, Codable {
    /// Watch は振動で知らせない
    case off
    /// 記録先の時刻で `before` より前の切り替わりは、Watch が振動で知らせる
    case covering(before: Instant)

    /// 記録先の時刻 `at` の切り替わりを、Watch が振動で知らせるか
    public func covers(_ at: Instant) -> Bool {
        switch self {
        case .off: false
        case .covering(let before): at < before
        }
    }
}

/// 一度に伝える範囲の長さ。Watch が `off` を伝えられずに止まっても、知らせが途切れるのはこの長さまで
let watchVibrationLeaseMs: Int64 = 15 * 60_000
/// 範囲の残りがこれより短くなったら伸ばす
let watchVibrationRenewalMs: Int64 = 10 * 60_000
/// Watch が振動できる（拡張ランタイムセッションが動いている）のが終わる時刻より、範囲をこれだけ手前で閉じる。
/// 終わりぎわの切り替わりを、止まりかけの Watch に任せない
let watchVibrationEndMarginMs: Int64 = 30_000

/// Watch が iPhone に伝え直す範囲。伝え直さなくてよければ nil。
///
/// - `confirmed`: iPhone が受け取ったと答えた範囲
/// - `vibratableUntil`: Watch が振動できるのが、記録先の時刻でいつまでか。振動できなければ nil
/// - `now`: 記録先の時刻
public func watchVibrationToTell(confirmed: WatchVibration, vibratableUntil: Instant?, now: Instant) -> WatchVibration? {
    let closesAt = vibratableUntil?.adding(milliseconds: -watchVibrationEndMarginMs)
    guard let closesAt, closesAt > now else {
        // 振動できないので、まだ範囲が残っていれば閉じる
        return confirmed.covers(now) ? .off : nil
    }
    let wanted = min(now.adding(milliseconds: watchVibrationLeaseMs), closesAt)
    switch confirmed {
    case .off:
        return .covering(before: wanted)
    case .covering(let before):
        // 振動できなくなる時刻より先まで任せているなら縮める。残りが短ければ伸ばす
        let overruns = before > closesAt
        let runningOut = before.milliseconds(since: now) < watchVibrationRenewalMs && wanted > before
        return overruns || runningOut ? .covering(before: wanted) : nil
    }
}

/// Watch が刻みごとに、振動で知らせる切り替わりを見つける（Issue #73）。
///
/// 知らせるのは、iPhone が通知を予約するのと同じ切り替わり（`upcomingPhaseChanges`）のうち、範囲の中のもの。
/// iPhone は範囲の外だけを予約するので、1回の切り替わりで知らせは1回になる。
/// セッションの記録が替わった刻みでは知らせない。人の操作で移ったときは本人が押したのでわかる（GLOSSARY の「フェーズの切り替わり」）。
/// 記録が同じまま時刻だけが違うスナップショット（読み込み直し）に替わったときは、前の刻みから続けて調べる
public struct PhaseChangeVibration: Sendable {
    private var checked: (session: Session, at: Instant)?

    public init() {}

    /// 前の刻みから記録先の時刻 `now` までに起きた切り替わりのうち、範囲 `vibration` の中のものがあれば、
    /// 移った先のフェーズを返す。いくつもあれば（刻みが遅れた）、最後のものだけを返して1回だけ知らせる
    public mutating func observe(_ snapshot: SessionSnapshot?, now: Instant, within vibration: WatchVibration) -> Phase? {
        guard case .session(_, _, let session, _) = snapshot else {
            checked = nil
            return nil
        }
        defer { checked = (session, now) }
        guard let checked, checked.session == session else { return nil }
        return Self.last(of: session, after: checked.at, through: now) { vibration.covers($0) }
    }

    /// iPhone が、範囲を `previous` から `vibration` に替えると受け取ったと答えた。範囲を頼んだ記録先の時刻 `since` から
    /// 前の刻みまでの切り替わりのうち、前の範囲になく新しい範囲にあるものを返す（最後のものだけ）。
    /// iPhone はその通知を答える前に消しているが、答えを待つあいだ Watch は前の範囲で見ていたので、まだ誰も知らせていない。
    /// 消す前に iPhone の通知が出ていれば二重になるが、抜けるよりよい（ADR 0033）
    public func widened(from previous: WatchVibration, to vibration: WatchVibration, since: Instant) -> Phase? {
        guard let checked else { return nil }
        return Self.last(of: checked.session, after: since, through: checked.at) {
            vibration.covers($0) && !previous.covers($0)
        }
    }

    private static func last(of session: Session, after: Instant, through: Instant, where included: (Instant) -> Bool)
        -> Phase?
    {
        session.upcomingPhaseChanges(after: after, limit: maxPlannedPhaseNotifications)
            .last { $0.at <= through && included($0.at) }?.to
    }
}
