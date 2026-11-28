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
        allowNotificationsWhenTheyInterrupt()
    }

    /// 起動するアプリ。`manualAdvance` は手動にするフェーズの切り替わり（`NANAICHI_MANUAL_ADVANCE`）。空ならすべて自動
    @MainActor
    private func application(
        timeScale: Double, resetting reset: Bool, appearance: String = "Light", manualAdvance: String = ""
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_TIME_SCALE": String(timeScale), "NANAICHI_TIME_ORIGIN": String(origin),
            "NANAICHI_DATABASE": database, "NANAICHI_RESET_DATABASE": reset ? "1" : "0",
            "NANAICHI_RESET_DEFAULTS": reset ? "1" : "0", "NANAICHI_APPEARANCE": appearance,
            "NANAICHI_MANUAL_ADVANCE": manualAdvance,
        ]
        return app
    }

    /// 届いた通知のバナーを出すホーム画面
    @MainActor
    private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    /// 1ラウンドを最後まで進め、開き直しても続き、終了してまとめが出る
    @MainActor
    func testOneRoundOnTheDeviceRecordStore() throws {
        // 8倍なら集中は53秒、ジャーナルは7.5秒、休憩は38秒。iPhone の XCUITest は刻みのたびに描き直す画面で
        // 1回の操作に数秒かかり、短いジャーナルの間に操作が間に合わないことがある。そこで、ジャーナルから集中への
        // 切り替わりを手動にし、ジャーナルが終わったら切り替え待ちで止まるようにして、そこで書いて進める
        let timeScale = 8.0
        func phaseTimeout(minutes: Double) -> TimeInterval { minutes * 60 / timeScale + 20 }

        var app = application(timeScale: timeScale, resetting: true, manualAdvance: "JournalToFocus")
        let start = app.buttons["timer.start"]
        launch(app, until: .appears(start, failure: "ホームが開かない"))
        attachScreenshot(named: "01-開始前")

        tap(start, until: .reads(app, "timer.phase", "集中"))
        allowNotificationsIfAsked()
        waitFor(app, "timer.position", toRead: "1ラウンド目・1セット目")
        attachScreenshot(named: "02-集中中")

        tap(app.buttons["operation.Pause"], until: .appears(app.staticTexts["timer.paused"], failure: "一時停止にならない"))
        attachScreenshot(named: "03-一時停止中")
        tap(app.buttons["operation.Resume"], until: .disappears(app.staticTexts["timer.paused"], failure: "再開しない"))

        // ジャーナルが終わると、集中を始めるのを待つ。ジャーナルに入ったときに入力欄にカーソルが置かれ、キーボードが出ている
        let advance = app.buttons["operation.Advance"]
        XCTAssertTrue(advance.waitForExistence(timeout: phaseTimeout(minutes: 8)), "ジャーナルのあとの切り替え待ちにならない")
        waitFor(app, "timer.phase", toRead: "切り替え待ち")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "ジャーナルに入ってもキーボードが出ない")
        let body = app.textViews["journal.body"]
        type("1セット目の振り返り", into: body, toRead: "1セット目の振り返り")
        type("\n次は見出しを直す", into: body, toRead: "1セット目の振り返り\n次は見出しを直す", "Return で改行しない")
        attachScreenshot(named: "04-ジャーナルを書いている")
        tap(app.buttons["journal.sendFromKeyboard"], until: .equals({ body.value as? String }, "", "送ったあとの入力欄の本文"))
        tap(app.buttons["journal.dismissKeyboard"], until: .disappears(app.keyboards.firstMatch, failure: "キーボードが閉じない"))
        attachScreenshot(named: "05-記入して切り替え待ち")
        tap(advance, until: .reads(app, "timer.position", "1ラウンド目・2セット目"))
        waitFor(app, "timer.phase", toRead: "集中")

        // 2セット目のジャーナルのあとも切り替え待ちになるので進める。3セット目のジャーナルのあとは休憩に自動で入る
        XCTAssertTrue(advance.waitForExistence(timeout: phaseTimeout(minutes: 8)), "2セット目のジャーナルのあとの切り替え待ちにならない")
        dismissKeyboardIfShown(app)
        tap(advance, until: .reads(app, "timer.position", "1ラウンド目・3セット目"))
        waitFor(app, "timer.phase", toRead: "休憩", timeout: phaseTimeout(minutes: 8))
        dismissKeyboardIfShown(app)
        attachScreenshot(named: "06-休憩")
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目", timeout: phaseTimeout(minutes: 5))
        waitFor(app, "timer.phase", toRead: "集中")
        attachScreenshot(named: "07-次のラウンドの集中")

        tap(app.buttons["operation.Abort"], until: .reads(app, "timer.phase", "待機"))
        XCTAssertTrue(app.staticTexts["timer.idle"].waitForExistence(timeout: 10))
        attachScreenshot(named: "08-中断して待機")
        tap(app.buttons["operation.RestartFocus"], until: .reads(app, "timer.phase", "集中"))

        // 終了して開き直しても、同じ記録からセッションが続く（ダークの見た目もここで確かめる）
        app.terminate()
        app = application(timeScale: timeScale, resetting: false, appearance: "Dark", manualAdvance: "JournalToFocus")
        launch(app, until: .reads(app, "timer.phase", "集中"))
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目")
        attachScreenshot(named: "09-開き直したあと（ダーク）")

        tap(app.buttons["operation.End"], until: .appears(app.staticTexts["summary.title"], failure: "まとめが出ない"))
        waitFor(app, "summary.completedSets", toRead: "3")
        waitFor(app, "summary.entries", toRead: "1")
        waitFor(app, "summary.focusTime", toRead: "21分")
        attachScreenshot(named: "10-セッションのまとめ")
    }

    /// アプリを閉じていても（裏に回したあと終了しても）、フェーズの切り替わりが通知で届く
    @MainActor
    func testPhaseChangeNotifiesWhileClosed() throws {
        // 20倍なら集中は21秒。開始してからホームに戻り、アプリを終了するまでに切り替わらない長さ。
        // 前のテストで通知を許可していると、許可を求める画面を10秒待ってから進むので、その分も含めておく
        let app = application(timeScale: 20, resetting: true)
        let start = app.buttons["timer.start"]
        launch(app, until: .appears(start, failure: "ホームが開かない"))
        tap(start, until: .reads(app, "timer.phase", "集中"))
        allowNotificationsIfAsked()

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
