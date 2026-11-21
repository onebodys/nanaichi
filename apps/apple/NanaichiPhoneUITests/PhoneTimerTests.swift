import XCTest

/// iPhone で、この端末の記録先のタイマーとジャーナル記入を最後まで使う（Issue #70）。
///
/// 時計を速めて進め（デバッグのビルドにだけある起動のしかた、`DeviceLaunch`）、記録はテスト用のファイルに置き、
/// ほかの記録と混ぜない。テストを変えたら、Mac の `NanaichiUITests/TimerTests.swift` と場面をそろえる
final class PhoneTimerTests: XCTestCase {
    private let database = "uitest-phone-timer.sqlite"
    /// 開き直しても時刻が続くよう、同じテストの中の起動には同じ起点を渡す
    private var origin: Int64 = 0

    override func setUp() {
        continueAfterFailure = false
        origin = Int64(Date().timeIntervalSince1970 * 1000)
    }

    @MainActor
    /// `manualAdvance` は手動にするフェーズの切り替わり（`NANAICHI_MANUAL_ADVANCE`）。空ならすべて自動
    private func launch(
        timeScale: Double, resetting reset: Bool, appearance: String = "Light", manualAdvance: String = ""
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_TIME_SCALE": String(timeScale), "NANAICHI_TIME_ORIGIN": String(origin),
            "NANAICHI_DATABASE": database, "NANAICHI_RESET_DATABASE": reset ? "1" : "0",
            "NANAICHI_RESET_DEFAULTS": reset ? "1" : "0", "NANAICHI_APPEARANCE": appearance,
            "NANAICHI_MANUAL_ADVANCE": manualAdvance,
        ]
        app.launch()
        return app
    }

    /// 通知の許可を求める画面と、届いた通知のバナーを出すホーム画面
    @MainActor
    private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

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

    /// 開始ボタンで通知の許可を求められたら許可する。前のテストで答えていれば、もう聞かれない
    @MainActor
    private func allowNotificationsIfAsked() {
        let allow = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["許可", "Allow"])).firstMatch
        if allow.waitForExistence(timeout: 5) { allow.tap() }
    }

    /// 1ラウンドを最後まで進め、開き直しても続き、終了してまとめが出る
    @MainActor
    func testOneRoundOnTheDeviceRecordStore() throws {
        // 8倍なら集中は53秒、ジャーナルは7.5秒、休憩は38秒。iPhone の XCUITest は刻みのたびに描き直す画面で
        // 1回の操作に数秒かかり、短いジャーナルの間に操作が間に合わないことがある。そこで、ジャーナルから集中への
        // 切り替わりを手動にし、ジャーナルが終わったら切り替え待ちで止まるようにして、そこで書いて進める
        let timeScale = 8.0
        func phaseTimeout(minutes: Double) -> TimeInterval { minutes * 60 / timeScale + 20 }

        var app = launch(timeScale: timeScale, resetting: true, manualAdvance: "JournalToFocus")
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        attachScreenshot(named: "01-開始前")

        start.tap()
        allowNotificationsIfAsked()
        waitFor(app, "timer.phase", toRead: "集中")
        waitFor(app, "timer.position", toRead: "1ラウンド目・1セット目")
        attachScreenshot(named: "02-集中中")

        app.buttons["operation.Pause"].tap()
        XCTAssertTrue(app.staticTexts["timer.paused"].waitForExistence(timeout: 10), "一時停止にならない")
        attachScreenshot(named: "03-一時停止中")
        app.buttons["operation.Resume"].tap()
        XCTAssertTrue(app.staticTexts["timer.paused"].waitForNonExistence(timeout: 10), "再開しない")

        // ジャーナルが終わると、集中を始めるのを待つ。ジャーナルに入ったときに入力欄にカーソルが置かれ、キーボードが出ている
        let advance = app.buttons["operation.Advance"]
        XCTAssertTrue(advance.waitForExistence(timeout: phaseTimeout(minutes: 8)), "ジャーナルのあとの切り替え待ちにならない")
        waitFor(app, "timer.phase", toRead: "切り替え待ち")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "ジャーナルに入ってもキーボードが出ない")
        let body = app.textViews["journal.body"]
        body.typeText("1セット目の振り返り\n次は見出しを直す")
        XCTAssertEqual(body.value as? String, "1セット目の振り返り\n次は見出しを直す", "Return で改行しない")
        attachScreenshot(named: "04-ジャーナルを書いている")
        app.buttons["journal.sendFromKeyboard"].tap()
        expectation(for: NSPredicate(format: "value == ''"), evaluatedWith: body)
        waitForExpectations(timeout: 10)
        app.buttons["journal.dismissKeyboard"].tap()
        attachScreenshot(named: "05-記入して切り替え待ち")
        advance.tap()
        waitFor(app, "timer.position", toRead: "1ラウンド目・2セット目")
        waitFor(app, "timer.phase", toRead: "集中")

        // 2セット目のジャーナルのあとも切り替え待ちになるので進める。3セット目のジャーナルのあとは休憩に自動で入る
        XCTAssertTrue(advance.waitForExistence(timeout: phaseTimeout(minutes: 8)), "2セット目のジャーナルのあとの切り替え待ちにならない")
        dismissKeyboardIfShown(app)
        advance.tap()
        waitFor(app, "timer.position", toRead: "1ラウンド目・3セット目")
        waitFor(app, "timer.phase", toRead: "休憩", timeout: phaseTimeout(minutes: 8))
        dismissKeyboardIfShown(app)
        attachScreenshot(named: "06-休憩")
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目", timeout: phaseTimeout(minutes: 5))
        waitFor(app, "timer.phase", toRead: "集中")
        attachScreenshot(named: "07-次のラウンドの集中")

        app.buttons["operation.Abort"].tap()
        waitFor(app, "timer.phase", toRead: "待機")
        XCTAssertTrue(app.staticTexts["timer.idle"].waitForExistence(timeout: 10))
        attachScreenshot(named: "08-中断して待機")
        app.buttons["operation.RestartFocus"].tap()
        waitFor(app, "timer.phase", toRead: "集中")

        // 終了して開き直しても、同じ記録からセッションが続く（ダークの見た目もここで確かめる）
        app.terminate()
        app = launch(timeScale: timeScale, resetting: false, appearance: "Dark", manualAdvance: "JournalToFocus")
        waitFor(app, "timer.phase", toRead: "集中")
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目")
        attachScreenshot(named: "09-開き直したあと（ダーク）")

        app.buttons["operation.End"].tap()
        XCTAssertTrue(app.staticTexts["summary.title"].waitForExistence(timeout: 10), "まとめが出ない")
        waitFor(app, "summary.completedSets", toRead: "3")
        waitFor(app, "summary.entries", toRead: "1")
        waitFor(app, "summary.focusTime", toRead: "21分")
        attachScreenshot(named: "10-セッションのまとめ")
    }

    /// アプリを閉じていても（裏に回したあと終了しても）、フェーズの切り替わりが通知で届く
    @MainActor
    func testPhaseChangeNotifiesWhileClosed() throws {
        // 30倍なら集中は14秒。開始してからホームに戻り、アプリを終了するまでに切り替わらない長さ
        let app = launch(timeScale: 30, resetting: true)
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        allowNotificationsIfAsked()
        waitFor(app, "timer.phase", toRead: "集中")

        XCUIDevice.shared.press(.home)
        // 裏に回ったときに通知の予約を入れ替えるのを待ってから、アプリを終了する
        Thread.sleep(forTimeInterval: 2)
        app.terminate()

        let notification = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "ジャーナルの時間です")).firstMatch
        // バナーは数秒で消え、ホーム画面の要素を探すのが遅いと見逃すので、見つからなければ通知センターを開いて探す
        if !notification.waitForExistence(timeout: 30) {
            let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.01))
            top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)))
            XCTAssertTrue(notification.waitForExistence(timeout: 10), "ジャーナルに切り替わった通知が届かない")
        }
        attachScreenshot(named: "11-閉じている間に届いた通知")
    }

    @MainActor
    private func dismissKeyboardIfShown(_ app: XCUIApplication) {
        let done = app.buttons["journal.dismissKeyboard"]
        if done.exists, done.isHittable { done.tap() }
    }
}
