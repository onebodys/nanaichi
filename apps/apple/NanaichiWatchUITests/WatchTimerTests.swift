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

    /// `startedAgo` は、開始したセッションを何秒前に始めたことにするか。`manualAdvance` は手動にするフェーズの切り替わり、
    /// `losesAnswers` は、記録先には通したうえで答えを返さない開始・操作の頼みの数。`currentDelay` は今の様子の頼みに
    /// 答えるまでの秒数、`losesCurrent` は答えを返さない今の様子の頼みの数（`StubPhoneLink`）
    @MainActor
    private func launch(
        phone: String, startsAfter: Double? = nil, startedAgo: Double? = nil, manualAdvance: String? = nil,
        losesAnswers: Int? = nil, currentDelay: Double? = nil, losesCurrent: Int? = nil, showsVibrations: Bool = false
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = ["NANAICHI_WATCH_PHONE": phone]
        if let startsAfter { app.launchEnvironment["NANAICHI_WATCH_PHONE_STARTS_AFTER"] = String(startsAfter) }
        if let startedAgo { app.launchEnvironment["NANAICHI_WATCH_PHONE_STARTED_AGO"] = String(startedAgo) }
        if let manualAdvance { app.launchEnvironment["NANAICHI_MANUAL_ADVANCE"] = manualAdvance }
        if let losesAnswers { app.launchEnvironment["NANAICHI_WATCH_PHONE_LOSES_ANSWERS"] = String(losesAnswers) }
        if let currentDelay { app.launchEnvironment["NANAICHI_WATCH_PHONE_CURRENT_DELAY"] = String(currentDelay) }
        if let losesCurrent { app.launchEnvironment["NANAICHI_WATCH_PHONE_LOSES_CURRENT"] = String(losesCurrent) }
        if showsVibrations { app.launchEnvironment["NANAICHI_WATCH_SHOW_VIBRATIONS"] = "1" }
        app.launch()
        // iPhone の代わりのスナップショットが届くと、開始のボタンかフェーズが出る（読み込み中でなくなる）。CI のシミュレーターでは、
        // 起動してからここまでに 10 秒を超えることがある
        let start = app.buttons["timer.start"]
        let phase = app.staticTexts["timer.phase"]
        let deadline = Date().addingTimeInterval(30)
        while !start.exists, !phase.exists, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        XCTAssertTrue(start.exists || phase.exists, "起動してから iPhone の代わりの様子が届かない")
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

    /// スクロールする場所がなく、文字・記号・ボタンがどれも大きさを持って画面の中に収まり、互いに重ならない。
    /// 撮った画面を `name` で残す
    @MainActor
    private func assertFitsOnScreen(
        _ app: XCUIApplication, screenshot name: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(app.scrollViews.count, 0, "スクロールする場所がある", file: file, line: line)
        let screen = app.windows.firstMatch.frame
        let elements = [app.staticTexts, app.images, app.buttons].flatMap(\.allElementsBoundByIndex).filter(\.exists)
        for element in elements {
            XCTAssertFalse(
                element.frame.isEmpty, "\(element.identifier)（\(element.label)）に大きさがない", file: file, line: line)
            XCTAssertTrue(
                screen.contains(element.frame),
                "\(element.identifier)（\(element.label)）が画面 \(screen) からはみ出す: \(element.frame)",
                file: file, line: line)
        }
        for (index, element) in elements.enumerated() {
            for other in elements[(index + 1)...] {
                let overlap = element.frame.intersection(other.frame)
                XCTAssertFalse(
                    overlap.width > 0.5 && overlap.height > 0.5,
                    "\(element.identifier)（\(element.label)）と \(other.identifier)（\(other.label)）が重なる",
                    file: file, line: line)
            }
        }
        attachScreenshot(named: name)
    }

    /// ボタンが押せるようになるまで待つ。Watch は iPhone に届いて今の様子を確かめ終えるまで、ボタンを押せなくする
    @MainActor
    private func waitUntilEnabled(_ button: XCUIElement) {
        wait(for: [expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: button)], timeout: 20)
    }

    /// ボタンが押せるようになるまで待って押す
    @MainActor
    private func tapWhenEnabled(_ button: XCUIElement) {
        waitUntilEnabled(button)
        button.tap()
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
        waitUntilEnabled(start)
        XCTAssertFalse(app.images["watch.unreachable"].exists)
        assertFitsOnScreen(app, screenshot: "01-開始前")

        tapWhenEnabled(start)
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

    /// ジャーナルと休憩の画面も、一時停止中も含めて SE 3（40mm）にスクロールせずに収まり、Watch で一時停止・終了できる。
    /// ジャーナル中は中断を出さず、休憩中の休憩スキップは iPhone で行う
    @MainActor
    func testJournalAndBreakFitOnScreen() {
        // 集中の7分と30秒
        let journal = launch(phone: "stub", startedAgo: 7 * 60 + 30)
        tapWhenEnabled(journal.buttons["timer.start"])
        waitFor(journal, "timer.phase", toRead: "ジャーナル")
        assertIconButton(journal.buttons["operation.Pause"], reads: "一時停止")
        XCTAssertFalse(journal.buttons["operation.Abort"].exists, "ジャーナル中に中断が出ている")
        assertFitsOnScreen(journal, screenshot: "05-ジャーナル中")
        journal.buttons["operation.Pause"].tap()
        XCTAssertTrue(journal.images["timer.paused"].waitForExistence(timeout: 10), "ジャーナルが一時停止中にならない")
        assertIconButton(journal.buttons["operation.Resume"], reads: "再開")
        assertFitsOnScreen(journal, screenshot: "06-一時停止中のジャーナル")
        journal.buttons["operation.End"].tap()
        XCTAssertTrue(journal.buttons["timer.start"].waitForExistence(timeout: 10), "ジャーナル中に終了できない")
        journal.terminate()

        // 3セットの24分と30秒
        let breakTime = launch(phone: "stub", startedAgo: 24 * 60 + 30)
        tapWhenEnabled(breakTime.buttons["timer.start"])
        waitFor(breakTime, "timer.phase", toRead: "休憩")
        waitFor(breakTime, "timer.position", toRead: "1ラウンド目")
        assertIconButton(breakTime.buttons["operation.Pause"], reads: "一時停止")
        assertIconButton(breakTime.buttons["operation.End"], reads: "終了")
        XCTAssertFalse(breakTime.buttons["operation.SkipBreak"].exists, "休憩スキップが Watch に出ている")
        assertFitsOnScreen(breakTime, screenshot: "07-休憩中")
        breakTime.buttons["operation.Pause"].tap()
        XCTAssertTrue(breakTime.images["timer.paused"].waitForExistence(timeout: 10), "休憩が一時停止中にならない")
        assertIconButton(breakTime.buttons["operation.Resume"], reads: "再開")
        assertFitsOnScreen(breakTime, screenshot: "08-一時停止中の休憩")
        breakTime.buttons["operation.End"].tap()
        XCTAssertTrue(breakTime.buttons["timer.start"].waitForExistence(timeout: 10), "休憩中に終了できない")
    }

    /// 手動の切り替わりの切り替え待ちも SE 3（40mm）に収まり、進めるのは iPhone で行うと出す
    @MainActor
    func testAwaitingAdvanceFitsOnScreen() {
        let app = launch(phone: "stub", startedAgo: 7 * 60 + 5, manualAdvance: "FocusToJournal")
        tapWhenEnabled(app.buttons["timer.start"])
        waitFor(app, "timer.phase", toRead: "切り替え待ち")
        XCTAssertTrue(app.staticTexts["watch.advanceOnPhone"].exists, "進めるのは iPhone で、と出ない")
        assertIconButton(app.buttons["operation.End"], reads: "終了")
        XCTAssertFalse(app.buttons["operation.Advance"].exists, "進めるが Watch に出ている")
        assertFitsOnScreen(app, screenshot: "09-切り替え待ち")
    }

    /// 開始の答えが Watch に返らなかったら、届かなかったと重ねて出し、今の様子を頼み直す。
    /// iPhone には届いて記録されていたので、セッションが始まった様子に替わる
    @MainActor
    func testUnansweredRequestResyncs() {
        let app = launch(phone: "stub", losesAnswers: 1)
        tapWhenEnabled(app.buttons["timer.start"])
        // watchOS のアラートは XCUITest の alerts に出ないので、文言で探す
        let notice = app.staticTexts["iPhone に届きませんでした。もう一度お試しください。"]
        XCTAssertTrue(notice.waitForExistence(timeout: 10), "答えが返らなかったことを出さない")
        attachScreenshot(named: "13-iPhone から答えが返らなかった")
        app.buttons["OK"].tap()
        waitFor(app, "timer.phase", toRead: "集中")
        XCTAssertTrue(app.buttons["operation.Pause"].waitForExistence(timeout: 10))
        waitUntilEnabled(app.buttons["operation.Pause"])
    }

    /// iPhone に届くようになっても、今の様子を確かめ終えるまでは押せない。確かめの答えが返らなければ、押せないまま頼み直し、
    /// 確かめられたら押せるようにする。代わりの iPhone は今の様子に3秒かけて答え、1回目は答えを返さない
    @MainActor
    func testButtonsWaitUntilCurrentIsConfirmed() {
        let app = launch(phone: "stub", currentDelay: 3, losesCurrent: 1)
        let start = app.buttons["timer.start"]
        XCTAssertFalse(start.isEnabled, "今の様子を確かめ終える前に開始を押せる")
        // 1回目の確かめ（3秒）が答えを返さずに終わったあと、頼み直しの答え（さらに1秒待って3秒）を待っているところ
        Thread.sleep(forTimeInterval: 4.5)
        XCTAssertFalse(start.isEnabled, "今の様子を確かめられなかったのに開始を押せる")
        waitUntilEnabled(start)
    }

    /// 集中からジャーナルへの切り替わりで、1回の知らせとして振動を3回続けて鳴らし、それきり鳴らさない（Issue #73）。
    /// 集中の残りが数秒のセッションを始める。振動そのものはシミュレーターで感じられないので、鳴らした振動の数を読む
    @MainActor
    func testVibratesOnceOnPhaseChange() {
        let app = launch(phone: "stub", startedAgo: 7 * 60 - 12, showsVibrations: true)
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        waitFor(app, "watch.vibrations", toRead: "0")

        tapWhenEnabled(start)
        waitFor(app, "timer.phase", toRead: "集中")
        attachScreenshot(named: "14-振動で知らせる集中中")

        waitFor(app, "timer.phase", toRead: "ジャーナル", timeout: 20)
        waitFor(app, "watch.vibrations", toRead: "3")
        // 同じ切り替わりで、もう一度は知らせない
        Thread.sleep(forTimeInterval: 3)
        waitFor(app, "watch.vibrations", toRead: "3", timeout: 1)
        attachScreenshot(named: "15-ジャーナルに切り替わって振動した")
    }

    /// iPhone の側で始めたセッションが、Watch の表示に出る。Watch では何も押さない
    @MainActor
    func testShowsSessionStartedOnPhone() {
        let app = launch(phone: "stub", startsAfter: 3)
        waitFor(app, "timer.phase", toRead: "集中", timeout: 20)
        XCTAssertTrue(app.buttons["operation.Pause"].waitForExistence(timeout: 10))
        attachScreenshot(named: "10-iPhone で始めたセッション")
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
        assertFitsOnScreen(app, screenshot: "11-iPhone に繋がっていない")
    }

    /// セッション中に iPhone に届かなくなっても、届かないことの記号をフェーズの横に並べて SE 3（40mm）に収まり、操作できない。
    /// 代わりの iPhone が、ジャーナルに入ったセッションを始めたあと届かなくなる
    @MainActor
    func testPhoneUnreachableInSessionFitsOnScreen() {
        let app = launch(phone: "unreachable", startsAfter: 0, startedAgo: 7 * 60 + 30)
        waitFor(app, "timer.phase", toRead: "ジャーナル")
        XCTAssertTrue(app.images["watch.unreachable"].waitForExistence(timeout: 10))
        let pause = app.buttons["operation.Pause"]
        XCTAssertTrue(pause.waitForExistence(timeout: 10))
        XCTAssertFalse(pause.isEnabled, "iPhone に届かないのに一時停止を押せる")
        XCTAssertFalse(app.buttons["operation.End"].isEnabled, "iPhone に届かないのに終了を押せる")
        assertFitsOnScreen(app, screenshot: "12-セッション中に iPhone に繋がっていない")
    }
}
