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
        app.launch()
        return app
    }

    /// 識別子 `identifier` の要素の文字が `text` になるまで待つ。macOS の文字は value に入る（label は空のことがある）
    @MainActor
    private func waitFor(
        _ app: XCUIApplication, _ identifier: String, toRead text: String, timeout: TimeInterval = 10,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let element = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier == %@ AND (value == %@ OR label == %@)", identifier, text, text)
        ).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(identifier) が「\(text)」にならない", file: file, line: line)
    }

    /// 文字 `text` を含む要素がどこかに出るまで待つ（リンクを含む本文は、文字がいくつかに分かれて読まれることがある）
    @MainActor
    private func waitForText(
        _ app: XCUIApplication, _ text: String, timeout: TimeInterval = 10, file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let element = app.descendants(matching: .any).matching(
            NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@ OR title CONTAINS %@", text, text, text)
        ).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "「\(text)」が出ない", file: file, line: line)
    }

    @MainActor
    private func texts(_ app: XCUIElement, containing text: String) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", text, text))
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// セグメントやラジオボタンの選択肢 `title` を選ぶ
    @MainActor
    private func choose(_ app: XCUIApplication, _ identifier: String, _ title: String) {
        let control = element(app, identifier)
        XCTAssertTrue(control.waitForExistence(timeout: 5), "\(identifier) がない")
        let option = control.descendants(matching: .any).matching(
            NSPredicate(format: "(label == %@ OR title == %@ OR value == %@) AND elementType != %d", title, title, title,
                        XCUIElement.ElementType.staticText.rawValue)
        ).firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 5), "\(identifier) に「\(title)」がない")
        option.click()
    }

    /// ポップアップの選択肢 `title` を選ぶ
    @MainActor
    private func pick(_ app: XCUIApplication, _ identifier: String, _ title: String) {
        let popup = element(app, identifier)
        XCTAssertTrue(popup.waitForExistence(timeout: 5), "\(identifier) がない")
        popup.click()
        let item = app.menuItems[title]
        XCTAssertTrue(item.waitForExistence(timeout: 5), "\(identifier) に「\(title)」がない")
        item.click()
    }

    @MainActor
    private func write(_ app: XCUIApplication, body: String, tag: String?) {
        if let tag {
            let tags = app.textFields["tags.input"]
            tags.click()
            tags.typeText("\(tag)\r")
        }
        let input = app.textViews["journal.body"]
        input.click()
        input.typeText(body)
        input.typeKey(.return, modifierFlags: .command)
        expectation(for: NSPredicate(format: "value == ''"), evaluatedWith: input)
        waitForExpectations(timeout: 5)
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
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.click()
        waitFor(app, "timer.phase", toRead: "集中")

        write(app, body: "第3章を読んだ", tag: "読書")
        XCTAssertTrue(element(app, "tag.attached").exists, "つけたタグが入力欄に残らない")
        write(app, body: "画面の設計を見直した https://example.com/design", tag: "設計")
        XCTAssertTrue(element(app, "timeline.day").waitForExistence(timeout: 5), "日付の区切りが出ない")
        waitForText(app, "第3章を読んだ")
        waitForText(app, "画面の設計を見直した")
        attachScreenshot(of: app, named: "11-タグをつけた記入とタイムライン")

        // 編集する（右クリックのメニューからシートで）
        let first = app.descendants(matching: .any).matching(identifier: "entry").element(boundBy: 1)
        first.rightClick()
        app.menuItems["編集…"].click()
        let editor = app.textViews["editor.body"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "編集のシートが出ない")
        editor.typeKey(.end, modifierFlags: .command)
        editor.typeText("。メモを取った")
        attachScreenshot(of: app, named: "12-記入を編集")
        editor.typeKey(.return, modifierFlags: .command)
        waitForText(app, "第3章を読んだ。メモを取った")
        waitForText(app, "編集済み")

        // 削除する（確かめてから）。もう1件書いて、それを消す
        write(app, body: "消す記入", tag: nil)
        waitForText(app, "消す記入")
        let newest = app.descendants(matching: .any).matching(identifier: "entry").element(boundBy: 0)
        newest.rightClick()
        app.menuItems["削除…"].click()
        let confirm = app.buttons["entry.confirmDelete"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "削除の確かめが出ない")
        attachScreenshot(of: app, named: "13-記入の削除の確かめ")
        confirm.click()
        XCTAssertTrue(texts(app, containing: "消す記入").firstMatch.waitForNonExistence(timeout: 5), "削除した記入が残る")

        // スタッツを開いて期間を切り替える
        app.typeKey("2", modifierFlags: .command)
        XCTAssertTrue(element(app, "stats.entries").waitForExistence(timeout: 10), "スタッツが出ない")
        waitFor(app, "stats.entries", toRead: "2")
        attachScreenshot(of: app, named: "14-スタッツ（今日）")
        choose(app, "stats.period", "週")
        XCTAssertTrue(element(app, "stats.trend").waitForExistence(timeout: 5), "日ごとの集中が出ない")
        attachScreenshot(of: app, named: "15-スタッツ（週）")
        choose(app, "stats.period", "月")
        XCTAssertTrue(element(app, "stats.trend").waitForExistence(timeout: 5))
        choose(app, "stats.period", "すべて")
        waitForText(app, "月ごとの集中")
        attachScreenshot(of: app, named: "16-スタッツ（すべて）")

        // ジャーナルのカレンダーで今日を選び、記入を見る
        app.staticTexts["ジャーナルのカレンダー"].click()
        let today = element(app, "calendar.day.\(todayKey)")
        XCTAssertTrue(today.waitForExistence(timeout: 5), "カレンダーに今日がない")
        today.click()
        waitFor(app, "entriesOnDate.count", toRead: "2件")
        attachScreenshot(of: app, named: "17-ジャーナルのカレンダー")

        // タグで見返す
        element(app, "review.tag.設計").click()
        let tagged = element(app, "taggedEntries")
        XCTAssertTrue(texts(tagged, containing: "画面の設計を見直した").firstMatch.waitForExistence(timeout: 5), "タグのついた記入が出ない")
        XCTAssertFalse(texts(tagged, containing: "第3章を読んだ").firstMatch.exists, "ほかのタグの記入が混ざる")
        attachScreenshot(of: app, named: "18-タグで見返す")

        // 設定のタグで、#読書 を #設計 に付け替えて削除する
        app.typeKey(",", modifierFlags: .command)
        let tagsTab = app.toolbars.buttons["タグ"]
        XCTAssertTrue(tagsTab.waitForExistence(timeout: 5), "設定が開かない")
        tagsTab.click()
        let delete = app.buttons["tag.delete.読書"]
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "タグの一覧に #読書 がない")
        delete.click()
        choose(app, "tagDeletion.choice", "別のタグに付け替える")
        waitForText(app, "#設計 に付け替えて削除")
        attachScreenshot(of: app, named: "19-タグを付け替えて削除")
        app.buttons["tagDeletion.confirm"].click()
        XCTAssertTrue(delete.waitForNonExistence(timeout: 5), "削除したタグが一覧に残る")
        waitForText(app, "2件の記入")
        attachScreenshot(of: app, named: "20-タグを削除したあとの設定")
    }

    /// 集中 → ジャーナルを手動にすると、集中のあと切り替え待ちで止まり、進めるとジャーナルが始まる。音色を変えて試す
    @MainActor
    func testManualAdvanceAndTones() throws {
        // 15倍なら集中は28秒
        let app = launch(database: "uitest-settings.sqlite", timeScale: 15)
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 10))

        app.typeKey(",", modifierFlags: .command)
        let timerTab = app.toolbars.buttons["タイマー"]
        XCTAssertTrue(timerTab.waitForExistence(timeout: 5), "設定が開かない")
        timerTab.click()
        choose(app, "advance.FocusToJournal", "手動")
        attachScreenshot(of: app, named: "21-設定（フェーズの進め方）")

        app.toolbars.buttons["知らせ方"].click()
        pick(app, "tone.Journal", "木琴")
        XCTAssertEqual(element(app, "tone.Journal").value as? String, "木琴", "音色が変わらない")
        app.buttons["tone.Journal.preview"].click()
        attachScreenshot(of: app, named: "22-設定（知らせ方）")
        app.toolbars.buttons["ジャーナル"].click()
        XCTAssertTrue(element(app, "settings.submitKey").waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "23-設定（ジャーナル）")
        app.toolbars.buttons["表示"].click()
        choose(app, "settings.theme", "ダーク")
        attachScreenshot(of: app, named: "24-設定（表示・ダーク）")
        choose(app, "settings.theme", "ライト")
        app.typeKey("w", modifierFlags: .command)

        app.buttons["timer.start"].click()
        waitFor(app, "timer.phase", toRead: "集中")
        waitFor(app, "timer.phase", toRead: "切り替え待ち", timeout: 7 * 60 / 15 + 10)
        attachScreenshot(of: app, named: "25-切り替え待ち")
        app.buttons["operation.Advance"].click()
        waitFor(app, "timer.phase", toRead: "ジャーナル")
    }
}
