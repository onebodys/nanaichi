import XCTest

/// タイムライン・タグ・スタッツ・ジャーナルのカレンダー・設定を、この端末の記録先で使う（Issue #143）
final class ReviewAndSettingsTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(database: String, timeScale: Double = 1) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_TIME_SCALE": String(timeScale), "NANAICHI_DATABASE": database,
            "NANAICHI_RESET_DATABASE": "1", "NANAICHI_RESET_DEFAULTS": "1",
        ]
        // 前のテストが開いたウィンドウ（スタッツなど）を復元させない。復元したウィンドウがメインのウィンドウに重なり、クリックが当たらなくなる
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        launch(app, until: .appears(app.buttons["timer.start"], failure: "メインのウィンドウが開かない"))
        return app
    }

    /// 文字 `text` を含む要素がどこかに出る（リンクを含む本文は、文字がいくつかに分かれて読まれることがある）。
    /// ウィンドウのすべての要素（`.any`）を問い合わせると、タイムラインが長くなったときに問い合わせが時間切れになるので、
    /// 文字を持つ種類の要素だけを探す
    @MainActor
    private func shows(_ app: XCUIApplication, _ text: String) -> ScreenChange {
        .holds(
            { self.textQueries(app, containing: text).contains { $0.firstMatch.exists } },
            failure: { "「\(text)」が出ない" })
    }

    /// 文字 `text` を含む要素がどこかに出るまで待つ
    @MainActor
    private func waitForText(
        _ app: XCUIApplication, _ text: String, timeout: TimeInterval = 10, file: StaticString = #filePath,
        line: UInt = #line
    ) {
        waitFor(shows(app, text), timeout: timeout, file: file, line: line)
    }

    @MainActor
    private func textQueries(_ root: XCUIElement, containing text: String) -> [XCUIElementQuery] {
        let byValue = NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", text, text)
        let byTitle = NSPredicate(format: "label CONTAINS %@ OR title CONTAINS %@", text, text)
        return [
            root.staticTexts.matching(byValue), root.links.matching(byValue), root.textViews.matching(byValue),
            root.buttons.matching(byTitle), root.radioButtons.matching(byTitle),
        ]
    }

    @MainActor
    private func texts(_ root: XCUIElement, containing text: String) -> XCUIElementQuery {
        root.staticTexts.matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", text, text))
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// セグメントやラジオボタンの選択肢 `title` を選び、`change`（渡さなければ、その選択肢が選ばれたこと）が起きなければ選び直す
    @MainActor
    private func choose(_ app: XCUIApplication, _ identifier: String, _ title: String, until change: ScreenChange? = nil) {
        let control = element(app, identifier)
        XCTAssertTrue(control.waitForExistence(timeout: 5), "\(identifier) がない")
        let option = control.descendants(matching: .any).matching(
            NSPredicate(format: "(label == %@ OR title == %@ OR value == %@) AND elementType != %d", title, title, title,
                        XCUIElement.ElementType.staticText.rawValue)
        ).firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 5), "\(identifier) に「\(title)」がない")
        // macOS のセグメントとラジオボタンは、選ばれていれば `value` に 1 を持つ
        let chosen = ScreenChange.holds(
            { option.isSelected || option.value as? Int == 1 || option.value as? String == "1" },
            failure: { "\(identifier) で「\(title)」が選ばれない" })
        click(option, until: change ?? chosen)
    }

    /// ポップアップの選択肢 `title` を選ぶ
    @MainActor
    private func pick(_ app: XCUIApplication, _ identifier: String, _ title: String) {
        let popup = element(app, identifier)
        XCTAssertTrue(popup.waitForExistence(timeout: 5), "\(identifier) がない")
        let item = app.menuItems[title]
        // ポップアップは押すたびにメニューを開け閉めするので、押し直さない
        click(popup, until: .appears(item, failure: "\(identifier) に「\(title)」がない"), attempts: 1)
        click(item, until: .equals({ popup.value as? String }, title, identifier))
    }

    @MainActor
    private func write(_ app: XCUIApplication, body: String, tag: String?) {
        if let tag { type("\(tag)\r", into: app.textFields["tags.input"]) }
        let input = app.textViews["journal.body"]
        type(body, into: input, toRead: body)
        perform(
            { _ in input.typeKey(.return, modifierFlags: .command) },
            until: .equals({ input.value as? String }, "", "送ったあとの入力欄の本文"))
    }

    /// `element` を右クリックし、メニューの項目 `title` を選んで、`change` が起きるのを待つ
    @MainActor
    private func rightClick(
        _ element: XCUIElement, andChoose title: String, in app: XCUIApplication, until change: ScreenChange,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let item = app.menuItems[title]
        perform(
            { _ in element.rightClick() }, until: .appears(item, failure: "右クリックのメニューに「\(title)」がない"),
            file: file, line: line)
        click(item, until: change, file: file, line: line)
    }

    /// スタッツの期間が月のときの見出し（`2026年11月`、`rangeTextOf`）
    private var thisMonthText: String {
        let today = Calendar(identifier: .gregorian).dateComponents([.year, .month], from: Date())
        return "\(today.year ?? 0)年\(today.month ?? 0)月"
    }

    private var todayKey: String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }

    /// タグをつけて書く → タイムラインに日付ごとに並ぶ → 編集・削除 → スタッツ → カレンダー → タグで見返す → タグの削除
    @MainActor
    func testTimelineTagsStatsAndCalendar() throws {
        let app = launch(database: "uitest-review.sqlite")
        click(app.buttons["timer.start"], until: .reads(app, "timer.phase", "集中"), failsOn: [app.staticTexts["timer.error"]])

        write(app, body: "第3章を読んだ", tag: "読書")
        XCTAssertTrue(element(app, "tag.attached").exists, "つけたタグが入力欄に残らない")
        write(app, body: "画面の設計を見直した https://example.com/design", tag: "設計")
        XCTAssertTrue(element(app, "timeline.day").waitForExistence(timeout: 5), "日付の区切りが出ない")
        waitForText(app, "第3章を読んだ")
        waitForText(app, "画面の設計を見直した")
        attachScreenshot(of: app, named: "11-タグをつけた記入とタイムライン")

        // 編集する（右クリックのメニューからシートで）
        let first = app.descendants(matching: .any).matching(identifier: "entry").element(boundBy: 1)
        let editor = app.textViews["editor.body"]
        rightClick(first, andChoose: "編集…", in: app, until: .appears(editor, failure: "編集のシートが出ない"))
        focus(editor)
        editor.typeKey(.end, modifierFlags: .command)
        editor.typeText("。メモを取った")
        attachScreenshot(of: app, named: "12-記入を編集")
        perform(
            { _ in if editor.exists { editor.typeKey(.return, modifierFlags: .command) } },
            until: .disappears(editor, failure: "編集のシートが閉じない"))
        waitForText(app, "第3章を読んだ。メモを取った")
        waitForText(app, "編集済み")

        // 削除する（確かめてから）。もう1件書いて、それを消す
        write(app, body: "消す記入", tag: nil)
        waitForText(app, "消す記入")
        let newest = app.descendants(matching: .any).matching(identifier: "entry").element(boundBy: 0)
        let confirm = app.buttons["entry.confirmDelete"]
        rightClick(newest, andChoose: "削除…", in: app, until: .appears(confirm, failure: "削除の確かめが出ない"))
        attachScreenshot(of: app, named: "13-記入の削除の確かめ")
        click(confirm, until: .disappears(texts(app, containing: "消す記入").firstMatch, failure: "削除した記入が残る"))

        // スタッツを開いて期間を切り替える
        perform(
            { _ in app.typeKey("2", modifierFlags: .command) },
            until: .appears(element(app, "stats.entries"), failure: "スタッツが出ない"), timeout: 10)
        waitFor(app, "stats.entries", toRead: "2")
        attachScreenshot(of: app, named: "14-スタッツ（今日）")
        choose(app, "stats.period", "週", until: .appears(element(app, "stats.trend"), failure: "日ごとの集中が出ない"))
        attachScreenshot(of: app, named: "15-スタッツ（週）")
        // 日ごとの集中は週から出ているので、月に替わったことは期間の見出しで確かめる
        choose(app, "stats.period", "月", until: .reads(app, "stats.range", thisMonthText))
        XCTAssertTrue(element(app, "stats.trend").waitForExistence(timeout: 5))
        choose(app, "stats.period", "すべて", until: shows(app, "月ごとの集中"))
        attachScreenshot(of: app, named: "16-スタッツ（すべて）")

        // ジャーナルのカレンダーで今日を選び、記入を見る
        let today = element(app, "calendar.day.\(todayKey)")
        click(app.staticTexts["ジャーナルのカレンダー"], until: .appears(today, failure: "カレンダーに今日がない"))
        click(today, until: .reads(app, "entriesOnDate.count", "2件"))
        attachScreenshot(of: app, named: "17-ジャーナルのカレンダー")

        // タグで見返す
        let tagged = element(app, "taggedEntries")
        click(
            element(app, "review.tag.設計"),
            until: .appears(texts(tagged, containing: "画面の設計を見直した").firstMatch, failure: "タグのついた記入が出ない"))
        XCTAssertFalse(texts(tagged, containing: "第3章を読んだ").firstMatch.exists, "ほかのタグの記入が混ざる")
        attachScreenshot(of: app, named: "18-タグで見返す")

        // 設定のタグで、#読書 を #設計 に付け替えて削除する
        openSettings(app, tab: "タグ")
        let delete = app.buttons["tag.delete.読書"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "タグの一覧に #読書 がない")
        click(delete, until: .appears(element(app, "tagDeletion.choice"), failure: "tagDeletion.choice がない"))
        choose(app, "tagDeletion.choice", "別のタグに付け替える", until: shows(app, "#設計 に付け替えて削除"))
        attachScreenshot(of: app, named: "19-タグを付け替えて削除")
        click(app.buttons["tagDeletion.confirm"], until: .disappears(delete, failure: "削除したタグが一覧に残る"))
        waitForText(app, "2件の記入")
        attachScreenshot(of: app, named: "20-タグを削除したあとの設定")
    }

    /// 集中 → ジャーナルを手動にすると、集中のあと切り替え待ちで止まり、進めるとジャーナルが始まる。音色を変えて試す
    @MainActor
    func testManualAdvanceAndTones() throws {
        // 15倍なら集中は28秒
        let app = launch(database: "uitest-settings.sqlite", timeScale: 15)

        openSettings(app, tab: "タイマー")
        choose(app, "advance.FocusToJournal", "手動")
        attachScreenshot(of: app, named: "21-設定（フェーズの進め方）")

        openSettings(app, tab: "知らせ方")
        pick(app, "tone.Journal", "木琴")
        XCTAssertEqual(element(app, "tone.Journal").value as? String, "木琴", "音色が変わらない")
        app.buttons["tone.Journal.preview"].click()
        attachScreenshot(of: app, named: "22-設定（知らせ方）")
        openSettings(app, tab: "ジャーナル")
        XCTAssertTrue(element(app, "settings.submitKey").waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "23-設定（ジャーナル）")
        openSettings(app, tab: "表示")
        choose(app, "settings.theme", "ダーク")
        attachScreenshot(of: app, named: "24-設定（表示・ダーク）")
        choose(app, "settings.theme", "ライト")
        closeSettings(app, tab: "表示")

        click(app.buttons["timer.start"], until: .reads(app, "timer.phase", "集中"), failsOn: [app.staticTexts["timer.error"]])
        waitFor(app, "timer.phase", toRead: "切り替え待ち", timeout: 7 * 60 / 15 + 10)
        attachScreenshot(of: app, named: "25-切り替え待ち")
        click(app.buttons["operation.Advance"], until: .reads(app, "timer.phase", "ジャーナル"), failsOn: [app.staticTexts["timer.error"]])
    }

    /// タグの候補はクリックでも札になり、↓ で選んで Return でもつけられ、札の × で外せる（Issue #43、Web と同じ）
    @MainActor
    func testTagSuggestionsAttachOnClick() throws {
        let app = launch(database: "uitest-tags.sqlite")
        click(app.buttons["timer.start"], until: .reads(app, "timer.phase", "集中"), failsOn: [app.staticTexts["timer.error"]])
        // 使っているタグを2つ作る
        write(app, body: "第3章を読んだ", tag: "読書")
        write(app, body: "画面を見直した", tag: "設計")
        for chip in app.descendants(matching: .any).matching(identifier: "tag.attached").allElementsBoundByIndex.reversed() {
            click(chip.buttons.firstMatch, until: .disappears(chip, failure: "札の × で外せない"))
        }
        XCTAssertFalse(element(app, "tag.attached").exists, "札の × で外せない")

        let tags = app.textFields["tags.input"]
        type("読", into: tags)
        let suggestion = app.buttons.matching(identifier: "tag.suggestion").firstMatch
        XCTAssertTrue(suggestion.waitForExistence(timeout: 5), "入力しても候補が出ない")
        // 候補の一覧は入力欄のすぐ下に出す（Issue #48。XCUITest の座標は下に向かって増える）
        let list = element(app, "tags.suggestions")
        XCTAssertGreaterThanOrEqual(list.frame.minY, tags.frame.maxY, "候補の一覧が入力欄の下に出ない")
        attachScreenshot(of: app, named: "49-タグの候補")
        let chip = element(app, "tag.attached")
        click(suggestion, until: .appears(chip, failure: "候補をクリックしても札にならない"))
        XCTAssertEqual(tags.value as? String, "", "札にしたあとも入力欄に文字が残る")

        // 何も入力せずに ↓ で2つめの候補（設計）を選び、Return でつける
        // Return は押すたびに候補をつけるので、押し直さない
        let chips = app.descendants(matching: .any).matching(identifier: "tag.attached")
        perform(
            { _ in
                tags.typeKey(.downArrow, modifierFlags: [])
                tags.typeKey(.return, modifierFlags: [])
            }, until: .equals({ chips.count }, 2, "札の数"), attempts: 1)
    }
}
