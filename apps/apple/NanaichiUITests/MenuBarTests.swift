import XCTest

/// メニューバーだけでタイマーを使う（Issue #148、ADR 0015「メニューバー常駐」）。
/// メインのウィンドウを閉じても、タイマーが進み、メニューバーのパネルから操作できる
final class MenuBarTests: XCTestCase {
    /// 15倍なら集中は28秒、ジャーナルは4秒
    private let timeScale = 15.0

    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(panelWindow: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_TIME_SCALE": String(timeScale), "NANAICHI_DATABASE": ":memory:",
            "NANAICHI_RESET_DEFAULTS": "1", "NANAICHI_APPEARANCE": "Light",
            "NANAICHI_MENU_BAR_PANEL_WINDOW": panelWindow ? "1" : "0",
        ]
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        return app
    }

    /// 識別子 `identifier` の文字が `label` になるまで待つ。macOS の StaticText は文字を `value` に持ち、`label` は空になる
    @MainActor
    private func waitFor(
        _ root: XCUIElement, _ identifier: String, toRead label: String, timeout: TimeInterval = 10,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let element = root.staticTexts.matching(
            NSPredicate(format: "identifier == %@ AND (value == %@ OR label == %@)", identifier, label, label)
        ).firstMatch
        XCTAssertTrue(
            element.waitForExistence(timeout: timeout), "\(identifier) が「\(label)」にならない", file: file, line: line)
    }

    @MainActor
    private func window(_ app: XCUIApplication, titled title: String) -> XCUIElement {
        app.windows.matching(NSPredicate(format: "title == %@", title)).firstMatch
    }

    /// メインのウィンドウを閉じる。最後のウィンドウを閉じても終了しないのが初めの設定
    @MainActor
    private func closeMainWindow(_ app: XCUIApplication) {
        let main = window(app, titled: "nanaichi")
        XCTAssertTrue(main.waitForExistence(timeout: 10), "メインのウィンドウが開かない")
        main.buttons[XCUIIdentifierCloseWindow].click()
        XCTAssertTrue(main.waitForNonExistence(timeout: 5), "メインのウィンドウが閉じない")
    }

    /// 完了条件「メニューバーだけで1セットを進められる」。パネルのボタンだけで、集中からジャーナルを経て
    /// 次のセットまで進め、終了する。パネルはデバッグのビルドでふつうのウィンドウにも開けるものを使う
    /// （メニューバーの表示を押せるかはテストの環境による。押して開けることは次のテストで確かめる）
    @MainActor
    func testOneSetFromTheMenuBarPanelWithTheWindowClosed() throws {
        let app = launch(panelWindow: true)
        closeMainWindow(app)
        let panel = window(app, titled: "メニューバーのパネル")
        XCTAssertTrue(panel.waitForExistence(timeout: 10), "パネルが開かない")

        panel.buttons["menubar.start"].click()
        waitFor(panel, "menubar.phase", toRead: "集中")
        waitFor(panel, "menubar.position", toRead: "1ラウンド目・1セット目")
        attachScreenshot(ofElement: panel, named: "40-メニューバーのパネル（集中中）")

        panel.buttons["menubar.operation.Pause"].click()
        XCTAssertTrue(panel.staticTexts["menubar.paused"].waitForExistence(timeout: 5), "一時停止にならない")
        attachScreenshot(ofElement: panel, named: "41-メニューバーのパネル（一時停止中）")
        panel.buttons["menubar.operation.Resume"].click()
        XCTAssertTrue(panel.staticTexts["menubar.paused"].waitForNonExistence(timeout: 5), "再開しない")

        // ウィンドウを閉じたままでも、時間が過ぎればジャーナルに切り替わり、次のセットに進む
        waitFor(panel, "menubar.phase", toRead: "ジャーナル", timeout: 7 * 60 / timeScale + 10)
        attachScreenshot(ofElement: panel, named: "42-メニューバーのパネル（ジャーナル）")
        waitFor(panel, "menubar.position", toRead: "1ラウンド目・2セット目", timeout: 60 / timeScale + 10)
        waitFor(panel, "menubar.phase", toRead: "集中")

        panel.buttons["menubar.operation.End"].click()
        waitFor(panel, "menubar.summary", toRead: "完了 1セット · 集中 7分")
        XCTAssertTrue(panel.buttons["menubar.start"].waitForExistence(timeout: 5), "次のセッションを始められない")
        attachScreenshot(ofElement: panel, named: "43-メニューバーのパネル（終了したあと）")
    }

    /// メニューバーの表示を押すとパネルが開き、残り時間を出し、メインのウィンドウを開き直せる
    @MainActor
    func testMenuBarExtraOpensThePanel() throws {
        let app = launch(panelWindow: false)
        closeMainWindow(app)
        let item = app.statusItems.firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10), "メニューバーに表示がない")
        attachScreenshot(ofElement: item, named: "44-メニューバーの表示（開始前）")

        item.click()
        let start = app.buttons["menubar.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5), "パネルが開かない")
        start.click()
        waitFor(app, "menubar.phase", toRead: "集中")
        attachScreenshot(ofElement: item, named: "45-メニューバーの表示（集中中）")

        app.buttons["menubar.open"].click()
        XCTAssertTrue(window(app, titled: "nanaichi").waitForExistence(timeout: 5), "メインのウィンドウが開き直さない")
        waitFor(app, "timer.phase", toRead: "集中")
    }
}
