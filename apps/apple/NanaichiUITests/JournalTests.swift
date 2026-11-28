import XCTest

/// Mac で、前のセッションで送れなかったジャーナル記入を次のセッションで送り直させない（Issue #88）。
///
/// はじめの数回の記入を、少し待ってから送れなかったことにして起動する（`NANAICHI_FAIL_JOURNAL_WRITES`、
/// `DebugFailingJournalWrites`）。待っている間に入力欄に書き足す。送り直すときの ID や、前のセッションの記入を
/// 入力欄から送ると新しい ID になることは、画面からは見えないので NanaichiKit の `JournalDraftTests` で確かめる
final class JournalTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(failingWrites: Int) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_DATABASE": "uitest-journal.sqlite", "NANAICHI_RESET_DATABASE": "1",
            "NANAICHI_RESET_DEFAULTS": "1", "NANAICHI_APPEARANCE": "Light",
            "NANAICHI_FAIL_JOURNAL_WRITES": String(failingWrites),
        ]
        // 前のテストが開いたウィンドウ（スタッツなど）を復元させない
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        launch(app, until: .appears(app.buttons["timer.start"], failure: "メインのウィンドウが開かない"))
        return app
    }

    @MainActor
    private func startSession(_ app: XCUIApplication) {
        click(app.buttons["timer.start"], until: .appears(app.buttons["operation.End"], failure: "セッションが始まらない"))
    }

    /// 帯に並んだ送れなかった記入の本文。送り直せて帯が変わる途中に1件ずつ読むと、数えたあとに消えた記入を
    /// 読めずに落ちるので、画面の階層を一度に写してから読む。macOS の StaticText は文字を `value` に持ち、`label` は空になる
    @MainActor
    private func unsentBodies(_ app: XCUIApplication) -> [String] {
        guard let root = try? app.snapshot() else { return [] }
        func bodies(_ element: any XCUIElementSnapshot) -> [String] {
            let text = (element.value as? String).flatMap { $0.isEmpty ? nil : $0 } ?? element.label
            return (element.identifier == "journal.unsent.body" ? [text] : []) + element.children.flatMap(bodies)
        }
        return bodies(root)
    }

    /// 帯の記入が `expected` になる
    @MainActor
    private func unsent(_ app: XCUIApplication, _ expected: [String]) -> ScreenChange {
        .equals({ self.unsentBodies(app) }, expected, "帯の記入")
    }

    @MainActor
    private func waitForUnsent(
        _ app: XCUIApplication, _ expected: [String], file: StaticString = #filePath, line: UInt = #line
    ) {
        // 送れなかったことにするまでの 20 秒（`DebugFailingJournalWrites`、書き足さなかったとき）より長く待つ
        waitFor(unsent(app, expected), timeout: 30, file: file, line: line)
    }

    /// 帯の `index` 番目の記入のボタン
    @MainActor
    private func unsentButton(_ app: XCUIApplication, _ action: String, at index: Int) -> XCUIElement {
        app.buttons.matching(identifier: "journal.unsent.\(action)").element(boundBy: index)
    }

    /// 入力欄の本文を送る（⌘Return はどちらの送信キーでも送る）。送ると入力欄は空になる
    /// （送れなかった記入が戻るのは、書き足したときか 20 秒たってから）
    @MainActor
    private func send(_ body: XCUIElement) {
        perform(
            { _ in body.typeKey(.return, modifierFlags: .command) },
            until: .equals({ body.value as? String }, "", "送ったあとの入力欄の本文"))
    }

    /// S1 で A と B が送れず帯に残る → S1 を終えて S2 を始める → A と B は前のセッションの記入として説明が出て、
    /// 送り直せないが、入力欄に戻すことと捨てることはできる。S2 で送れなかった C は、A と B があっても送り直せる
    @MainActor
    func testUnsentEntriesFromThePreviousSessionCannotBeResent() throws {
        let app = launch(failingWrites: 3)
        startSession(app)
        let body = app.textViews["journal.body"]
        type("A", into: body)
        send(body)
        type("B", into: body)
        waitForUnsent(app, ["A"])
        send(body)
        type("C", into: body)
        waitForUnsent(app, ["A", "B"])
        XCTAssertFalse(app.staticTexts["journal.unsent.previousSession"].exists, "今のセッションの記入に説明が出る")

        click(app.buttons["operation.End"], until: .appears(app.staticTexts["summary.title"], failure: "セッションが終わらない"))
        startSession(app)
        waitForUnsent(app, ["A", "B"])
        XCTAssertEqual(
            app.staticTexts.matching(identifier: "journal.unsent.previousSession").count, 2, "前のセッションの記入の説明が出ない")
        for index in 0..<2 {
            XCTAssertFalse(unsentButton(app, "resend", at: index).isEnabled, "前のセッションの記入を送り直せる")
            XCTAssertTrue(unsentButton(app, "returnToInput", at: index).isEnabled, "前のセッションの記入を入力欄に戻せない")
            XCTAssertTrue(unsentButton(app, "discard", at: index).isEnabled, "前のセッションの記入を捨てられない")
        }
        attachScreenshot(of: app, named: "50-前のセッションの送れなかった記入")

        // S2 で C が送れないと帯に並び、C は送り直せる（4回目からは送れる）
        body.click()
        send(body)
        type("D", into: body)
        waitForUnsent(app, ["A", "B", "C"])
        XCTAssertEqual(app.staticTexts.matching(identifier: "journal.unsent.previousSession").count, 2)
        XCTAssertTrue(unsentButton(app, "resend", at: 2).isEnabled, "今のセッションの記入を送り直せない")
        click(unsentButton(app, "resend", at: 2), until: unsent(app, ["A", "B"]))

        // B を捨てると帯から消え、A を入力欄に戻すと書き足した D の前につながる
        click(unsentButton(app, "discard", at: 1), until: unsent(app, ["A"]))
        click(unsentButton(app, "returnToInput", at: 0), until: unsent(app, []))
        XCTAssertEqual(body.value as? String, "A\nD", "入力欄に戻らない")
        app.buttons["operation.End"].click()
    }
}
