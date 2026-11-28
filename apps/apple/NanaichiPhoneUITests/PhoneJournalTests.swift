import XCTest

/// iPhone で、送れなかったジャーナル記入を失わずに扱う（Issue #80）。前のセッションの記入は送り直させない（Issue #88）。
///
/// はじめの数回の記入を、少し待ってから送れなかったことにして起動する（`NANAICHI_FAIL_JOURNAL_WRITES`、
/// `DebugFailingJournalWrites`）。待っている間に入力欄に書き足す。送り直すときの ID・本文・タグが最初と同じことは、
/// 画面からは見えないので NanaichiKit の `JournalDraftTests` で確かめる
final class PhoneJournalTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        allowNotificationsWhenTheyInterrupt()
    }

    /// セッションを始める。通知の許可を求められたら許可する
    @MainActor
    private func startSession(_ app: XCUIApplication) {
        tap(app.buttons["timer.start"], until: .appears(app.buttons["operation.Pause"], failure: "セッションが始まらない"))
        allowNotificationsIfAsked()
    }

    @MainActor
    private func launchInSession(failingWrites: Int) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_DATABASE": "uitest-phone-journal.sqlite", "NANAICHI_RESET_DATABASE": "1",
            "NANAICHI_RESET_DEFAULTS": "1", "NANAICHI_APPEARANCE": "Light",
            "NANAICHI_FAIL_JOURNAL_WRITES": String(failingWrites),
        ]
        launch(app, until: .appears(app.buttons["timer.start"], failure: "ホームが開かない"))
        startSession(app)
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

    /// 帯の記入が `expected` になる
    @MainActor
    private func unsent(_ app: XCUIApplication, _ expected: [String]) -> ScreenChange {
        .equals({ self.unsentBodies(app) }, expected, "帯の記入")
    }

    /// 送れなかったことにするまでの 20 秒（`DebugFailingJournalWrites`、書き足さなかったとき）より長く待つ
    private let failureTimeout: TimeInterval = 30

    @MainActor
    private func waitForUnsent(
        _ app: XCUIApplication, _ expected: [String], file: StaticString = #filePath, line: UInt = #line
    ) {
        waitFor(unsent(app, expected), timeout: failureTimeout, file: file, line: line)
    }

    @MainActor
    private func waitForInput(
        _ app: XCUIApplication, toRead text: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        let body = app.textViews["journal.body"]
        waitFor(.equals({ body.value as? String }, text, "入力欄の本文"), timeout: failureTimeout, file: file, line: line)
    }

    /// 入力欄の本文を送る。送ると入力欄は空になる（送れなかった記入が戻るのは、書き足したときか 20 秒たってから）
    @MainActor
    private func send(_ app: XCUIApplication) {
        let body = app.textViews["journal.body"]
        tap(app.buttons["journal.sendFromKeyboard"], until: .equals({ body.value as? String }, "", "送ったあとの入力欄の本文"))
    }

    @MainActor
    private func dismissKeyboard(_ app: XCUIApplication) {
        tap(app.buttons["journal.dismissKeyboard"], until: .disappears(app.keyboards.firstMatch, failure: "キーボードが閉じない"))
    }

    /// 帯の `index` 番目の記入のボタン
    @MainActor
    private func unsentButton(_ app: XCUIApplication, _ action: String, at index: Int = 0) -> XCUIElement {
        app.buttons.matching(identifier: "journal.unsent.\(action)").element(boundBy: index)
    }

    /// 帯の `index` 番目の記入 `body` のボタン `action` を押し、帯が `expected` になるのを待つ。押し直すのは、
    /// その記入がまだ同じ位置にあるときだけ（効いて帯が詰まったあとに、次の記入のボタンを押さないように）
    @MainActor
    private func press(
        _ action: String, of body: String, at index: Int, in app: XCUIApplication, until expected: [String],
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let button = unsentButton(app, action, at: index)
        perform(
            { attempt in
                if attempt == 0 || unsentBodies(app).dropFirst(index).first == body { button.tap() }
            }, until: unsent(app, expected), file: file, line: line)
    }

    /// A を送る → 送っている間に B を書く → A が送れないと、入力欄に B が残り、帯に A が出る。
    /// 帯に残したまま B を送って送れなければ、帯に2件並び、A を送り直せても B は消えない。B は入力欄に戻せる
    @MainActor
    func testUnsentEntriesStayInTheBandWhileAppending() throws {
        let app = launchInSession(failingWrites: 2)
        let body = app.textViews["journal.body"]
        type("A", into: body)
        send(app)
        type("B", into: body)
        waitForUnsent(app, ["A"])
        waitForInput(app, toRead: "B")
        XCTAssertTrue(app.staticTexts["journal.error"].exists, "送れなかった文言が出ない")

        send(app)
        type("C", into: body)
        waitForUnsent(app, ["A", "B"])
        waitForInput(app, toRead: "C")
        dismissKeyboard(app)
        attachScreenshot(named: "12-送れなかった記入")

        // 3回目からは送れる
        press("resend", of: "A", at: 0, in: app, until: ["B"])
        XCTAssertFalse(app.staticTexts["journal.error"].exists, "送り直せても送れなかった文言が残る")

        press("returnToInput", of: "B", at: 0, in: app, until: [])
        XCTAssertFalse(app.otherElements["journal.unsent"].exists, "帯が残る")
        waitForInput(app, toRead: "B\nC")
    }

    /// 書き足していないときに送れなければ、今まで通り入力欄に戻り、帯は出ない。
    /// セッションが終わったあとは、帯の記入は送り直すことも入力欄に戻すこともできず、捨てられる
    @MainActor
    func testUnsentEntryAfterTheSessionEnds() throws {
        let app = launchInSession(failingWrites: 2)
        let body = app.textViews["journal.body"]
        type("A", into: body)
        send(app)
        waitForInput(app, toRead: "A")
        XCTAssertTrue(app.staticTexts["journal.error"].exists, "送れなかった文言が出ない")
        XCTAssertFalse(app.otherElements["journal.unsent"].exists, "書き足していないのに帯が出る")

        send(app)
        type("B", into: body)
        waitForUnsent(app, ["A"])
        dismissKeyboard(app)

        tap(app.buttons["operation.End"], until: .appears(app.staticTexts["summary.title"], failure: "セッションが終わらない"))
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

        press("discard", of: "A", at: 0, in: app, until: [])
    }

    /// S1 で A と B が送れず帯に残る → S1 を終えて S2 を始める → A と B は前のセッションの記入として説明が出て、
    /// 送り直せないが、入力欄に戻すことと捨てることはできる。S2 で送れなかった C は、A と B があっても送り直せる
    @MainActor
    func testUnsentEntriesFromThePreviousSessionCannotBeResent() throws {
        let app = launchInSession(failingWrites: 3)
        let body = app.textViews["journal.body"]
        type("A", into: body)
        send(app)
        type("B", into: body)
        waitForUnsent(app, ["A"])
        send(app)
        type("C", into: body)
        waitForUnsent(app, ["A", "B"])
        dismissKeyboard(app)
        XCTAssertFalse(app.staticTexts["journal.unsent.previousSession"].exists, "今のセッションの記入に説明が出る")

        tap(app.buttons["operation.End"], until: .appears(app.staticTexts["summary.title"], failure: "セッションが終わらない"))
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
        tap(body, until: .appears(app.buttons["journal.sendFromKeyboard"], failure: "入力欄を押してもキーボードが出ない"))
        send(app)
        type("D", into: body)
        waitForUnsent(app, ["A", "B", "C"])
        dismissKeyboard(app)
        XCTAssertEqual(app.staticTexts.matching(identifier: "journal.unsent.previousSession").count, 2)
        XCTAssertTrue(unsentButton(app, "resend", at: 2).isEnabled, "今のセッションの記入を送り直せない")
        press("resend", of: "C", at: 2, in: app, until: ["A", "B"])

        // B を捨てると帯から消え、A を入力欄に戻すと書き足した D の前につながる
        press("discard", of: "B", at: 1, in: app, until: ["A"])
        press("returnToInput", of: "A", at: 0, in: app, until: [])
        waitForInput(app, toRead: "A\nD")
    }
}
