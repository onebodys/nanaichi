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
        launch(app, until: .appears(app.buttons["timer.start"], failure: "メインのウィンドウが開かない"))
        return app
    }

    /// ログイン・ログアウトを断ったときの文言
    @MainActor
    private func refusal(_ app: XCUIApplication) -> [XCUIElement] { [app.staticTexts["account.message"]] }

    /// 操作を断ったときの文言
    @MainActor
    private func timerError(_ app: XCUIApplication) -> [XCUIElement] { [app.staticTexts["timer.error"]] }

    /// 設定から取り込めなかったとき、取り込むボタンが「やり直す」になる
    @MainActor
    private func importFailed(_ app: XCUIApplication) -> [XCUIElement] {
        [app.buttons.matching(NSPredicate(format: "identifier == 'account.import' AND label == 'やり直す'")).firstMatch]
    }

    /// ログインしていなければこの Mac の記録先で動き、セッションの途中ではログインに進ませない（ADR 0020）
    @MainActor
    func testSignInIsRefusedDuringASession() throws {
        let app = launch(stub: false)
        let start = app.buttons["timer.start"]

        openSettings(app, tab: "アカウント")
        XCTAssertTrue(app.buttons["account.signIn"].waitForExistence(timeout: 5), "ログインのボタンがない")
        attachScreenshot(of: app, named: "26-設定（アカウント・ログインしていない）")
        closeSettings(app, tab: "アカウント")

        click(start, until: .appears(app.buttons["operation.Pause"], failure: "セッションが始まらない"), failsOn: timerError(app))
        openSettings(app, tab: "アカウント")
        click(app.buttons["account.signIn"], until: .reads(app, "account.message", "セッションを終えてからログインしてください。"))
        XCTAssertTrue(app.buttons["account.signIn"].exists, "セッションの途中でログインに進んだ")
        attachScreenshot(of: app, named: "27-セッションの途中はログインできない")
    }

    /// ログインしていればアカウントの記録先で動き、ログアウトするとこの Mac の記録先に戻り、またログインできる
    @MainActor
    func testSignOutAndSignInSwitchTheRecordStore() throws {
        let app = launch(stub: true)
        let start = app.buttons["timer.start"]
        click(
            start, until: .appears(app.buttons["operation.Pause"], failure: "アカウントの記録先でセッションが始まらない"),
            failsOn: timerError(app))

        openSettings(app, tab: "アカウント")
        waitFor(app, "account.email", toRead: "owner@example.com")
        attachScreenshot(of: app, named: "28-設定（アカウント・ログイン中）")

        click(
            app.buttons["account.signOut"], until: .appears(app.buttons["account.signIn"], failure: "ログアウトしても戻らない"),
            failsOn: refusal(app))
        attachScreenshot(of: app, named: "29-ログアウトしたあと")
        closeSettings(app, tab: "アカウント")
        // この Mac の記録先に替わったので、アカウントで開いたセッションは出ない
        XCTAssertTrue(start.waitForExistence(timeout: 5), "ログアウトしても記録先が替わらない")

        openSettings(app, tab: "アカウント")
        click(app.buttons["account.signIn"], until: .reads(app, "account.email", "owner@example.com"), failsOn: refusal(app))
    }

    /// ログインした直後に、この Mac の閉じたセッションを取り込むかを確かめ、取り込むとこの Mac から消える（Issue #19、ADR 0020）。
    /// 代わりのアカウントは、どのセッションも取り込んだと答える
    @MainActor
    func testImportsDeviceRecordsRightAfterSignIn() throws {
        let app = launch(stub: true)
        openSettings(app, tab: "アカウント")
        waitFor(app, "account.email", toRead: "owner@example.com")
        // 起動したときにログインしていたなら確かめは出さず、取り込むものもない
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない記録はありません")
        click(
            app.buttons["account.signOut"], until: .appears(app.buttons["account.signIn"], failure: "ログアウトしても戻らない"),
            failsOn: refusal(app))
        closeSettings(app, tab: "アカウント")

        // この Mac の記録先でセッションを1つ終える
        let start = app.buttons["timer.start"]
        let end = app.buttons["operation.End"]
        click(start, until: .appears(end, failure: "セッションが始まらない"), failsOn: timerError(app))
        click(end, until: .appears(start, failure: "セッションが終わらない"), failsOn: timerError(app))

        openSettings(app, tab: "アカウント")
        click(app.buttons["account.signIn"], until: .reads(app, "account.email", "owner@example.com"), failsOn: refusal(app))
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない1セッション・記入 0件があります")
        // ログインした直後は、取り込むかの確かめがメインのウィンドウに出て、設定のウィンドウは操作できなくなる（⌘W でも
        // 閉じない）。設定は開いたまま確かめに答える

        let prompt = app.staticTexts["import.prompt"]
        XCTAssertTrue(prompt.waitForExistence(timeout: 5), "ログインした直後に取り込むかを確かめない")
        attachScreenshot(of: app, named: "46-取り込みの確かめ")
        click(
            app.buttons["import.start"], until: .reads(app, "import.result", "1セッションをアカウントに取り込みました。"),
            failsOn: [app.staticTexts["import.failure"]])
        attachScreenshot(of: app, named: "47-取り込みました")
        click(app.buttons["import.close"], until: .disappears(prompt, failure: "取り込みの確かめが閉じない"))

        openSettings(app, tab: "アカウント")
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない記録はありません")
        XCTAssertFalse(app.buttons["account.import"].exists, "取り込んだのに、まだ取り込むボタンがある")
    }

    /// 「あとで」を選んでも、設定のアカウントのタブから取り込める
    @MainActor
    func testImportLaterFromSettings() throws {
        let app = launch(stub: true)
        openSettings(app, tab: "アカウント")
        waitFor(app, "account.email", toRead: "owner@example.com")
        click(
            app.buttons["account.signOut"], until: .appears(app.buttons["account.signIn"], failure: "ログアウトしても戻らない"),
            failsOn: refusal(app))
        closeSettings(app, tab: "アカウント")

        let start = app.buttons["timer.start"]
        let end = app.buttons["operation.End"]
        click(start, until: .appears(end, failure: "セッションが始まらない"), failsOn: timerError(app))
        click(end, until: .appears(start, failure: "セッションが終わらない"), failsOn: timerError(app))

        openSettings(app, tab: "アカウント")
        click(app.buttons["account.signIn"], until: .reads(app, "account.email", "owner@example.com"), failsOn: refusal(app))
        // ログインした直後は、取り込むかの確かめがメインのウィンドウに出て、設定のウィンドウは操作できなくなる（⌘W でも
        // 閉じない）。設定は開いたまま確かめに答える
        let later = app.buttons["import.later"]
        XCTAssertTrue(later.waitForExistence(timeout: 5), "ログインした直後に取り込むかを確かめない")
        click(later, until: .disappears(later, failure: "「あとで」を押しても取り込むかの確かめが閉じない"))

        openSettings(app, tab: "アカウント")
        waitFor(app, "account.deviceRecords", toRead: "アカウントに取り込んでいない1セッション・記入 0件があります")
        attachScreenshot(of: app, named: "48-設定（アカウント・取り込んでいない記録）")
        click(
            app.buttons["account.import"],
            until: .reads(app, "account.deviceRecords", "アカウントに取り込んでいない記録はありません"),
            failsOn: importFailed(app))
    }
}
