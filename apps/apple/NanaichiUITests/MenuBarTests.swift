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
        launch(app, until: .appears(window(app, titled: "nanaichi"), failure: "メインのウィンドウが開かない"))
        return app
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
        click(main.buttons[XCUIIdentifierCloseWindow], until: .disappears(main, failure: "メインのウィンドウが閉じない"))
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

        click(panel.buttons["menubar.start"], until: .reads(panel, "menubar.phase", "集中"))
        waitFor(panel, "menubar.position", toRead: "1ラウンド目・1セット目")
        attachScreenshot(ofElement: panel, named: "40-メニューバーのパネル（集中中）")

        click(
            panel.buttons["menubar.operation.Pause"],
            until: .appears(panel.staticTexts["menubar.paused"], failure: "一時停止にならない"))
        attachScreenshot(ofElement: panel, named: "41-メニューバーのパネル（一時停止中）")
        click(
            panel.buttons["menubar.operation.Resume"],
            until: .disappears(panel.staticTexts["menubar.paused"], failure: "再開しない"))

        // ウィンドウを閉じたままでも、時間が過ぎればジャーナルに切り替わり、次のセットに進む
        waitFor(panel, "menubar.phase", toRead: "ジャーナル", timeout: 7 * 60 / timeScale + 10)
        attachScreenshot(ofElement: panel, named: "42-メニューバーのパネル（ジャーナル）")
        waitFor(panel, "menubar.position", toRead: "1ラウンド目・2セット目", timeout: 60 / timeScale + 10)
        waitFor(panel, "menubar.phase", toRead: "集中")

        click(panel.buttons["menubar.operation.End"], until: .reads(panel, "menubar.summary", "完了 1セット · 集中 7分"))
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

        // メニューバーの表示は押すたびにパネルを開け閉めするので、遅れて開いたのを押し直して閉じないよう長めに待つ
        let start = app.buttons["menubar.start"]
        click(item, until: .appears(start, failure: "パネルが開かない"), timeout: 10)
        click(start, until: .reads(app, "menubar.phase", "集中"))
        attachScreenshot(ofElement: item, named: "45-メニューバーの表示（集中中）")

        click(app.buttons["menubar.open"], until: .appears(window(app, titled: "nanaichi"), failure: "メインのウィンドウが開き直さない"))
        waitFor(app, "timer.phase", toRead: "集中")
    }
}
