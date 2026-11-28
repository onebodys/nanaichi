import XCTest

/// iPhone のアカウントの画面で、ログインとログアウトで記録先が替わり、この iPhone の記録を取り込む（Issue #71）。
/// テストを変えたら、Mac の `NanaichiUITests/AccountTests.swift` と場面をそろえる。
///
/// 本番のサーバーには繋がない。ログインした状態は、サーバーの代わりのアカウント（`NANAICHI_ACCOUNT_STUB`、
/// デバッグのビルドにだけある）で開く。代わりのアカウントは、ブラウザを開かずにすぐログインできる
final class PhoneAccountTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        allowNotificationsWhenTheyInterrupt()
    }

    @MainActor
    private func launch(stub: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = [
            "NANAICHI_DATABASE": stub ? ":memory:" : "uitest-phone-account.sqlite", "NANAICHI_RESET_DATABASE": "1",
            "NANAICHI_RESET_DEFAULTS": "1", "NANAICHI_ACCOUNT_STUB": stub ? "1" : "0", "NANAICHI_APPEARANCE": "Light",
        ]
        launch(app, until: .appears(app.buttons["timer.start"], failure: "ホームが開かない"))
        return app
    }

    @MainActor
    private func openAccount(_ app: XCUIApplication) {
        tap(app.buttons["toolbar.account"], until: .appears(app.buttons["account.close"], failure: "アカウントの画面が開かない"))
    }

    @MainActor
    private func closeAccount(_ app: XCUIApplication) {
        tap(app.buttons["account.close"], until: .appears(app.buttons["toolbar.account"], failure: "アカウントの画面が閉じない"))
    }

    /// ホームでセッションを始める。通知の許可を求められたら許可する
    @MainActor
    private func startSession(_ app: XCUIApplication) {
        tap(
            app.buttons["timer.start"], until: .appears(app.buttons["operation.Pause"], failure: "セッションが始まらない"),
            failsOn: [app.staticTexts["timer.error"]])
        allowNotificationsIfAsked()
    }

    /// ログイン・ログアウトを断ったときの文言
    @MainActor
    private func refusal(_ app: XCUIApplication) -> [XCUIElement] { [app.staticTexts["account.message"]] }

    /// アカウントの画面から取り込めなかったとき、取り込むボタンが「やり直す」になる
    @MainActor
    private func importFailed(_ app: XCUIApplication) -> [XCUIElement] {
        [app.buttons.matching(NSPredicate(format: "identifier == 'account.import' AND label == 'やり直す'")).firstMatch]
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
        tap(app.buttons["account.signIn"], until: .reads(app, "account.message", "セッションを終えてからログインしてください。"))
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

        tap(
            app.buttons["account.signOut"], until: .appears(app.buttons["account.signIn"], failure: "ログアウトしても戻らない"),
            failsOn: refusal(app))
        attachScreenshot(named: "17-ログアウトしたあと")
        closeAccount(app)
        // この iPhone の記録先に替わったので、アカウントで開いたセッションは出ない
        XCTAssertTrue(app.buttons["timer.start"].waitForExistence(timeout: 5), "ログアウトしても記録先が替わらない")

        openAccount(app)
        tap(app.buttons["account.signIn"], until: .reads(app, "account.email", "owner@example.com"), failsOn: refusal(app))
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
        tap(
            app.buttons["account.signOut"], until: .appears(app.buttons["account.signIn"], failure: "ログアウトしても戻らない"),
            failsOn: refusal(app))
        closeAccount(app)

        // この iPhone の記録先でセッションを1つ終える
        startSession(app)
        tap(
            app.buttons["operation.End"], until: .appears(app.buttons["timer.start"], failure: "セッションが終わらない"),
            failsOn: [app.staticTexts["timer.error"]])

        openAccount(app)
        let prompt = app.staticTexts["import.prompt"]
        tap(
            app.buttons["account.signIn"], until: .appears(prompt, failure: "ログインした直後に取り込むかを確かめない"),
            failsOn: refusal(app))
        XCTAssertEqual(
            prompt.label,
            "ログインする前にこの iPhone で記録した1セッション・記入 0件があります。アカウントに取り込むと、ほかの端末からも見られます。")
        attachScreenshot(named: "18-取り込みの確かめ")
        tap(
            app.buttons["import.start"], until: .reads(app, "import.result", "1セッションをアカウントに取り込みました。"),
            failsOn: [app.staticTexts["import.failure"]])
        attachScreenshot(named: "19-取り込みました")
        tap(app.buttons["import.close"], until: .disappears(prompt, failure: "取り込みの確かめが閉じない"))

        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない記録はありません")
        XCTAssertFalse(app.buttons["account.import"].exists, "取り込んだのに、まだ取り込むボタンがある")
    }

    /// 「あとで」を選んでも、アカウントの画面から取り込める
    @MainActor
    func testImportLaterFromTheAccountScreen() throws {
        let app = launch(stub: true)
        openAccount(app)
        waitFor(app, "account.email", toRead: "owner@example.com")
        tap(
            app.buttons["account.signOut"], until: .appears(app.buttons["account.signIn"], failure: "ログアウトしても戻らない"),
            failsOn: refusal(app))
        closeAccount(app)

        startSession(app)
        tap(
            app.buttons["operation.End"], until: .appears(app.buttons["timer.start"], failure: "セッションが終わらない"),
            failsOn: [app.staticTexts["timer.error"]])

        openAccount(app)
        tap(
            app.buttons["account.signIn"],
            until: .appears(app.buttons["import.later"], failure: "ログインした直後に取り込むかを確かめない"),
            failsOn: refusal(app))
        tap(
            app.buttons["import.later"],
            until: .reads(app, "account.deviceRecords", "アカウントに取り込んでいない1セッション・記入 0件があります"))
        attachScreenshot(named: "20-アカウント（取り込んでいない記録）")
        tap(
            app.buttons["account.import"],
            until: .reads(app, "account.deviceRecords", "アカウントに取り込んでいない記録はありません"),
            failsOn: importFailed(app))
    }
}
