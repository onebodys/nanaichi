import XCTest

/// Watch の画面と、iPhone 経由の操作（Issue #72、Issue #122）。
///
/// watchOS のシミュレーターの XCUITest は iPhone のアプリを一緒に動かせないので、iPhone の代わり（`StubPhoneLink`）に
/// つないで起動する。代わりの iPhone は、iPhone のアプリと同じく Watch の頼みを記録先のワークフローに通す。
/// 画面はいちばん小さい Apple Watch SE 3（40mm）で確かめる（`scripts/ui-test.sh` が選ぶ）
final class WatchTimerTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// `startedAgo` は、Watch で開始したセッションを何秒前に始めたことにするか
    @MainActor
    private func launch(
        phone: String, startsAfter: Double? = nil, startedAgo: Double? = nil, showsVibrations: Bool = false
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["NANAICHI_WATCH_PHONE": phone]
        if let startsAfter { app.launchEnvironment["NANAICHI_WATCH_PHONE_STARTS_AFTER"] = String(startsAfter) }
        if let startedAgo { app.launchEnvironment["NANAICHI_WATCH_PHONE_STARTED_AGO"] = String(startedAgo) }
        if showsVibrations { app.launchEnvironment["NANAICHI_WATCH_SHOW_VIBRATIONS"] = "1" }
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

    /// スクロールする場所がなく、文字・記号・ボタンがどれも画面の中に収まっている。撮った画面を `name` で残す
    @MainActor
    private func assertFitsOnScreen(
        _ app: XCUIApplication, screenshot name: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(app.scrollViews.count, 0, "スクロールする場所がある", file: file, line: line)
        let screen = app.windows.firstMatch.frame
        for query in [app.staticTexts, app.images, app.buttons] {
            for element in query.allElementsBoundByIndex where element.exists {
                XCTAssertTrue(
                    screen.contains(element.frame),
                    "\(element.identifier)（\(element.label)）が画面 \(screen) からはみ出す: \(element.frame)",
                    file: file, line: line)
            }
        }
        attachScreenshot(named: name)
    }

    /// 文言のない操作のボタンで、VoiceOver が GLOSSARY の用語を読む
    @MainActor
    private func assertIconButton(
        _ button: XCUIElement, reads term: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertTrue(button.waitForExistence(timeout: 10), "「\(term)」のボタンがない", file: file, line: line)
        XCTAssertEqual(button.label, term, file: file, line: line)
        XCTAssertEqual(button.staticTexts.count, 0, "「\(term)」のボタンに文言が出ている", file: file, line: line)
    }

    /// Watch で開始・一時停止・再開・中断・終了すると、iPhone の記録先でその操作をしたのと同じ様子になる
    @MainActor
    func testOperatesThroughPhone() {
        let app = launch(phone: "stub")
        let start = app.buttons["timer.start"]
        assertIconButton(start, reads: "開始")
        XCTAssertTrue(start.isEnabled)
        XCTAssertFalse(app.images["watch.unreachable"].exists)
        assertFitsOnScreen(app, screenshot: "01-開始前")

        start.tap()
        waitFor(app, "timer.phase", toRead: "集中")
        waitFor(app, "timer.position", toRead: "1ラウンド目・1セット目")
        let countdown = app.staticTexts["timer.countdown"]
        XCTAssertTrue(countdown.waitForExistence(timeout: 10))
        XCTAssertTrue(countdown.label.hasPrefix("残り 6分"), "残り時間が出ない: \(countdown.label)")
        assertIconButton(app.buttons["operation.Pause"], reads: "一時停止")
        assertIconButton(app.buttons["operation.Abort"], reads: "中断")
        assertIconButton(app.buttons["operation.End"], reads: "終了")
        assertFitsOnScreen(app, screenshot: "02-集中中")

        app.buttons["operation.Pause"].tap()
        XCTAssertTrue(app.images["timer.paused"].waitForExistence(timeout: 10), "一時停止中にならない")
        assertIconButton(app.buttons["operation.Resume"], reads: "再開")
        XCTAssertFalse(app.buttons["operation.Pause"].exists, "一時停止中にも一時停止が出ている")
        let pausedAt = countdown.label
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(countdown.label, pausedAt, "一時停止中に残り時間が進む")
        assertFitsOnScreen(app, screenshot: "03-一時停止中")

        app.buttons["operation.Resume"].tap()
        XCTAssertTrue(app.buttons["operation.Pause"].waitForExistence(timeout: 10), "再開しても一時停止が出ない")
        XCTAssertFalse(app.images["timer.paused"].exists, "再開しても一時停止中のまま")

        app.buttons["operation.Abort"].tap()
        waitFor(app, "timer.phase", toRead: "待機")
        XCTAssertTrue(app.staticTexts["timer.idle"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["operation.Abort"].exists, "待機でも中断が出ている")
        assertIconButton(app.buttons["operation.End"], reads: "終了")
        assertFitsOnScreen(app, screenshot: "04-中断して待機")

        app.buttons["operation.End"].tap()
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 10), "終了しても次のセッションを始められない")
        XCTAssertFalse(app.staticTexts["timer.phase"].exists, "終了してもセッション中の画面のまま")
    }

    /// ジャーナルと休憩の画面も、SE 3（40mm）にスクロールせずに収まる。ジャーナル中は中断を出さない
    @MainActor
    func testJournalAndBreakFitOnScreen() {
        // 集中の7分と30秒
        let journal = launch(phone: "stub", startedAgo: 7 * 60 + 30)
        journal.buttons["timer.start"].tap()
        waitFor(journal, "timer.phase", toRead: "ジャーナル")
        assertIconButton(journal.buttons["operation.Pause"], reads: "一時停止")
        XCTAssertFalse(journal.buttons["operation.Abort"].exists, "ジャーナル中に中断が出ている")
        assertFitsOnScreen(journal, screenshot: "05-ジャーナル中")
        journal.terminate()

        // 3セットの24分と30秒
        let breakTime = launch(phone: "stub", startedAgo: 24 * 60 + 30)
        breakTime.buttons["timer.start"].tap()
        waitFor(breakTime, "timer.phase", toRead: "休憩")
        waitFor(breakTime, "timer.position", toRead: "1ラウンド目")
        assertIconButton(breakTime.buttons["operation.Pause"], reads: "一時停止")
        assertIconButton(breakTime.buttons["operation.End"], reads: "終了")
        assertFitsOnScreen(breakTime, screenshot: "06-休憩中")
    }

    /// 集中からジャーナルへの切り替わりで、1回の知らせとして振動を3回続けて鳴らし、それきり鳴らさない（Issue #73）。
    /// 集中の残りが数秒のセッションを始める。振動そのものはシミュレーターで感じられないので、鳴らした振動の数を読む
    @MainActor
    func testVibratesOnceOnPhaseChange() {
        let app = launch(phone: "stub", startedAgo: 7 * 60 - 12, showsVibrations: true)
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        waitFor(app, "watch.vibrations", toRead: "0")

        start.tap()
        waitFor(app, "timer.phase", toRead: "集中")
        attachScreenshot(named: "09-振動で知らせる集中中")

        waitFor(app, "timer.phase", toRead: "ジャーナル", timeout: 20)
        waitFor(app, "watch.vibrations", toRead: "3")
        // 同じ切り替わりで、もう一度は知らせない
        Thread.sleep(forTimeInterval: 3)
        waitFor(app, "watch.vibrations", toRead: "3", timeout: 1)
        attachScreenshot(named: "10-ジャーナルに切り替わって振動した")
    }

    /// iPhone の側で始めたセッションが、Watch の表示に出る。Watch では何も押さない
    @MainActor
    func testShowsSessionStartedOnPhone() {
        let app = launch(phone: "stub", startsAfter: 3)
        waitFor(app, "timer.phase", toRead: "集中", timeout: 20)
        XCTAssertTrue(app.buttons["operation.Pause"].waitForExistence(timeout: 10))
        attachScreenshot(named: "07-iPhone で始めたセッション")
    }

    /// iPhone に届かないあいだは開始を押せず、届かないことを記号で出す
    @MainActor
    func testPhoneUnreachable() {
        let app = launch(phone: "unreachable")
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        let unreachable = app.images["watch.unreachable"]
        XCTAssertTrue(unreachable.waitForExistence(timeout: 10))
        XCTAssertEqual(unreachable.label, "iPhone に繋がっていません")
        XCTAssertFalse(start.isEnabled, "iPhone に届かないのに開始を押せる")
        assertFitsOnScreen(app, screenshot: "08-iPhone に繋がっていない")
    }
}
