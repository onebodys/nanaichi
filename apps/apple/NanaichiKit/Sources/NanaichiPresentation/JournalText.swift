import NanaichiDomain

// タイムラインとジャーナルの見返しに出す文言。判断はせず、ドメインの値を言葉にするだけ（Web の journal-text.ts）

private let weekdays = ["月", "火", "水", "木", "金", "土", "日"]

/// 曜日（`土`）
public func weekdayTextOf(_ date: LocalDate) -> String { weekdays[date.weekdayFromMonday] }

/// カレンダーの見出しに並べる曜日。週は月曜に始まる
public let weekdayHeaders = weekdays

/// 日付の区切りの見出し（`10月17日（土）`）
public func dateTextOf(_ date: LocalDate) -> String { "\(date.month)月\(date.day)日（\(weekdayTextOf(date))）" }

/// ジャーナルのカレンダーの月（`2026年10月`）
public func monthTextOf(_ month: JournalMonth) -> String { "\(month.year)年\(month.month)月" }

/// 記入の数（`3件`）
public func entryCountLabelOf(_ count: Int) -> String { "\(count)件" }

/// ジャーナルのカレンダーの日の読み上げ（`10月20日（火） 記入3件`、記入がなければ `記入なし`）
public func calendarDayLabelOf(_ date: LocalDate, entries: Int) -> String {
    "\(dateTextOf(date)) \(entries == 0 ? "記入なし" : "記入\(entryCountLabelOf(entries))")"
}

/// 日付の区切りに出す、その日の完了セット数と集中時間（`完了 10セット · 集中 1時間10分`）
public func dayCompletedSetsTextOf(_ completedSets: DayCompletedSets) -> String {
    switch completedSets {
    case .counted(let count): completedSetsAndFocusTimeOf(count)
    case .notYetCounted: "完了セットは続きを読み込むと出ます"
    }
}

/// セッションの区切りの見出し（`13:05 からのセッション`）
public func daySessionTextOf(startedAt: Instant, timeZone: TimeZoneName) -> String {
    "\(timeTextOf(startedAt, timeZone: timeZone)) からのセッション"
}

/// セッションの区切りに添える、そのセッションのその日の積み上げ。完了セットがなければ出さない
public func daySessionStatsOf(_ completedSets: Int) -> String? {
    completedSets == 0 ? nil : completedSetsAndFocusTimeOf(completedSets)
}

/// 記入を書いたときのタイマーの状態（読み上げ用）
public func writtenDuringTextOf(_ writtenDuring: WrittenDuring) -> String {
    switch writtenDuring {
    case .focus(let round, let setNumber): "\(round)ラウンド目・\(setNumber)セット目・集中"
    case .journal(let round, let setNumber): "\(round)ラウンド目・\(setNumber)セット目・ジャーナル"
    case .breakTime(let round): "\(round)ラウンド目・休憩"
    case .idle(let round, let setNumber): "\(round)ラウンド目・\(setNumber)セット目・待機"
    }
}

/// 記入を書いたときのタイマーの状態を、バッジ用に短くしたもの（`2-1 ジャーナル`）
public func writtenDuringBadgeOf(_ writtenDuring: WrittenDuring) -> String {
    switch writtenDuring {
    case .focus(let round, let setNumber): "\(round)-\(setNumber) 集中"
    case .journal(let round, let setNumber): "\(round)-\(setNumber) ジャーナル"
    case .breakTime: "休憩"
    case .idle(let round, let setNumber): "\(round)-\(setNumber) 待機"
    }
}

/// 編集したことがある記入か（`編集済み` を添える）
public func isEdited(_ entry: JournalEntry) -> Bool { entry.updatedAt != entry.writtenAt }

/// タグの名前を `#` をつけて書く
public func tagTextOf(_ name: TagName) -> String { "#\(name.rawValue)" }

