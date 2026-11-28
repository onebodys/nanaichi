import XCTest

/// iPhone で、送れなかったジャーナル記入を失わずに扱う（Issue #80）。前のセッションの記入は送り直させない（Issue #88）。
///
/// はじめの数回の記入を、少し待ってから送れなかったことにして起動する（`NANAICHI_FAIL_JOURNAL_WRITES`、
/// `DebugFailingJournalWrites`）。待っている間に入力欄に書き足す。送り直すときの ID・本文・タグが最初と同じことは、
/// 画面からは見えないので NanaichiKit の `JournalDraftTests` で確かめる
final class PhoneJournalTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func startSession(_ app: XCUIApplication) {
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        XCTAssertTrue(app.buttons["operation.Pause"].waitForExistence(timeout: 10), "セッションが始まらない")
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

    /// 帯に並んだ送れなかった記入の本文。送り直せて帯が変わる途中に1件ずつ読むと、数えたあとに消えた記入を
    /// 読めずに落ちるので、画面の階層を一度に写してから読む
    @MainActor
    private func unsentBodies(_ app: XCUIApplication) -> [String] {
        guard let root = try? app.snapshot() else { return [] }
        func bodies(_ element: any XCUIElementSnapshot) -> [String] {
            (element.identifier == "journal.unsent.body" ? [element.label] : []) + element.children.flatMap(bodies)
        }
        return bodies(root)
    }

    @MainActor
    private func waitForUnsent(
        _ app: XCUIApplication, _ expected: [String], file: StaticString = #filePath, line: UInt = #line
    ) {
        // 送れなかったことにするまでの 10 秒（`DebugFailingJournalWrites`）より長く待つ
        let deadline = Date().addingTimeInterval(20)
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
        // 送れなかったことにするまでの 10 秒（`DebugFailingJournalWrites`）より長く待つ
        let deadline = Date().addingTimeInterval(20)
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
        let pressForCopy = {
            for _ in 0..<3 where !copy.exists {
                unsentBody.press(forDuration: 1.5)
                _ = copy.waitForExistence(timeout: 3)
            }
            XCTAssertTrue(copy.exists, "帯の本文をコピーできない")
        }
        if #available(iOS 27, *) {
            // iOS 27 のシミュレーターでは、XCUITest が長押ししても textSelection の付いた Text にメニューが出ない
            // （Issue #86。iOS 26 では同じビルドで毎回出る）。利用者が本物の指でコピーできるかは確かめられていないので、
            // 出なければ想定内の失敗として結果に残し、出たらそのまま確かめる。想定内の失敗でもテストが止まらないように
            // している間だけ続ける設定にし、このあとの「捨てる」まで確かめる
            let options = XCTExpectedFailure.Options()
            options.isStrict = false
            continueAfterFailure = true
            XCTExpectFailure(
                "iOS 27 の XCUITest の長押しでは帯の本文にコピーのメニューが出ない（Issue #86）", options: options,
                failingBlock: pressForCopy)
            continueAfterFailure = false
        } else {
            pressForCopy()
        }
        if copy.exists { copy.tap() }

        unsentButton(app, "discard").tap()
        waitForUnsent(app, [])
    }

    /// S1 で A と B が送れず帯に残る → S1 を終えて S2 を始める → A と B は前のセッションの記入として説明が出て、
    /// 送り直せないが、入力欄に戻すことと捨てることはできる。S2 で送れなかった C は、A と B があっても送り直せる
    @MainActor
    func testUnsentEntriesFromThePreviousSessionCannotBeResent() throws {
        let app = launchInSession(failingWrites: 3)
        let body = app.textViews["journal.body"]
        body.tap()
        body.typeText("A")
        app.buttons["journal.sendFromKeyboard"].tap()
        body.typeText("B")
        waitForUnsent(app, ["A"])
        app.buttons["journal.sendFromKeyboard"].tap()
        body.typeText("C")
        waitForUnsent(app, ["A", "B"])
        app.buttons["journal.dismissKeyboard"].tap()
        XCTAssertFalse(app.staticTexts["journal.unsent.previousSession"].exists, "今のセッションの記入に説明が出る")

        app.buttons["operation.End"].tap()
        XCTAssertTrue(app.staticTexts["summary.title"].waitForExistence(timeout: 10), "セッションが終わらない")
        startSession(app)
        waitForUnsent(app, ["A", "B"])
        XCTAssertEqual(
            app.staticTexts.matching(identifier: "journal.unsent.previousSession").count, 2, "前のセッションの記入の説明が出ない")
        for index in 0..<2 {
            XCTAssertFalse(unsentButton(app, "resend", at: index).isEnabled, "前のセッションの記入を送り直せる")
            XCTAssertTrue(unsentButton(app, "returnToInput", at: index).isEnabled, "前のセッションの記入を入力欄に戻せない")
            XCTAssertTrue(unsentButton(app, "discard", at: index).isEnabled, "前のセッションの記入を捨てられない")
        }
        attachScreenshot(named: "21-前のセッションの送れなかった記入")

        // S2 で C が送れないと帯に並び、C は送り直せる（4回目からは送れる）
        body.tap()
        app.buttons["journal.sendFromKeyboard"].tap()
        body.typeText("D")
        waitForUnsent(app, ["A", "B", "C"])
        app.buttons["journal.dismissKeyboard"].tap()
        XCTAssertEqual(app.staticTexts.matching(identifier: "journal.unsent.previousSession").count, 2)
        XCTAssertTrue(unsentButton(app, "resend", at: 2).isEnabled, "今のセッションの記入を送り直せない")
        unsentButton(app, "resend", at: 2).tap()
        waitForUnsent(app, ["A", "B"])

        // B を捨てると帯から消え、A を入力欄に戻すと書き足した D の前につながる
        unsentButton(app, "discard", at: 1).tap()
        waitForUnsent(app, ["A"])
        unsentButton(app, "returnToInput", at: 0).tap()
        waitForUnsent(app, [])
        waitForInput(app, toRead: "A\nD")
    }
}
