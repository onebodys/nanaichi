import XCTest

/// Watch の画面と、iPhone 経由の開始・中断（Issue #72）。
///
/// watchOS のシミュレーターの XCUITest は iPhone のアプリを一緒に動かせないので、iPhone の代わり（`StubPhoneLink`）に
/// つないで起動する。代わりの iPhone は、iPhone のアプリと同じく Watch の頼みを記録先のワークフローに通す
final class WatchTimerTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(phone: String, startsAfter: Double? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["NANAICHI_WATCH_PHONE": phone]
        if let startsAfter { app.launchEnvironment["NANAICHI_WATCH_PHONE_STARTS_AFTER"] = String(startsAfter) }
        app.launch()
        return app
    }

    /// 識別子 `identifier` の文字が `label` になるまで待つ
    @MainActor
    private func waitFor(
        _ app: XCUIApplication, _ identifier: String, toRead label: String, timeout: TimeInterval = 10,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let element = app.staticTexts.matching(
            NSPredicate(format: "identifier == %@ AND (label == %@ OR value == %@)", identifier, label, label)
        ).firstMatch
        XCTAssertTrue(
            element.waitForExistence(timeout: timeout), "\(identifier) が「\(label)」にならない", file: file, line: line)
    }

    /// Watch で開始すると iPhone の記録先でセッションが始まって残り時間が出て、中断すると待機に戻る
    @MainActor
    func testStartAndAbortThroughPhone() {
        let app = launch(phone: "stub")
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        XCTAssertTrue(start.isEnabled)
        XCTAssertFalse(app.staticTexts["watch.unreachable"].exists)
        attachScreenshot(named: "01-開始前")

        start.tap()
        waitFor(app, "timer.phase", toRead: "集中")
        waitFor(app, "timer.position", toRead: "1ラウンド目・1セット目")
        let countdown = app.staticTexts["timer.countdown"]
        XCTAssertTrue(countdown.waitForExistence(timeout: 10))
        XCTAssertTrue(countdown.label.hasPrefix("残り 6分"), "残り時間が出ない: \(countdown.label)")
        attachScreenshot(named: "02-集中中")

        app.buttons["operation.Abort"].tap()
        waitFor(app, "timer.phase", toRead: "待機")
        XCTAssertTrue(app.staticTexts["timer.idle"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["operation.Abort"].exists, "待機でも中断が出ている")
        attachScreenshot(named: "03-中断して待機")
    }

    /// iPhone の側で始めたセッションが、Watch の表示に出る。Watch では何も押さない
    @MainActor
    func testShowsSessionStartedOnPhone() {
        let app = launch(phone: "stub", startsAfter: 3)
        waitFor(app, "timer.phase", toRead: "集中", timeout: 20)
        XCTAssertTrue(app.buttons["operation.Abort"].waitForExistence(timeout: 10))
        attachScreenshot(named: "04-iPhone で始めたセッション")
    }

    /// iPhone に届かないあいだは開始を押せず、届かないことを出す
    @MainActor
    func testPhoneUnreachable() {
        let app = launch(phone: "unreachable")
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["watch.unreachable"].waitForExistence(timeout: 10))
        XCTAssertFalse(start.isEnabled, "iPhone に届かないのに開始を押せる")
        attachScreenshot(named: "05-iPhone に繋がっていない")
    }
}
