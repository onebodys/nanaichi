import XCTest

/// Mac と iPhone の UI テストに共通の「待つ・確かめる・やり直す」（Issue #98）。
///
/// 操作は画面に届かずに消えることがある（押したのに効かない #119、起動しても前に出ない #96、開ききる前の設定のタブ #84）。
/// そこで、画面を変える操作は、効いたとわかる画面の変化（`ScreenChange`）を待ち、起きなければやり直す（`tap(_:until:)`）。
/// やり直すのは操作が届かなかったときだけにする。押した要素が無効（処理中）のあいだは押し直さず、アプリがエラーを出したら
/// （`failsOn`）押し直さずに落とす。押すたびに状態が反転するもの（チェックボックスなど）は `attempts: 1` で押し直さない。
/// 文字は、入力欄にカーソルがあるのを確かめてから書く（#82）

/// 操作が効いたとわかる画面の変化
enum ScreenChange {
    case appears(XCUIElement, failure: String)
    case disappears(XCUIElement, failure: String)
    /// 要素が出る・消えるでは表せない、いくつかの要素をまとめて読んだ値が条件を満たす。`failure` は満たさなかったときに読む
    case holds(@MainActor () -> Bool, failure: @MainActor () -> String)

    /// `root` の中の識別子 `identifier` の文字が `text` になる。macOS の StaticText は文字を `value` に、iOS は `label` に持つ
    @MainActor
    static func reads(_ root: XCUIElement, _ identifier: String, _ text: String) -> ScreenChange {
        let element = root.staticTexts.matching(
            NSPredicate(format: "identifier == %@ AND (value == %@ OR label == %@)", identifier, text, text)
        ).firstMatch
        return .appears(element, failure: "\(identifier) が「\(text)」にならない")
    }

    /// `read` で読んだ値（`what`）が `expected` になる
    @MainActor
    static func equals<Value: Equatable>(
        _ read: @escaping @MainActor () -> Value, _ expected: Value, _ what: String
    ) -> ScreenChange {
        .holds({ read() == expected }, failure: { "\(what)が \(expected) にならない（\(read())）" })
    }

    /// 入力欄 `field` にカーソル（キーボードのフォーカス）がある
    @MainActor
    static func focused(_ field: XCUIElement) -> ScreenChange {
        .holds({ hasKeyboardFocus(field) }, failure: { "入力欄にカーソルが置けない" })
    }

    @MainActor
    var failure: String {
        switch self {
        case .appears(_, let failure), .disappears(_, let failure): failure
        case .holds(_, let failure): failure()
        }
    }

    @MainActor
    func happens(within timeout: TimeInterval) -> Bool {
        switch self {
        case .appears(let element, _): return element.waitForExistence(timeout: timeout)
        case .disappears(let element, _): return element.waitForNonExistence(timeout: timeout)
        case .holds(let condition, _):
            let deadline = Date().addingTimeInterval(timeout)
            while true {
                if condition() { return true }
                if Date() >= deadline { return false }
                RunLoop.current.run(until: min(deadline, Date().addingTimeInterval(0.2)))
            }
        }
    }
}

extension XCTestCase {
    /// `change` が起きるまで待つ
    @MainActor
    func waitFor(
        _ change: ScreenChange, timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertTrue(change.happens(within: timeout), change.failure, file: file, line: line)
    }

    /// `root` の中の識別子 `identifier` の文字が `text` になるまで待つ
    @MainActor
    func waitFor(
        _ root: XCUIElement, _ identifier: String, toRead text: String, timeout: TimeInterval = 10,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        waitFor(.reads(root, identifier, text), timeout: timeout, file: file, line: line)
    }

    /// `act` で操作し、`change` が起きるまで `timeout` 秒待つ。起きなければ、合わせて `attempts` 回まで操作をやり直す。
    /// `act` には何回目か（0 から）を渡す。`failsOn` のどれかが出ていたら、アプリが操作を断ったので、やり直さずに落とす。
    /// やり直したことは結果に残し、落ちたときは試した回数と `detail`（操作した要素の様子など）を添える
    @MainActor
    func perform(
        _ act: (_ attempt: Int) -> Void, until change: ScreenChange, failsOn errors: [XCUIElement] = [],
        timeout: TimeInterval = 5, attempts: Int = 3, detail: () -> String = { "" },
        file: StaticString = #filePath, line: UInt = #line
    ) {
        for attempt in 0..<attempts {
            if attempt == 0 {
                act(attempt)
            } else {
                XCTContext.runActivity(named: "「\(change.failure)」ので、もう一度操作する（\(attempt + 1)回目）") { _ in
                    act(attempt)
                }
            }
            if change.happens(within: timeout) { return }
            if let error = errors.first(where: \.exists) {
                XCTFail("\(change.failure)（アプリが断った: \(textOf(error))）", file: file, line: line)
                return
            }
        }
        XCTFail("\(change.failure)（\(attempts)回試した\(detail())）", file: file, line: line)
    }

