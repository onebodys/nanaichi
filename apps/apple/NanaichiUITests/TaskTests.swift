import XCTest

/// ToDo（タスクとジャーナルからの完了、Issue #147）。アカウントの記録先でだけ使え、設定で有効にしたときだけ出る（ADR 0026・0027）。
///
/// アカウントの記録先は、サーバーの代わりのアカウント（`NANAICHI_ACCOUNT_STUB`）で開く。代わりのアカウントには、
/// ジャーナルから完了したタスクが1件ある（判断モデルは呼ばない）
final class TaskTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(stub: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_DATABASE": stub ? ":memory:" : "uitest-tasks.sqlite", "NANAICHI_RESET_DATABASE": "1",
            "NANAICHI_RESET_DEFAULTS": "1", "NANAICHI_ACCOUNT_STUB": stub ? "1" : "0",
        ]
        // 前のテストが開いたウィンドウを復元させない。復元したウィンドウがメインのウィンドウに重なり、クリックが当たらなくなる
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        return app
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// 識別子 `identifier` の文字が `text` になるまで待つ。macOS の StaticText は文字を `value` に持つ
    @MainActor
    private func waitFor(
        _ app: XCUIApplication, _ identifier: String, toRead text: String, timeout: TimeInterval = 5,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let element = app.staticTexts.matching(
            NSPredicate(format: "identifier == %@ AND (value == %@ OR label == %@)", identifier, text, text)
        ).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(identifier) が「\(text)」にならない", file: file, line: line)
    }

    /// タスク `title` のチェックが `checked` になるまで待つ
    @MainActor
    private func waitFor(
        _ app: XCUIApplication, task title: String, checked: Bool, file: StaticString = #filePath, line: UInt = #line
    ) {
        let check = app.checkBoxes["task.check.\(title)"]
        XCTAssertTrue(check.waitForExistence(timeout: 5), "「\(title)」がない", file: file, line: line)
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %d", checked ? 1 : 0), object: check)
        XCTAssertEqual(
            XCTWaiter().wait(for: [expectation], timeout: 5), .completed,
            "「\(title)」が\(checked ? "完了" : "未完了")にならない", file: file, line: line)
    }

    @MainActor
    private func add(_ app: XCUIApplication, _ title: String) {
        let field = app.textFields["tasks.add"]
        field.click()
        field.typeText("\(title)\r")
        waitFor(app, task: title, checked: false)
    }

    @MainActor
    private func openTimerSettings(_ app: XCUIApplication) {
        app.typeKey(",", modifierFlags: .command)
        let tab = app.toolbars.buttons["タイマー"]
        XCTAssertTrue(tab.waitForExistence(timeout: 5), "設定が開かない")
        tab.click()
        XCTAssertTrue(element(app, "advance.FocusToJournal").waitForExistence(timeout: 5), "進め方の設定がない")
    }

    /// 設定で ToDo を有効にすると、簡略のタイマーの下に一覧が出て、タスクを足す・完了にする・戻す・名前を変える・削除できる
    @MainActor
    func testTasksOnTheAccountRecordStore() throws {
        let app = launch(stub: true)
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.textFields["tasks.add"].exists, "ToDo を有効にする前から一覧が出ている")

        openTimerSettings(app)
        let toggle = element(app, "settings.tasks")
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "アカウントの記録先なのに ToDo の設定がない")
        toggle.click()
        attachScreenshot(of: app, named: "30-設定（ToDo を使う）")
        app.typeKey("w", modifierFlags: .command)

        XCTAssertTrue(app.textFields["tasks.add"].waitForExistence(timeout: 5), "ToDo を有効にしても一覧が出ない")
        let drafted = "企画書の下書きを書く"
        waitFor(app, task: drafted, checked: true)
        waitFor(app, "task.completion.\(drafted)", toRead: "ジャーナルから完了 (96%)")
        attachScreenshot(of: app, named: "31-ToDo（ジャーナルから完了したタスク）")

        add(app, "メールを返す")
        add(app, "資料を読む")
        attachScreenshot(of: app, named: "32-ToDo（タスクを足した）")

        app.checkBoxes["task.check.メールを返す"].click()
        waitFor(app, task: "メールを返す", checked: true)
        attachScreenshot(of: app, named: "33-ToDo（完了にした）")
        app.checkBoxes["task.check.メールを返す"].click()
        waitFor(app, task: "メールを返す", checked: false)

        app.staticTexts["task.title.資料を読む"].rightClick()
        let rename = app.menuItems["名前を変更"]
        XCTAssertTrue(rename.waitForExistence(timeout: 5), "右クリックのメニューに名前の変更がない")
        rename.click()
        let field = app.textFields["task.rename"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "名前を変える欄が出ない")
        field.typeKey("a", modifierFlags: .command)
        field.typeText("資料を読み終える\r")
        waitFor(app, task: "資料を読み終える", checked: false)
        XCTAssertFalse(app.checkBoxes["task.check.資料を読む"].exists, "名前を変える前のタスクが残っている")

        app.staticTexts["task.title.資料を読み終える"].click()
        app.typeKey(.delete, modifierFlags: [])
        let confirm = app.buttons.matching(
            NSPredicate(format: "identifier == 'taskDeletion.confirm' OR label == 'タスクを削除'")
        ).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "⌫ で削除の確かめが出ない")
        attachScreenshot(of: app, named: "34-ToDo（削除を確かめる）")
        confirm.click()
        let deleted = app.checkBoxes["task.check.資料を読み終える"]
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: deleted)
        waitForExpectations(timeout: 5)
        attachScreenshot(of: app, named: "35-ToDo（削除したあと）")
    }

    /// この端末の記録先には ToDo がないので、設定の項目も一覧も出ない
    @MainActor
    func testNoTasksOnTheDeviceRecordStore() throws {
        let app = launch(stub: false)
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.textFields["tasks.add"].exists, "この端末の記録先に ToDo の一覧が出ている")

        openTimerSettings(app)
        XCTAssertFalse(element(app, "settings.tasks").exists, "この端末の記録先に ToDo の設定が出ている")
        attachScreenshot(of: app, named: "36-設定（この Mac の記録には ToDo がない）")
    }
}
