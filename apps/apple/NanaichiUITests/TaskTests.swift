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
        launch(app, until: .appears(app.buttons["timer.start"], failure: "メインのウィンドウが開かない"))
        return app
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// タスク `title` のチェックが `checked` になる
    @MainActor
    private func task(_ app: XCUIApplication, _ title: String, checked: Bool) -> ScreenChange {
        let check = app.checkBoxes["task.check.\(title)"]
        return .holds(
            { check.exists && check.value as? Int == (checked ? 1 : 0) },
            failure: { "「\(title)」が\(checked ? "完了" : "未完了")にならない" })
    }

    /// チェックボックスや切り替えが入っているか。macOS では `value` に 0 か 1 を持つ
    @MainActor
    private func isOn(_ element: XCUIElement) -> Bool {
        element.exists && (element.value as? Int == 1 || element.value as? String == "1")
    }

    /// タスク `title` のチェックが `checked` になるまで待つ
    @MainActor
    private func waitFor(
        _ app: XCUIApplication, task title: String, checked: Bool, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertTrue(
            app.checkBoxes["task.check.\(title)"].waitForExistence(timeout: 5), "「\(title)」がない", file: file, line: line)
        waitFor(task(app, title, checked: checked), timeout: 5, file: file, line: line)
    }

    @MainActor
    private func add(_ app: XCUIApplication, _ title: String) {
        type("\(title)\r", into: app.textFields["tasks.add"])
        waitFor(app, task: title, checked: false)
    }

    @MainActor
    private func openTimerSettings(_ app: XCUIApplication) {
        openSettings(app, tab: "タイマー")
        XCTAssertTrue(element(app, "advance.FocusToJournal").waitForExistence(timeout: 5), "進め方の設定がない")
    }

    /// 設定で ToDo を有効にすると、簡略のタイマーの下に一覧が出て、タスクを足す・完了にする・戻す・名前を変える・削除できる
    @MainActor
    func testTasksOnTheAccountRecordStore() throws {
        let app = launch(stub: true)
        XCTAssertFalse(app.textFields["tasks.add"].exists, "ToDo を有効にする前から一覧が出ている")

        openTimerSettings(app)
        let toggle = element(app, "settings.tasks")
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "アカウントの記録先なのに ToDo の設定がない")
        // 押すたびに切り替わるので、押し直さない
        click(toggle, until: .holds({ self.isOn(toggle) }, failure: { "ToDo を使う設定が入らない" }), attempts: 1)
        attachScreenshot(of: app, named: "30-設定（ToDo を使う）")
        closeSettings(app, tab: "タイマー")

        XCTAssertTrue(app.textFields["tasks.add"].waitForExistence(timeout: 5), "ToDo を有効にしても一覧が出ない")
        let drafted = "企画書の下書きを書く"
        waitFor(app, task: drafted, checked: true)
        waitFor(app, "task.completion.\(drafted)", toRead: "ジャーナルから完了 (96%)")
        attachScreenshot(of: app, named: "31-ToDo（ジャーナルから完了したタスク）")

        add(app, "メールを返す")
        add(app, "資料を読む")
        attachScreenshot(of: app, named: "32-ToDo（タスクを足した）")

        // チェックは押すたびに切り替わるので、押し直さない
        click(app.checkBoxes["task.check.メールを返す"], until: task(app, "メールを返す", checked: true), attempts: 1)
        attachScreenshot(of: app, named: "33-ToDo（完了にした）")
        click(app.checkBoxes["task.check.メールを返す"], until: task(app, "メールを返す", checked: false), attempts: 1)

        let rename = app.menuItems["名前を変更"]
        perform(
            { _ in app.staticTexts["task.title.資料を読む"].rightClick() },
            until: .appears(rename, failure: "右クリックのメニューに名前の変更がない"))
        let field = app.textFields["task.rename"]
        click(rename, until: .appears(field, failure: "名前を変える欄が出ない"))
        focus(field)
        field.typeKey("a", modifierFlags: .command)
        field.typeText("資料を読み終える\r")
        waitFor(app, task: "資料を読み終える", checked: false)
        XCTAssertFalse(app.checkBoxes["task.check.資料を読む"].exists, "名前を変える前のタスクが残っている")

        let confirm = app.buttons.matching(
            NSPredicate(format: "identifier == 'taskDeletion.confirm' OR label == 'タスクを削除'")
        ).firstMatch
        perform(
            { _ in
                app.staticTexts["task.title.資料を読み終える"].click()
                app.typeKey(.delete, modifierFlags: [])
            }, until: .appears(confirm, failure: "⌫ で削除の確かめが出ない"))
        attachScreenshot(of: app, named: "34-ToDo（削除を確かめる）")
        click(confirm, until: .disappears(app.checkBoxes["task.check.資料を読み終える"], failure: "削除したタスクが残る"))
        attachScreenshot(of: app, named: "35-ToDo（削除したあと）")
    }

    /// この端末の記録先には ToDo がないので、設定の項目も一覧も出ない
    @MainActor
    func testNoTasksOnTheDeviceRecordStore() throws {
        let app = launch(stub: false)
        XCTAssertFalse(app.textFields["tasks.add"].exists, "この端末の記録先に ToDo の一覧が出ている")

        openTimerSettings(app)
        XCTAssertFalse(element(app, "settings.tasks").exists, "この端末の記録先に ToDo の設定が出ている")
        attachScreenshot(of: app, named: "36-設定（この Mac の記録には ToDo がない）")
    }
}
