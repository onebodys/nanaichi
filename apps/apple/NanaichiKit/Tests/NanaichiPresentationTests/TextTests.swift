import Foundation
import NanaichiDomain
import Testing

@testable import NanaichiPresentation

private func date(_ key: String) -> LocalDate { LocalDate(key: key)! }

// MARK: - タイムラインの文言

@Test("日付の区切りの見出しに曜日を添える")
func dateTexts() {
    #expect(dateTextOf(date("2026-10-17")) == "10月17日（土）")
    #expect(dateTextOf(date("2026-10-19")) == "10月19日（月）")
    #expect(monthTextOf(JournalMonth(year: 2026, month: 10)!) == "2026年10月")
    #expect(weekdayHeaders == ["月", "火", "水", "木", "金", "土", "日"])
}

@Test("日付の区切りに、その日の完了セット数と集中時間を出す。数が確定しない日はそう伝える")
func dayCompletedSetsTexts() {
    #expect(dayCompletedSetsTextOf(.counted(10)) == "完了 10セット · 集中 1時間10分")
    #expect(dayCompletedSetsTextOf(.notYetCounted) == "完了セットは続きを読み込むと出ます")
    #expect(daySessionStatsOf(0) == nil)
    #expect(daySessionStatsOf(4) == "完了 4セット · 集中 28分")
}

@Test("セッションの区切りは開始の時刻で呼ぶ")
func daySessionText() {
    #expect(daySessionTextOf(startedAt: t0, timeZone: tokyo) == "\(timeTextOf(t0, timeZone: tokyo)) からのセッション")
}

@Test("記入を書いたときの状態をバッジでは短く、読み上げでは長く言う")
func writtenDuringTexts() {
    #expect(writtenDuringBadgeOf(.journal(round: 2, setNumber: 1)) == "2-1 ジャーナル")
    #expect(writtenDuringBadgeOf(.breakTime(round: 1)) == "休憩")
    #expect(writtenDuringTextOf(.idle(round: 1, setNumber: 3)) == "1ラウンド目・3セット目・待機")
    #expect(writtenDuringTextOf(.focus(round: 1, setNumber: 2)) == "1ラウンド目・2セット目・集中")
}

@Test("ジャーナルのカレンダーの日の読み上げに記入の数を添える")
func calendarDayLabels() {
    #expect(calendarDayLabelOf(date("2026-10-20"), entries: 3) == "10月20日（火） 記入3件")
    #expect(calendarDayLabelOf(date("2026-10-20"), entries: 0) == "10月20日（火） 記入なし")
}

@Test("タグの上限を超える記入と、削除された記入の失敗を言い分ける")
func entryErrors() {
    #expect(writeErrorMessageOf(.rejected(.tagLimitExceeded)) == "タグは20種類までです。使っていないタグを外してください。")
    #expect(entryChangeErrorMessageOf(.rejected(.journalEntryNotFound)) == "この記入は削除されています。")
    #expect(tagDeletionErrorMessageOf(.rejected(.tagNotFound)) == "そのタグはもう使われていません。一覧を読み込み直しました。")
}

// MARK: - スタッツの文言

private func active(completed: Int, aborted: Int = 0, withEntry: Int = 0, comparison: String) throws -> ActiveStats {
    let json = """
        {"kind":"Active","completedSets":\(completed),"abortedSets":\(aborted),"comparison":\(comparison),
         "entries":3,"completedSetsWithEntry":\(withEntry),"trend":{"kind":"None"},"tags":[],
         "hours":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}
        """
    guard case .active(let active) = try JSONDecoder().decode(StatsActivity.self, from: Data(json.utf8)) else {
        throw CancellationError()
    }
    return active
}