    /// アプリを起動し、`change`（ホームが開くなど）が起きるのを待つ。
    ///
    /// 起動しても前に出ないことがある（#96。起動の画面のあとホーム画面に戻り、XCUITest は 60 秒待ってから進む）ので、
    /// 裏にいれば前に出し直し、それでも裏にいれば1回だけ起動し直す。前に出ているのに起きない・止まっている（落ちた）ときは、
    /// 起動の不具合なので、やり直さずに落とす
    @MainActor
    func launch(
        _ app: XCUIApplication, until change: ScreenChange, file: StaticString = #filePath, line: UInt = #line
    ) {
        var launches = 1
        var activations = 0
        app.launch()
        while !change.happens(within: 10) {
            let state = app.state
            let inBackground = isInBackground(state)
            if inBackground, activations == 0 {
                activations += 1
                XCTContext.runActivity(named: "起動しても前に出ないので、前に出し直す（app.state=\(nameOf(state))）") { _ in
                    app.activate()
                }
            } else if inBackground, launches == 1 {
                launches += 1
                XCTContext.runActivity(named: "前に出し直しても裏にいるので、起動し直す（app.state=\(nameOf(state))）") { _ in
                    app.launch()
                }
            } else {
                XCTFail(
                    "\(change.failure)（app.state=\(nameOf(state))、起動 \(launches) 回・前に出し直し \(activations) 回）",
                    file: file, line: line)
                return
            }
        }
    }

    /// 入力欄 `field` にカーソルを置く。もうあれば何もしない
    @MainActor
    func focus(_ field: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        guard !(field.waitForExistence(timeout: 10) && hasKeyboardFocus(field)) else { return }
        #if os(macOS)
            click(field, until: .focused(field), file: file, line: line)
        #else
            tap(field, until: .focused(field), file: file, line: line)
        #endif
    }

    /// 入力欄 `field` に `text` を書く。`expected` を渡せば、本文がそれになるまで待つ。
    ///
    /// 書く前に、カーソルが入力欄にあるのを確かめ、なければ入力欄を押して置き直す。画面が切り替わる途中では、
    /// カーソルが外れていることがあり、そこへ書くと途中から文字が届かない（#82）。`typeText` は文字を送り終えても
    /// 画面が描き直す前に戻ることがあるので、本文はすぐ読まず、そろうまで待つ
    @MainActor
    func type(
        _ text: String, into field: XCUIElement, toRead expected: String? = nil, _ message: String = "",
        file: StaticString = #filePath, line: UInt = #line
    ) {
        focus(field, file: file, line: line)
        field.typeText(text)
        guard let expected else { return }
        let read = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expected), object: field)
        if XCTWaiter.wait(for: [read], timeout: 10) != .completed {
            XCTAssertEqual(field.value as? String, expected, message, file: file, line: line)
        }
    }

    /// `element` が出るのを待って押し、`change` が起きなければ押し直す（Mac はクリック、iPhone はタップ）。
    /// 押し直すのは、要素がまだ押せる（出ていて、触れられて、有効な）ときだけ。効いて画面が替わったり、処理中で無効に
    /// なったりしていれば、押し直さずに待つ
    @MainActor
    private func press(
        _ element: XCUIElement, until change: ScreenChange, failsOn errors: [XCUIElement], timeout: TimeInterval,
        attempts: Int, file: StaticString, line: UInt, _ press: @escaping () -> Void
    ) {
        guard element.waitForExistence(timeout: 10) else {
            XCTFail("\(change.failure)（押す要素が出ない: \(element)）", file: file, line: line)
            return
        }
        perform(
            { attempt in
                if attempt == 0 || (element.exists && element.isHittable && element.isEnabled) { press() }
            }, until: change, failsOn: errors, timeout: timeout, attempts: attempts,
            detail: { "。押した要素: \(self.stateOf(element))" }, file: file, line: line)
    }

    @MainActor
    private func stateOf(_ element: XCUIElement) -> String {
        guard element.exists else { return "なし" }
        return "isHittable=\(element.isHittable)、isEnabled=\(element.isEnabled)"
    }
}

/// 入力欄にカーソル（キーボードのフォーカス）があるか。`hasKeyboardFocus` は XCUITest の要素の属性
@MainActor
private func hasKeyboardFocus(_ field: XCUIElement) -> Bool {
    field.exists && NSPredicate(format: "hasKeyboardFocus == true").evaluate(with: field)
}

/// アプリが裏にいるか（iOS では、裏で止まっているときも）
private func isInBackground(_ state: XCUIApplication.State) -> Bool {
    #if os(iOS)
        if state == .runningBackgroundSuspended { return true }
    #endif
    return state == .runningBackground
}

/// アプリの状態の名前（失敗の文言に出す）
func nameOf(_ state: XCUIApplication.State) -> String {
    #if os(iOS)
        if state == .runningBackgroundSuspended { return "runningBackgroundSuspended" }
    #endif
    return switch state {
    case .unknown: "unknown"
    case .notRunning: "notRunning"
    case .runningBackground: "runningBackground"
    case .runningForeground: "runningForeground"
    default: "\(state.rawValue)"
    }
}

