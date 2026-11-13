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
    /// ログインした直後に、この Mac の閉じたセッションを取り込むかを確かめ、取り込むとこの Mac から消える（Issue #19、ADR 0020）。
    /// 代わりのアカウントは、どのセッションも取り込んだと答える
    @MainActor
    func testImportsDeviceRecordsRightAfterSignIn() throws {
        let app = launch(stub: true)
        openAccountSettings(app)
        waitFor(app, "account.email", toRead: "owner@example.com")
        // 起動したときにログインしていたなら確かめは出さず、取り込むものもない
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない記録はありません")
        app.buttons["account.signOut"].click()
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 5), "ログアウトしても戻らない")
        app.typeKey("w", modifierFlags: .command)

        // この Mac の記録先でセッションを1つ終える
        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        start.click()
        let end = app.buttons["operation.End"]
        XCTAssertTrue(end.waitForExistence(timeout: 5), "セッションが始まらない")
        end.click()
        XCTAssertTrue(start.waitForExistence(timeout: 5), "セッションが終わらない")

        openAccountSettings(app)
        app.buttons["account.signIn"].click()
        waitFor(app, "account.email", toRead: "owner@example.com")
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない1セッション・記入 0件があります")
        app.typeKey("w", modifierFlags: .command)

        let prompt = app.staticTexts["import.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5), "ログインした直後に取り込むかを確かめない")
        attachScreenshot(of: app, named: "46-取り込みの確かめ")
        app.buttons["import.start"].click()
        waitFor(app, "import.result", toRead: "1セッションをアカウントに取り込みました。")
        attachScreenshot(of: app, named: "47-取り込みました")
        app.buttons["import.close"].click()
        XCTAssertFalse(prompt.exists)

        openAccountSettings(app)
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない記録はありません")
        XCTAssertFalse(app.buttons["account.import"].exists, "取り込んだのに、まだ取り込むボタンがある")
    }

    /// 「あとで」を選んでも、設定のアカウントのタブから取り込める
    @MainActor
    func testImportLaterFromSettings() throws {
        let app = launch(stub: true)
        openAccountSettings(app)
        waitFor(app, "account.email", toRead: "owner@example.com")
        app.buttons["account.signOut"].click()
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 5), "ログアウトしても戻らない")
        app.typeKey("w", modifierFlags: .command)

        let start = app.buttons["timer.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        start.click()
        app.buttons["operation.End"].click()
        XCTAssertTrue(start.waitForExistence(timeout: 5), "セッションが終わらない")

        openAccountSettings(app)
        app.buttons["account.signIn"].click()
        waitFor(app, "account.email", toRead: "owner@example.com")
        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(app.buttons["import.later"].waitForExistence(timeout: 5), "ログインした直後に取り込むかを確かめない")
        app.buttons["import.later"].click()

        openAccountSettings(app)
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない1セッション・記入 0件があります")
        attachScreenshot(of: app, named: "48-設定（アカウント・取り込んでいない記録）")
        app.buttons["account.import"].click()
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない記録はありません")
    }
}
