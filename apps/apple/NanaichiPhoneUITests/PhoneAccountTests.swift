import XCTest

/// iPhone のアカウントの画面で、ログインとログアウトで記録先が替わり、この iPhone の記録を取り込む（Issue #71）。
/// テストを変えたら、Mac の `NanaichiUITests/AccountTests.swift` と場面をそろえる。
///
/// 本番のサーバーには繋がない。ログインした状態は、サーバーの代わりのアカウント（`NANAICHI_ACCOUNT_STUB`、
/// デバッグのビルドにだけある）で開く。代わりのアカウントは、ブラウザを開かずにすぐログインできる
final class PhoneAccountTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(stub: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_DATABASE": stub ? ":memory:" : "uitest-phone-account.sqlite", "NANAICHI_RESET_DATABASE": "1",
            "NANAICHI_RESET_DEFAULTS": "1", "NANAICHI_ACCOUNT_STUB": stub ? "1" : "0", "NANAICHI_APPEARANCE": "Light",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 10), "ホームが開かない")
        return app
    }

    /// 識別子 `identifier` の文字が `text` になるまで待つ
    @MainActor
    private func waitFor(
        _ app: XCUIApplication, _ identifier: String, toRead text: String, timeout: TimeInterval = 10,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let element = app.staticTexts.matching(
            NSPredicate(format: "identifier == %@ AND (label == %@ OR value == %@)", identifier, text, text)
        ).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(identifier) が「\(text)」にならない", file: file, line: line)
    }

    @MainActor
    private func openAccount(_ app: XCUIApplication) {
        app.buttons["toolbar.account"].tap()
        XCTAssertTrue(app.buttons["account.close"].waitForExistence(timeout: 5), "アカウントの画面が開かない")
    }

    @MainActor
    private func closeAccount(_ app: XCUIApplication) {
        app.buttons["account.close"].tap()
        XCTAssertTrue(app.buttons["toolbar.account"].waitForExistence(timeout: 5), "アカウントの画面が閉じない")
    }

    /// ホームでセッションを始める。通知の許可を求められたら許可する（前のテストで答えていれば、もう聞かれない）
    @MainActor
    private func startSession(_ app: XCUIApplication) {
        app.buttons["timer.start"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["許可", "Allow"])).firstMatch
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        XCTAssertTrue(app.buttons["operation.Pause"].waitForExistence(timeout: 10), "セッションが始まらない")
    }

    /// ログインしていなければこの iPhone の記録先で動き、セッションの途中ではログインに進ませない（ADR 0020）
    @MainActor
    func testSignInIsRefusedDuringASession() throws {
        let app = launch(stub: false)
        openAccount(app)
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 5), "ログインのボタンがない")
        attachScreenshot(named: "14-アカウント（ログインしていない）")
        closeAccount(app)

        startSession(app)
        openAccount(app)
        app.buttons["account.signIn"].tap()
        waitFor(app, "account.message", toRead: "セッションを終えてからログインしてください。")
        XCTAssertTrue(app.buttons["account.signIn"].exists, "セッションの途中でログインに進んだ")
        attachScreenshot(named: "15-セッションの途中はログインできない")
    }

    /// ログインしていればアカウントの記録先で動き、ログアウトするとこの iPhone の記録先に戻り、またログインできる
    @MainActor
    func testSignOutAndSignInSwitchTheRecordStore() throws {
        let app = launch(stub: true)
        startSession(app)

        openAccount(app)
        waitFor(app, "account.email", toRead: "owner@example.com")
        attachScreenshot(named: "16-アカウント（ログイン中）")

        app.buttons["account.signOut"].tap()
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 5), "ログアウトしても戻らない")
        attachScreenshot(named: "17-ログアウトしたあと")
        closeAccount(app)
        // この iPhone の記録先に替わったので、アカウントで開いたセッションは出ない
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 5), "ログアウトしても記録先が替わらない")

        openAccount(app)
        app.buttons["account.signIn"].tap()
        waitFor(app, "account.email", toRead: "owner@example.com")
    }

    /// ログインした直後に、この iPhone の閉じたセッションを取り込むかを確かめ、取り込むとこの iPhone から消える（ADR 0020）。
    /// 代わりのアカウントは、どのセッションも取り込んだと答える
    @MainActor
    func testImportsDeviceRecordsRightAfterSignIn() throws {
        let app = launch(stub: true)
        openAccount(app)
        waitFor(app, "account.email", toRead: "owner@example.com")
        // 起動したときにログインしていたなら確かめは出さず、取り込むものもない
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない記録はありません")
        app.buttons["account.signOut"].tap()
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 5), "ログアウトしても戻らない")
        closeAccount(app)

        // この iPhone の記録先でセッションを1つ終える
        startSession(app)
        app.buttons["operation.End"].tap()
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 5), "セッションが終わらない")

        openAccount(app)
        app.buttons["account.signIn"].tap()
        let prompt = app.staticTexts["import.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5), "ログインした直後に取り込むかを確かめない")
        XCTAssertEqual(
            prompt.label,
            "ログインする前にこの iPhone で記録した1セッション・記入 0件があります。アカウントに取り込むと、ほかの端末からも見られます。")
        attachScreenshot(named: "18-取り込みの確かめ")
        app.buttons["import.start"].tap()
        waitFor(app, "import.result", toRead: "1セッションをアカウントに取り込みました。")
        attachScreenshot(named: "19-取り込みました")
        app.buttons["import.close"].tap()
        XCTAssertTrue(prompt.waitForNonExistence(timeout: 5), "取り込みの確かめが閉じない")

        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない記録はありません")
        XCTAssertFalse(app.buttons["account.import"].exists, "取り込んだのに、まだ取り込むボタンがある")
    }

    /// 「あとで」を選んでも、アカウントの画面から取り込める
    @MainActor
    func testImportLaterFromTheAccountScreen() throws {
        let app = launch(stub: true)
        openAccount(app)
        waitFor(app, "account.email", toRead: "owner@example.com")
        app.buttons["account.signOut"].tap()
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 5), "ログアウトしても戻らない")
        closeAccount(app)

        startSession(app)
        app.buttons["operation.End"].tap()
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 5), "セッションが終わらない")

        openAccount(app)
        app.buttons["account.signIn"].tap()
        XCTAssertTrue(app.buttons["import.later"].waitForExistence(timeout: 5), "ログインした直後に取り込むかを確かめない")
        app.buttons["import.later"].tap()

        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない1セッション・記入 0件があります")
        attachScreenshot(named: "20-アカウント（取り込んでいない記録）")
        app.buttons["account.import"].tap()
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない記録はありません")
    }
}
