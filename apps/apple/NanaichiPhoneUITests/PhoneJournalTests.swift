import XCTest

/// iPhone で、送れなかったジャーナル記入を失わずに扱う（Issue #80）。
///
/// はじめの数回の記入を、少し待ってから送れなかったことにして起動する（`NANAICHI_FAIL_JOURNAL_WRITES`、
/// `DebugFailingJournalWrites`）。待っている間に入力欄に書き足す。送り直すときの ID・本文・タグが最初と同じことは、
/// 画面からは見えないので NanaichiKit の `JournalDraftTests` で確かめる
final class PhoneJournalTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launchInSession(failingWrites: Int) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_DATABASE": "uitest-phone-journal.sqlite", "NANAICHI_RESET_DATABASE": "1",
            "NANAICHI_RESET_DEFAULTS": "1", "NANAICHI_APPEARANCE": "Light",
            "NANAICHI_FAIL_JOURNAL_WRITES": String(failingWrites),
        ]
        app.launch()
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        // 通知の許可を求められたら許可する。前のテストで答えていれば、もう聞かれない
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["許可", "Allow"])).firstMatch
        if allow.waitForExistence(timeout: 5) { allow.tap() }
        XCTAssertTrue(app.buttons["operation.Pause"].waitForExistence(timeout: 10), "セッションが始まらない")
        return app
    }

    /// 帯に並んだ送れなかった記入の本文
    @MainActor
    private func unsentBodies(_ app: XCUIApplication) -> [String] {
        app.staticTexts.matching(identifier: "journal.unsent.body").allElementsBoundByIndex.map(\.label)
    }

    @MainActor
    private func waitForUnsent(
        _ app: XCUIApplication, _ expected: [String], file: StaticString = #filePath, line: UInt = #line
    ) {
        let deadline = Date().addingTimeInterval(10)
        while unsentBodies(app) != expected, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        XCTAssertEqual(unsentBodies(app), expected, "帯の記入", file: file, line: line)
    }

    @MainActor
    private func waitForInput(
        _ app: XCUIApplication, toRead text: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        let body = app.textViews["journal.body"]
        let deadline = Date().addingTimeInterval(10)
        while body.value as? String != text, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        XCTAssertEqual(body.value as? String, text, "入力欄の本文", file: file, line: line)
    }

    /// 帯の `index` 番目の記入のボタン
    @MainActor
    private func unsentButton(_ app: XCUIApplication, _ action: String, at index: Int = 0) -> XCUIElement {
        app.buttons.matching(identifier: "journal.unsent.\(action)").element(boundBy: index)
    }

    /// A を送る → 送っている間に B を書く → A が送れないと、入力欄に B が残り、帯に A が出る。
    /// 帯に残したまま B を送って送れなければ、帯に2件並び、A を送り直せても B は消えない。B は入力欄に戻せる
    @MainActor
    func testUnsentEntriesStayInTheBandWhileAppending() throws {
        let app = launchInSession(failingWrites: 2)
        let body = app.textViews["journal.body"]
        body.tap()
        body.typeText("A")
        app.buttons["journal.sendFromKeyboard"].tap()
        body.typeText("B")
        waitForUnsent(app, ["A"])
        waitForInput(app, toRead: "B")
        XCTAssertTrue(app.staticTexts["journal.error"].exists, "送れなかった文言が出ない")

        app.buttons["journal.sendFromKeyboard"].tap()
        body.typeText("C")
        waitForUnsent(app, ["A", "B"])
        waitForInput(app, toRead: "C")
        app.buttons["journal.dismissKeyboard"].tap()
        attachScreenshot(named: "12-送れなかった記入")

        // 3回目からは送れる
        unsentButton(app, "resend", at: 0).tap()
        waitForUnsent(app, ["B"])
        XCTAssertFalse(app.staticTexts["journal.error"].exists, "送り直せても送れなかった文言が残る")

        unsentButton(app, "returnToInput").tap()
        waitForUnsent(app, [])
        XCTAssertFalse(app.otherElements["journal.unsent"].exists, "帯が残る")
        waitForInput(app, toRead: "B\nC")
    }

    /// 書き足していないときに送れなければ、今まで通り入力欄に戻り、帯は出ない。
    /// セッションが終わったあとは、帯の記入は送り直すことも入力欄に戻すこともできず、捨てられる
    @MainActor
    func testUnsentEntryAfterTheSessionEnds() throws {
        let app = launchInSession(failingWrites: 2)
        let body = app.textViews["journal.body"]
        body.tap()
        body.typeText("A")
        app.buttons["journal.sendFromKeyboard"].tap()
        waitForInput(app, toRead: "A")
        XCTAssertTrue(app.staticTexts["journal.error"].exists, "送れなかった文言が出ない")
        XCTAssertFalse(app.otherElements["journal.unsent"].exists, "書き足していないのに帯が出る")

        app.buttons["journal.sendFromKeyboard"].tap()
        body.typeText("B")
        waitForUnsent(app, ["A"])
        app.buttons["journal.dismissKeyboard"].tap()

        app.buttons["operation.End"].tap()
        XCTAssertTrue(app.staticTexts["summary.title"].waitForExistence(timeout: 10), "セッションが終わらない")
        XCTAssertEqual(unsentBodies(app), ["A"], "セッションが終わると帯の記入が消える")
        XCTAssertFalse(unsentButton(app, "resend").isEnabled, "セッションの外で送り直せる")
        XCTAssertFalse(unsentButton(app, "returnToInput").isEnabled, "セッションの外で入力欄に戻せる")
        attachScreenshot(named: "13-セッションの外の送れなかった記入")

        // 本文は長押しでコピーできる。まとめが出た直後は画面が落ち着かず、長押しがメニューにならないことがあるので数回押す
        let unsentBody = app.staticTexts.matching(identifier: "journal.unsent.body").firstMatch
        let copy = app.menuItems.matching(NSPredicate(format: "label IN %@", ["コピー", "Copy"])).firstMatch
        for _ in 0..<3 where !copy.exists {
            unsentBody.press(forDuration: 1.5)
            _ = copy.waitForExistence(timeout: 3)
        }
        XCTAssertTrue(copy.exists, "帯の本文をコピーできない")
        copy.tap()

        unsentButton(app, "discard").tap()
        waitForUnsent(app, [])
    }
}
