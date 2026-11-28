import XCTest

/// この端末の記録先で、タイマーとジャーナル記入を最後まで使う（Issue #142）。
///
/// 時計を `timeScale` 倍で進め（デバッグのビルドにだけある起動のしかた、`LaunchConfiguration`）、
/// 1ラウンド（29分）を2分ほどで進める。記録はテスト用のファイルに置き、ほかの記録と混ぜない
final class TimerTests: XCTestCase {
    /// 15倍なら集中は28秒、ジャーナルは4秒、休憩は20秒
    private let timeScale = 15.0
    private let database = "uitest-timer.sqlite"
    /// 開き直しても時刻が続くよう、2回の起動で同じ起点を渡す
    private var origin: Int64 = 0

    override func setUp() {
        continueAfterFailure = false
        origin = Int64(Date().timeIntervalSince1970 * 1000)
    }

    /// 起動するアプリ
    @MainActor
    private func application(resetting reset: Bool, appearance: String = "Light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_TIME_SCALE": String(timeScale), "NANAICHI_TIME_ORIGIN": String(origin),
            "NANAICHI_DATABASE": database, "NANAICHI_RESET_DATABASE": reset ? "1" : "0",
            "NANAICHI_APPEARANCE": appearance,
        ]

        // 前のテストが開いたウィンドウ（スタッツなど）を復元させない。復元したウィンドウがメインのウィンドウに重なり、クリックが当たらなくなる
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        return app
    }

    /// 操作を断ったときの文言
    @MainActor
    private func timerError(_ app: XCUIApplication) -> [XCUIElement] { [app.staticTexts["timer.error"]] }

    /// 時間が過ぎるのを待つ時間（実際の秒）。`minutes` 分のタイマーの時間に、余裕を足す
    private func phaseTimeout(minutes: Double) -> TimeInterval {
        minutes * 60 / timeScale + 10
    }

    @MainActor
    func testOneRoundOnTheDeviceRecordStore() throws {
        var app = application(resetting: true)
        let start = app.buttons["timer.start"]
        launch(app, until: .appears(start, failure: "メインのウィンドウが開かない"))
        attachScreenshot(of: app, named: "01-開始前")

        click(start, until: .reads(app, "timer.phase", "集中"), failsOn: timerError(app))
        waitFor(app, "timer.position", toRead: "1ラウンド目・1セット目")
        attachScreenshot(of: app, named: "02-集中中")

        // ジャーナルは4秒しかないので、入ったらすぐ一時停止し、止めてから撮って書く。
        // スクリーンショットは CI で3秒ほどかかり、先に撮るとジャーナルが終わってから止まる
        waitFor(app, "timer.phase", toRead: "ジャーナル", timeout: phaseTimeout(minutes: 7))
        perform(
            { _ in app.typeKey("p", modifierFlags: .command) },
            until: .appears(app.staticTexts["timer.paused"], failure: "一時停止にならない"), failsOn: timerError(app))
        waitFor(app, "timer.phase", toRead: "ジャーナル")
        attachScreenshot(of: app, named: "03-ジャーナル")

        let body = app.textViews["journal.body"]
        type("1セット目の振り返り\n次は見出しを直す", into: body, toRead: "1セット目の振り返り\n次は見出しを直す", "Return で改行しない")
        perform(
            { _ in body.typeKey(.return, modifierFlags: .command) },
            until: .equals({ body.value as? String }, "", "送ったあとの入力欄の本文"))
        attachScreenshot(of: app, named: "04-一時停止中に記入した")

        perform(
            { _ in app.typeKey("r", modifierFlags: .command) },
            until: .disappears(app.staticTexts["timer.paused"], failure: "再開しない"), failsOn: timerError(app))

        // 残りの2セットと休憩は、時間が過ぎるのに任せる
        waitFor(app, "timer.position", toRead: "1ラウンド目・2セット目", timeout: phaseTimeout(minutes: 1))
        waitFor(app, "timer.position", toRead: "1ラウンド目・3セット目", timeout: phaseTimeout(minutes: 8))
        waitFor(app, "timer.phase", toRead: "休憩", timeout: phaseTimeout(minutes: 8))
        attachScreenshot(of: app, named: "05-休憩")
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目", timeout: phaseTimeout(minutes: 5))
        waitFor(app, "timer.phase", toRead: "集中")
        attachScreenshot(of: app, named: "06-次のラウンドの集中")

        click(app.buttons["operation.Abort"], until: .reads(app, "timer.phase", "待機"), failsOn: timerError(app))
        XCTAssertTrue(app.staticTexts["timer.idle"].waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "07-中断して待機")
        click(app.buttons["operation.RestartFocus"], until: .reads(app, "timer.phase", "集中"), failsOn: timerError(app))

        // 終了して開き直しても、同じ記録からセッションが続く（ダークの見た目もここで確かめる）
        app.terminate()
        app = application(resetting: false, appearance: "Dark")
        launch(app, until: .reads(app, "timer.phase", "集中"))
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目")
        attachScreenshot(of: app, named: "08-開き直したあと（ダーク）")

        click(
            app.buttons["operation.End"], until: .appears(app.staticTexts["summary.title"], failure: "まとめが出ない"),
            failsOn: timerError(app))
        waitFor(app, "summary.completedSets", toRead: "3")
        waitFor(app, "summary.entries", toRead: "1")
        waitFor(app, "summary.focusTime", toRead: "21分")
        attachScreenshot(of: app, named: "09-セッションのまとめ")
    }
}
