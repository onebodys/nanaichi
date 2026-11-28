import XCTest

/// Mac と iPhone の UI テストに共通の「待つ・確かめる・やり直す」（Issue #98）。
///
/// 操作は画面に届かずに消えることがある（押したのに効かない #119、起動しても前に出ない #96、開ききる前の設定のタブ #84）。
/// そこで、画面を変える操作は、効いたとわかる画面の変化（`ScreenChange`）を待ち、起きなければやり直す（`tap(_:until:)`）。
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
            while !condition(), Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            }
            return condition()
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
    /// `act` には何回目か（0 から）を渡す
    @MainActor
    func perform(
        _ act: (_ attempt: Int) -> Void, until change: ScreenChange, timeout: TimeInterval = 5, attempts: Int = 3,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        for attempt in 0..<attempts {
            act(attempt)
            if change.happens(within: timeout) { return }
        }
        XCTFail(change.failure, file: file, line: line)
    }

    /// アプリを起動し、`change`（ホームが開くなど）が起きるのを待つ。起動しても前に出ないことがある
    /// （#96。起動の画面のあとホーム画面に戻り、XCUITest は 60 秒待ってから進む）ので、起きなければ前に出し直し、
    /// それでも起きなければ起動し直す
    @MainActor
    func launch(
        _ app: XCUIApplication, until change: ScreenChange, file: StaticString = #filePath, line: UInt = #line
    ) {
        perform(
            { attempt in
                switch attempt {
                case 1 where app.state != .notRunning: app.activate()
                default: app.launch()
                }
            }, until: change, timeout: 10, file: file, line: line)
    }

    /// 入力欄 `field` に `text` を書く。`expected` を渡せば、本文がそれになるまで待つ。
    ///
    /// 書く前に、カーソルが入力欄にあるのを確かめ、外れていたら入力欄を押して置き直す。画面が切り替わる途中では、
    /// カーソルが外れていることがあり、そこへ書くと途中から文字が届かない（#82）。`typeText` は文字を送り終えても
    /// 画面が描き直す前に戻ることがあるので、本文はすぐ読まず、そろうまで待つ
    @MainActor
    func type(
        _ text: String, into field: XCUIElement, toRead expected: String? = nil, _ message: String = "",
        file: StaticString = #filePath, line: UInt = #line
    ) {
        if !has(field, NSPredicate(format: "hasKeyboardFocus == true"), within: 2) {
            #if os(macOS)
                field.click()
            #else
                field.tap()
            #endif
            XCTAssertTrue(
                has(field, NSPredicate(format: "hasKeyboardFocus == true"), within: 5), "入力欄にカーソルが置けない",
                file: file, line: line)
        }
        field.typeText(text)
        guard let expected else { return }
        if !has(field, NSPredicate(format: "value == %@", expected), within: 10) {
            XCTAssertEqual(field.value as? String, expected, message, file: file, line: line)
        }
    }

    @MainActor
    private func has(_ element: XCUIElement, _ predicate: NSPredicate, within timeout: TimeInterval) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: timeout)
            == .completed
    }
}

#if os(macOS)
    extension XCTestCase {
        /// `element` が出るのを待ってクリックし、`change` が起きなければクリックし直す。クリックした要素が押せなく
        /// なっていれば（効いて画面が替わっていれば）クリックし直さずに待つ
        @MainActor
        func click(
            _ element: XCUIElement, until change: ScreenChange, timeout: TimeInterval = 5,
            file: StaticString = #filePath, line: UInt = #line
        ) {
            perform(
                { attempt in
                    if attempt == 0 {
                        _ = element.waitForExistence(timeout: timeout)
                        element.click()
                    } else if element.exists, element.isHittable {
                        element.click()
                    }
                }, until: change, timeout: timeout, file: file, line: line)
        }

        /// 設定を開き、タブ `tab` に替わるまで待つ（Issue #84）。設定のウィンドウのタイトルは選んだタブの名前になる。
        ///
        /// 起動の直後の ⌘, はアプリが受け取れずに設定が開かないことがあり、開ききる前に押したタブは替わらないことがある。
        /// どちらも押し直せば効くので、タイトルが替わるまで、開かなければ ⌘, を、開いていればタブを押し直す。
        /// 最初の ⌘, は、設定のウィンドウがすでにあっても送る。ほかのウィンドウの後ろにあると、前に出さないと押せない
        @MainActor
        func openSettings(
            _ app: XCUIApplication, tab name: String, file: StaticString = #filePath, line: UInt = #line
        ) {
            let tab = app.toolbars.buttons[name]
            let window = app.windows.matching(NSPredicate(format: "title == %@", name)).firstMatch
            app.typeKey(",", modifierFlags: .command)
            perform(
                { _ in
                    if tab.waitForExistence(timeout: 5) { tab.click() } else { app.typeKey(",", modifierFlags: .command) }
                }, until: .appears(window, failure: tab.exists ? "設定の\(name)のタブが開かない" : "設定が開かない"),
                timeout: 3, file: file, line: line)
        }
    }
#else
    extension XCTestCase {
        /// `element` が出るのを待って押し、`change` が起きなければ押し直す。押した要素が押せなくなっていれば
        /// （効いて画面が替わっていれば）押し直さずに待つ
        @MainActor
        func tap(
            _ element: XCUIElement, until change: ScreenChange, timeout: TimeInterval = 5,
            file: StaticString = #filePath, line: UInt = #line
        ) {
            perform(
                { attempt in
                    if attempt == 0 {
                        _ = element.waitForExistence(timeout: timeout)
                        element.tap()
                    } else if element.exists, element.isHittable {
                        element.tap()
                    }
                }, until: change, timeout: timeout, file: file, line: line)
        }

        /// 通知の許可を求められたら許可する。許可を求める画面は、開始ボタンの操作の中で出る（`timeout` 秒まで待つ）。
        /// 前のテストで答えていれば、もう聞かれない
        @MainActor
        func allowNotificationsIfAsked(timeout: TimeInterval = 10) {
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

    /// 通知の許可を求める画面の、許可するボタン
    private let allowLabels = ["許可", "Allow"]
#endif
