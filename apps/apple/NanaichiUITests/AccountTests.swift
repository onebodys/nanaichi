import XCTest

/// 設定のアカウントのタブで、ログインとログアウトで記録先が替わる（Issue #145）。
///
/// 本番のサーバーには繋がない。ログインした状態は、サーバーの代わりのアカウント（`NANAICHI_ACCOUNT_STUB`、
/// デバッグのビルドにだけある）で開く。代わりのアカウントは、ブラウザを開かずにすぐログインできる
final class AccountTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(stub: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_DATABASE": stub ? ":memory:" : "uitest-account.sqlite", "NANAICHI_RESET_DATABASE": "1",
            "NANAICHI_RESET_DEFAULTS": "1", "NANAICHI_ACCOUNT_STUB": stub ? "1" : "0",
        ]
        // 前のテストが開いたウィンドウ（スタッツなど）を復元させない。復元したウィンドウがメインのウィンドウに重なり、クリックが当たらなくなる
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        app.launch()
        return app
    }

    /// 識別子 `identifier` の文字が `text` になるまで待つ。macOS の StaticText は文字を `value` に持つ
    @MainActor
    private func waitFor(
        _ app: XCUIApplication, _ identifier: String, toRead text: String, timeout: TimeInterval = 10,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let element = app.staticTexts.matching(
            NSPredicate(format: "identifier == %@ AND (value == %@ OR label == %@)", identifier, text, text)
        ).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(identifier) が「\(text)」にならない", file: file, line: line)
    }

    @MainActor
    private func openAccountSettings(_ app: XCUIApplication) {
        app.typeKey(",", modifierFlags: .command)
        let tab = app.toolbars.buttons["アカウント"]
        XCTAssertTrue(tab.waitForExistence(timeout: 5), "設定が開かない")
        tab.click()
    }

    /// ログインしていなければこの Mac の記録先で動き、セッションの途中ではログインに進ませない（ADR 0020）
    @MainActor
    func testSignInIsRefusedDuringASession() throws {
        let app = launch(stub: false)
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))

        openAccountSettings(app)
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 5), "ログインのボタンがない")
        attachScreenshot(of: app, named: "26-設定（アカウント・ログインしていない）")
        app.typeKey("w", modifierFlags: .command)

        start.click()
        XCTAssertTrue(app.buttons["operation.Pause"].waitForExistence(timeout: 5), "セッションが始まらない")
        openAccountSettings(app)
        app.buttons["account.signIn"].click()
        waitFor(app, "account.message", toRead: "セッションを終えてからログインしてください。")
        XCTAssertTrue(app.buttons["account.signIn"].exists, "セッションの途中でログインに進んだ")
        attachScreenshot(of: app, named: "27-セッションの途中はログインできない")
    }

    /// ログインしていればアカウントの記録先で動き、ログアウトするとこの Mac の記録先に戻り、またログインできる
    @MainActor
    func testSignOutAndSignInSwitchTheRecordStore() throws {
        let app = launch(stub: true)
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.click()
        XCTAssertTrue(app.buttons["operation.Pause"].waitForExistence(timeout: 5), "アカウントの記録先でセッションが始まらない")

        openAccountSettings(app)
        waitFor(app, "account.email", toRead: "owner@example.com")
        attachScreenshot(of: app, named: "28-設定（アカウント・ログイン中）")

        app.buttons["account.signOut"].click()
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 5), "ログアウトしても戻らない")
        attachScreenshot(of: app, named: "29-ログアウトしたあと")
        app.typeKey("w", modifierFlags: .command)
        // この Mac の記録先に替わったので、アカウントで開いたセッションは出ない
        XCTAssertTrue(start.waitForExistence(timeout: 5), "ログアウトしても記録先が替わらない")

        openAccountSettings(app)
        app.buttons["account.signIn"].click()
        waitFor(app, "account.email", toRead: "owner@example.com")
    }
}
