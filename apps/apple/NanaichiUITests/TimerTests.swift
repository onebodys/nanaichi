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

    @MainActor
    private func launch(resetting reset: Bool, appearance: String = "Light") -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_TIME_SCALE": String(timeScale), "NANAICHI_TIME_ORIGIN": String(origin),
            "NANAICHI_DATABASE": database, "NANAICHI_RESET_DATABASE": reset ? "1" : "0",
            "NANAICHI_APPEARANCE": appearance,
        ]

        app.launch()
        return app
    }

    /// 識別子 `identifier` の文字が `label` になるまで待つ。macOS の StaticText は文字を `value` に持ち、`label` は空になる
    @MainActor
    private func waitFor(
        _ app: XCUIApplication, _ identifier: String, toRead label: String, timeout: TimeInterval = 10,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let element = app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND (value == %@ OR label == %@)", identifier, label, label))
            .firstMatch
        XCTAssertTrue(
            element.waitForExistence(timeout: timeout), "\(identifier) が「\(label)」にならない", file: file, line: line)
    }

    /// 時間が過ぎるのを待つ時間（実際の秒）。`minutes` 分のタイマーの時間に、余裕を足す
    private func phaseTimeout(minutes: Double) -> TimeInterval {
        minutes * 60 / timeScale + 10
    }

    @MainActor
    func testOneRoundOnTheDeviceRecordStore() throws {
        var app = launch(resetting: true)
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        attachScreenshot(of: app, named: "01-開始前")

        start.click()
        waitFor(app, "timer.phase", toRead: "集中")
        waitFor(app, "timer.position", toRead: "1ラウンド目・1セット目")
        attachScreenshot(of: app, named: "02-集中中")

        // ジャーナルは4秒しかないので、入ったらすぐ撮って一時停止し、止めたまま書く
        waitFor(app, "timer.phase", toRead: "ジャーナル", timeout: phaseTimeout(minutes: 7))
        attachScreenshot(of: app, named: "03-ジャーナル")
        app.typeKey("p", modifierFlags: .command)
        XCTAssertTrue(app.staticTexts["timer.paused"].waitForExistence(timeout: 5), "一時停止にならない")
        waitFor(app, "timer.phase", toRead: "ジャーナル")

        let body = app.textViews["journal.body"]
        body.click()
        body.typeText("1セット目の振り返り\n次は見出しを直す")
        XCTAssertEqual(body.value as? String, "1セット目の振り返り\n次は見出しを直す", "Return で改行しない")
        body.typeKey(.return, modifierFlags: .command)
        let sent = NSPredicate(format: "value == ''")
        expectation(for: sent, evaluatedWith: body)
        waitForExpectations(timeout: 5)
        attachScreenshot(of: app, named: "04-一時停止中に記入した")

        app.typeKey("r", modifierFlags: .command)
        XCTAssertTrue(app.staticTexts["timer.paused"].waitForNonExistence(timeout: 5), "再開しない")

        // 残りの2セットと休憩は、時間が過ぎるのに任せる
        waitFor(app, "timer.position", toRead: "1ラウンド目・2セット目", timeout: phaseTimeout(minutes: 1))
        waitFor(app, "timer.position", toRead: "1ラウンド目・3セット目", timeout: phaseTimeout(minutes: 8))
        waitFor(app, "timer.phase", toRead: "休憩", timeout: phaseTimeout(minutes: 8))
        attachScreenshot(of: app, named: "05-休憩")
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目", timeout: phaseTimeout(minutes: 5))
        waitFor(app, "timer.phase", toRead: "集中")
        attachScreenshot(of: app, named: "06-次のラウンドの集中")

        app.buttons["operation.Abort"].click()
        waitFor(app, "timer.phase", toRead: "待機")
        XCTAssertTrue(app.staticTexts["timer.idle"].waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "07-中断して待機")
        app.buttons["operation.RestartFocus"].click()
        waitFor(app, "timer.phase", toRead: "集中")

        // 終了して開き直しても、同じ記録からセッションが続く（ダークの見た目もここで確かめる）
        app.terminate()
        app = launch(resetting: false, appearance: "Dark")
        waitFor(app, "timer.phase", toRead: "集中")
        waitFor(app, "timer.position", toRead: "2ラウンド目・1セット目")
        attachScreenshot(of: app, named: "08-開き直したあと（ダーク）")

        app.buttons["operation.End"].click()
        XCTAssertTrue(app.staticTexts["summary.title"].waitForExistence(timeout: 5), "まとめが出ない")
        waitFor(app, "summary.completedSets", toRead: "3")
        waitFor(app, "summary.entries", toRead: "1")
        waitFor(app, "summary.focusTime", toRead: "21分")
        attachScreenshot(of: app, named: "09-セッションのまとめ")
    }
}