/// エラーの要素の文字。macOS の StaticText は文字を `value` に、iOS は `label` に持つ
@MainActor
private func textOf(_ element: XCUIElement) -> String {
    (element.value as? String).flatMap { $0.isEmpty ? nil : $0 } ?? element.label
}

#if os(macOS)
    extension XCTestCase {
        /// `element` をクリックし、`change` が起きなければクリックし直す（`press` を見る）
        @MainActor
        func click(
            _ element: XCUIElement, until change: ScreenChange, failsOn errors: [XCUIElement] = [],
            timeout: TimeInterval = 5, attempts: Int = 3, file: StaticString = #filePath, line: UInt = #line
        ) {
            press(
                element, until: change, failsOn: errors, timeout: timeout, attempts: attempts, file: file, line: line
            ) { element.click() }
        }

        /// 設定を開き、タブ `tab` に替わるまで待つ（Issue #84）。設定のウィンドウのタイトルは選んだタブの名前になる。
        ///
        /// 起動の直後の ⌘, はアプリが受け取れずに設定が開かないことがあり、開ききる前に押したタブは替わらないことがある。
        /// どちらもやり直せば効くので、タブが出るまで ⌘, を、タイトルが替わるまでタブを押し直す。
        /// 最初の ⌘, は、設定のウィンドウがすでにあっても送る。ほかのウィンドウの後ろにあると、前に出さないと押せない
        @MainActor
        func openSettings(
            _ app: XCUIApplication, tab name: String, file: StaticString = #filePath, line: UInt = #line
        ) {
            let tab = app.toolbars.buttons[name]
            perform(
                { _ in app.typeKey(",", modifierFlags: .command) }, until: .appears(tab, failure: "設定が開かない"),
                file: file, line: line)
            click(tab, until: .appears(settingsWindow(app, tab: name), failure: "設定の\(name)のタブが開かない"), file: file, line: line)
        }

        /// タブ `tab` を開いている設定のウィンドウを閉じる。⌘W は前にあるウィンドウを閉じるので、押し直さない
        @MainActor
        func closeSettings(
            _ app: XCUIApplication, tab name: String, file: StaticString = #filePath, line: UInt = #line
        ) {
            perform(
                { _ in app.typeKey("w", modifierFlags: .command) },
                until: .disappears(settingsWindow(app, tab: name), failure: "設定のウィンドウが閉じない"), attempts: 1,
                file: file, line: line)
        }

        @MainActor
        private func settingsWindow(_ app: XCUIApplication, tab name: String) -> XCUIElement {
            app.windows.matching(NSPredicate(format: "title == %@", name)).firstMatch
        }
    }
#else
    extension XCTestCase {
        /// `element` をタップし、`change` が起きなければタップし直す（`press` を見る）
        @MainActor
        func tap(
            _ element: XCUIElement, until change: ScreenChange, failsOn errors: [XCUIElement] = [],
            timeout: TimeInterval = 5, attempts: Int = 3, file: StaticString = #filePath, line: UInt = #line
        ) {
            press(
                element, until: change, failsOn: errors, timeout: timeout, attempts: attempts, file: file, line: line
            ) { element.tap() }
        }

        /// 通知の許可を求められたら許可する。許可を求める画面は、開始ボタンの操作の中で出る（`timeout` 秒まで待つ）。
        /// OS は一度答えると聞き直さないので、このテストの実行で一度待ったら、もう待たない（許可済みの回で毎回待たない）。
        /// 遅れて出たときは、次の操作で `allowNotificationsWhenTheyInterrupt()` が許可する
        @MainActor
        func allowNotificationsIfAsked(timeout: TimeInterval = 5) {
            guard !notificationsAsked else { return }
            notificationsAsked = true
            let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons
                .matching(NSPredicate(format: "label IN %@", allowLabels)).firstMatch
            if allow.waitForExistence(timeout: timeout) { allow.tap() }
        }

        /// 許可を求める画面が遅れて出て、次の操作に割り込んだときも許可する。XCUITest に任せると許可しないほうを
        /// 押すことがあり、そのあとは通知が届かない。`setUp` で呼ぶ
        func allowNotificationsWhenTheyInterrupt() {
            addUIInterruptionMonitor(withDescription: "通知の許可") { alert in
                // 割り込みの処理は、XCUITest がメインスレッドで呼ぶ
                MainActor.assumeIsolated {
                    let allow = alert.buttons.matching(NSPredicate(format: "label IN %@", allowLabels)).firstMatch
                    guard allow.exists else { return false }
                    allow.tap()
                    return true
                }
            }
        }
    }

    /// このテストの実行で、もう通知の許可を求める画面を待ったか
    @MainActor private var notificationsAsked = false

    /// 通知の許可を求める画面の、許可するボタン
    private let allowLabels = ["許可", "Allow"]
#endif
