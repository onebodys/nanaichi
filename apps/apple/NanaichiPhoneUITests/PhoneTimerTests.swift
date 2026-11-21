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
    private func launch(timeScale: Double, resetting reset: Bool, appearance: String = "Light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_TIME_SCALE": String(timeScale), "NANAICHI_TIME_ORIGIN": String(origin),
            "NANAICHI_DATABASE": database, "NANAICHI_RESET_DATABASE": reset ? "1" : "0",
            "NANAICHI_RESET_DEFAULTS": reset ? "1" : "0", "NANAICHI_APPEARANCE": appearance,
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
        // 4倍なら集中は105秒、ジャーナルは15秒、休憩は75秒。iPhone の XCUITest は刻みのたびに描き直す画面で
        // 1回の操作に数秒かかり、8倍（ジャーナルが7.5秒）ではジャーナルに入ってから一時停止を押すまでに終わってしまう
        let timeScale = 4.0
        func phaseTimeout(minutes: Double) -> TimeInterval { minutes * 60 / timeScale + 10 }

        var app = launch(timeScale: timeScale, resetting: true)
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        attachScreenshot(named: "01-開始前")

        start.tap()
        allowNotificationsIfAsked()
        waitFor(app, "timer.phase", toRead: "集中")
        waitFor(app, "timer.position", toRead: "1ラウンド目・1セット目")
        attachScreenshot(named: "02-集中中")

        // ジャーナルは短いので、入ったらすぐ一時停止し、止めてから撮って書く
        waitFor(app, "timer.phase", toRead: "ジャーナル", timeout: phaseTimeout(minutes: 7))
        app.buttons["operation.Pause"].tap()
        XCTAssertTrue(app.staticTexts["timer.paused"].waitForExistence(timeout: 5), "一時停止にならない")
        waitFor(app, "timer.phase", toRead: "ジャーナル")

        // ジャーナルに入ると入力欄にカーソルが置かれ、キーボードが出る
        let body = app.textViews["journal.body"]
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "ジャーナルに入ってもキーボードが出ない")
        attachScreenshot(named: "03-ジャーナル")
        body.typeText("1セット目の振り返り\n次は見出しを直す")
        XCTAssertEqual(body.value as? String, "1セット目の振り返り\n次は見出しを直す", "Return で改行しない")
        app.buttons["journal.sendFromKeyboard"].tap()
        expectation(for: NSPredicate(format: "value == ''"), evaluatedWith: body)
        waitForExpectations(timeout: 5)
        app.buttons["journal.dismissKeyboard"].tap()
        attachScreenshot(named: "04-一時停止中に記入した")

        app.buttons["operation.Resume"].tap()
        XCTAssertTrue(app.staticTexts["timer.paused"].waitForNonExistence(timeout: 5), "再開しない")

        // 残りの2セットと休憩は、時間が過ぎるのに任せる。ジャーナルのたびにキーボードが出るので、閉じておく
        waitFor(app, "timer.position", toRead: "1ラウンド目・2セット目", timeout: phaseTimeout(minutes: 1))
        waitFor(app, "timer.position", toRead: "1ラウンド目・3セット目", timeout: phaseTimeout(minutes: 8))
        waitFor(app, "timer.phase", toRead: "休憩", timeout: phaseTimeout(minutes: 8))
        dismissKeyboardIfShown(app)
        attachScreenshot(named: "05-休憩")
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目", timeout: phaseTimeout(minutes: 5))
        waitFor(app, "timer.phase", toRead: "集中")
        attachScreenshot(named: "06-次のラウンドの集中")

        app.buttons["operation.Abort"].tap()
        waitFor(app, "timer.phase", toRead: "待機")
        XCTAssertTrue(app.staticTexts["timer.idle"].waitForExistence(timeout: 5))
        attachScreenshot(named: "07-中断して待機")
        app.buttons["operation.RestartFocus"].tap()
        waitFor(app, "timer.phase", toRead: "集中")

        // 終了して開き直しても、同じ記録からセッションが続く（ダークの見た目もここで確かめる）
        app.terminate()
        app = launch(timeScale: timeScale, resetting: false, appearance: "Dark")
        waitFor(app, "timer.phase", toRead: "集中")
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目")
        attachScreenshot(named: "08-開き直したあと（ダーク）")

        app.buttons["operation.End"].tap()
        XCTAssertTrue(app.staticTexts["summary.title"].waitForExistence(timeout: 5), "まとめが出ない")
        waitFor(app, "summary.completedSets", toRead: "3")
        waitFor(app, "summary.entries", toRead: "1")
        waitFor(app, "summary.focusTime", toRead: "21分")
        attachScreenshot(named: "09-セッションのまとめ")
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

        let banner = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "ジャーナルの時間です")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 30), "ジャーナルに切り替わった通知が届かない")
        attachScreenshot(named: "10-閉じている間に届いた通知")
    }

    @MainActor
    private func dismissKeyboardIfShown(_ app: XCUIApplication) {
        let done = app.buttons["journal.dismissKeyboard"]
        if done.exists, done.isHittable { done.tap() }
    }
}