private func compared(_ previous: Int) -> String { #"{"kind":"Compared","previousCompletedSets":\#(previous)}"# }
private let notCompared = #"{"kind":"NotCompared"}"#

@Test("前の期間の同じ時点と集中時間を比べる。比べられない期間には出さない")
func comparisonTexts() throws {
    let more = try active(completed: 12, comparison: compared(4))
    #expect(comparisonTextOf(.week, more) == "先週の同じ時点より +56分")
    #expect(focusTimeNoteOf(.week, more) == "12セット · 先週の同じ時点より +56分")
    #expect(comparisonTextOf(.today, try active(completed: 1, comparison: compared(3))) == "昨日の同じ時刻より −14分")
    #expect(comparisonTextOf(.month, try active(completed: 3, comparison: compared(3))) == "先月の同じ時点と同じ")
    let all = try active(completed: 3, comparison: notCompared)
    #expect(comparisonTextOf(.all, all) == nil)
    #expect(focusTimeNoteOf(.all, all) == "3セット")
}

@Test("完了率と記入率を百分率で出し、もとになる数がなければ — にする")
func rateTexts() throws {
    let stats = try active(completed: 7, aborted: 1, withEntry: 6, comparison: notCompared)
    #expect(completionRateTextOf(stats) == "88%")
    #expect(entryRateTextOf(stats) == "86%")
    let none = try active(completed: 0, comparison: notCompared)
    #expect(completionRateTextOf(none) == "—")
    #expect(entryRateTextOf(none) == "—")
}

@Test("この12週間の濃さは1ラウンドごとに1段濃くなる")
func heatLevels() {
    #expect([0, 1, 2, 3, 5, 6, 8, 9, 30].map(heatLevelOf) == [0, 1, 1, 2, 2, 3, 3, 4, 4])
}

@Test("いちばん集中した時間帯は、同じなら早い時間。完了セットがなければ出さない")
func peakHours() {
    var hours = Array(repeating: 0, count: 24)
    #expect(peakHourTextOf(hours) == nil)
    hours[9] = 2
    hours[14] = 2
    #expect(peakHourTextOf(hours) == "9時台")
}

@Test("期間の名前と、記録がないときの見出しを期間ごとに言い分ける")
func periodTexts() {
    #expect(StatsPeriod.allCases.map(periodTextOf) == ["今日", "週", "月", "すべて"])
    #expect(noActivityTitleOf(.week) == "今週の記録はまだありません")
    #expect(noActivityTitleOf(.all) == "まだ記録がありません")
}

@Test("日ごとの集中の目盛りは、週は曜日、月は1日と7日おき")
func trendAxis() {
    #expect(trendDayAxisTextOf(date("2026-10-19"), dense: false) == "月")
    #expect(
        (1...9).map { trendDayAxisTextOf(date("2026-10-0\($0)"), dense: true) } == [
            "1", "", "", "", "", "", "", "8", "",
        ])
}

@Test("今日・週・月・すべての見出しは、数えた期間から作る")
func rangeTexts() {
    let records = StatsRecords(sessions: [], entries: [])
    let now = tokyo.startOfDay(date("2026-10-21")).adding(milliseconds: 10 * 3_600_000)
    func range(_ period: StatsPeriod) -> String {
        rangeTextOf(Stats.of(records: records, period: period, now: now, timeZone: tokyo))
    }
    #expect(range(.today) == "10月21日（水）")
    #expect(range(.week) == "10月19日（月） 〜 10月25日（日）")
    #expect(range(.month) == "2026年10月")
    #expect(range(.all) == "2026年10月21日（水） 〜 今日")
}

// MARK: - 設定の文言

@Test("フェーズの進め方の4つの切り替わりに見出しをつける")
func transitionTexts() {
    #expect(
        PhaseTransition.allCases.map { transitionTextOf($0).label } == [
            "集中 → ジャーナル", "ジャーナル → 集中", "ジャーナル → 休憩", "休憩 → 集中",
        ])
    #expect(advanceChoices.map(advanceChoiceTextOf) == ["自動", "手動"])
}

@Test("音色は行き先のフェーズごとに、1セットの流れの順で選ぶ")
func toneTexts() {
    #expect(toneTargets.map { toneTargetOf($0).label } == ["ジャーナルに入るとき", "集中に入るとき", "休憩に入るとき"])
    #expect(AlertTone.allCases.map(toneTextOf) == ["鐘", "木琴", "電子音", "やわらか"])
    #expect(Volume.allCases.map(volumeTextOf) == ["小", "中", "大"])
    let changed = AlertSettings.defaults.withTone(.marimba, to: .journal)
    #expect(changed.tones[.journal] == .marimba)
    #expect(changed.tones[.focus] == .bell)
    #expect(changed.tones[.breakTime] == .bell)
}

@Test("タグの削除のボタンと確かめの文に、外すか付け替えるかを書く")
func tagDeletionTexts() {
    let usage = TagUsage(name: TagName("読書")!, entryCount: 3)
    #expect(tagDeletionActionOf(.detach) == "外して削除")
    #expect(tagDeletionActionOf(.reassign(to: TagName("book")!)) == "#book に付け替えて削除")
    #expect(tagDeletionMessageOf(usage, .detach) == "#読書 を削除します。ついている3件の記入は消えず、タグだけを外します。")
    #expect(tagKindsNoteOf(inUse: 2) == "使えるタグは20種類までで、いま2種類を使っています。")
    #expect(ThemePreference.allCases.map(\.rawValue) == ["System", "Light", "Dark"])
}

@Test("通知の音のファイルは、行き先のフェーズ・音色・音量の組ごとに分ける")
func chimeSoundFileNames() {
    let settings = AlertSettings.defaults.withTone(.soft, to: .breakTime)
    #expect(chimeSoundFileNameOf(to: .breakTime, settings: settings) == "nanaichi-Break-Soft-High.caf")
    #expect(chimeSoundFileNameOf(to: .journal, settings: settings) == "nanaichi-Journal-Bell-High.caf")
}
