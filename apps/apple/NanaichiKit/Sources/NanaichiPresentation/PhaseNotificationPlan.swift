import NanaichiDomain

/// 前もって予約しておく、フェーズの切り替わりの通知
public struct PlannedPhaseNotification: Hashable, Sendable {
    /// 予約の ID。同じセッションの同じ時刻の切り替わりは同じ ID になる
    public let identifier: String
    public let at: Instant
    public let to: Phase
    public let title: String
    public let body: String
}

/// 予約の ID の頭。予約し直すときに、前の予約だけを見分けて消す
public let phaseNotificationIdentifierPrefix = "phase-change."

/// 一度に予約しておく通知の数の上限。自動終了までの2ラウンドで切り替わりは13回なので、ふつうは届かない。
/// iOS は1つのアプリにつき64件までしか予約を残さないので、それに合わせる
public let maxPlannedPhaseNotifications = 64

/// スナップショット `snapshot` のセッションで、記録先の時刻 `now` から先に予約しておく通知（ADR 0003）。
///
/// 切り替わりは操作イベントから計算できるので、画面を開いていなくても届くよう前もって予約する。
/// スナップショットが替わるたびに（人の操作・記入・進め方の変更）予約し直す。人の操作で移ったときは
/// 本人が押したので知らせない（GLOSSARY の「フェーズの切り替わり」）が、それは予約が操作の時刻より先の
/// 切り替わりだけを含むことで守られる。手動の切り替わりでは切り替え待ちになるときに知らせ、その先は予約しない
public func phaseNotificationPlanOf(_ snapshot: SessionSnapshot, now: Instant, settings: AlertSettings)
    -> [PlannedPhaseNotification]
{
    guard settings.notification, case .session(_, let session, _) = snapshot else { return [] }
    return session.upcomingPhaseChanges(after: now, limit: maxPlannedPhaseNotifications).map { change in
        let message = phaseChangeMessageOf(change.to)
        return PlannedPhaseNotification(
            identifier: "\(phaseNotificationIdentifierPrefix)\(session.id.rawValue).\(change.at.milliseconds)",
            at: change.at, to: change.to, title: message.title, body: message.body)
    }
}
