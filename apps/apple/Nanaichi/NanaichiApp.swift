import AppKit
import NanaichiDevice
import NanaichiDomain
import NanaichiPresentation
import SwiftUI
import UserNotifications

@main
struct NanaichiApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @AppStorage(PreferenceKey.showsMenuBarExtra) private var showsMenuBarExtra = true

    var body: some Scene {
        // 1人が同時に持てるセッションは1つなので、ウィンドウも1つにする。閉じてもアプリは動き続け、音と通知で知らせる
        Window("nanaichi", id: mainWindowId) {
            RecordStoreScope(model: appDelegate.model) { MainView(model: appDelegate.model, app: $0) }
        }
        .defaultSize(width: 980, height: 720)
        .keyboardShortcut("1")
        .commands {
            TimerCommands(model: appDelegate.model)
            ReviewCommands()
            AccountCommands(model: appDelegate.model)
        }

        // スタッツは振り返るときに開く補助のウィンドウ。タイマーの隣に並べて見られる
        Window("スタッツ", id: reviewWindowId) {
            RecordStoreScope(model: appDelegate.model) { ReviewWindow(app: $0) }
        }
        .defaultSize(width: 1000, height: 720)

        Settings {
            SettingsView(model: appDelegate.model)
        }

        // ウィンドウを閉じていても、残り時間を見て操作できるようにする（ADR 0015「メニューバー常駐」）。
        // 中は記録先が替わるたびに `services` を読み直すので、作り直さなくても今の記録先を指す
        MenuBarExtra(isInserted: $showsMenuBarExtra) {
            MenuBarPanel(app: appDelegate.model)
        } label: {
            MenuBarLabelView(app: appDelegate.model)
        }
        .menuBarExtraStyle(.window)
    }
}

/// メニューバーの「ウインドウ」に、スタッツを開く項目を足す
private struct ReviewCommands: Commands {
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(before: .windowList) {
            Button("スタッツ") { openWindow(id: reviewWindowId) }
                .keyboardShortcut("2")
            Divider()
        }
    }
}

/// 記録先が替わったら、中の画面を作り直す（Web でページを読み込み直すのと同じ、ADR 0019）。
/// 前の記録先の画面の状態（`@State` を含む）を、次の記録先に持ち越さない
private struct RecordStoreScope<Content: View>: View {
    let model: AppModel
    @ViewBuilder let content: (AppServices) -> Content

    var body: some View {
        content(model.services).id(ObjectIdentifier(model.services))
    }
}

/// メニューバーの nanaichi のメニューに、設定のアカウントのタブを開く項目を足す。
/// ログイン・ログアウトとその失敗の知らせは、そのタブにまとめる
private struct AccountCommands: Commands {
    let model: AppModel
    @Environment(\.openSettings) private var openSettings

    var body: some Commands {
        CommandGroup(after: .appSettings) {
            Button("アカウント…") {
                model.settingsTab = .account
                openSettings()
            }
        }
    }
}

/// アプリの間ずっと生きている部品を持つ。ウィンドウを閉じてもタイマーを進め、終了の前に通知の予約を整える
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let model: AppModel
    #if DEBUG
        private var menuBarPanelWindow: NSWindow?
    #endif

    override init() {
        UserDefaults.standard.register(defaults: PreferenceKey.initialValues)
        model = AppModel(configuration: LaunchConfiguration.current())
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        applyTheme(ThemePreference(rawValue: UserDefaults.standard.string(forKey: PreferenceKey.theme) ?? "") ?? .system)
        #if DEBUG
            Task { await runSelfCheckIfAsked() }
            // XCUITest がダークの見た目を撮るため。起動引数の -AppleInterfaceStyle は macOS 26 のアプリには効かない
            switch ProcessInfo.processInfo.environment["NANAICHI_APPEARANCE"] {
            case "Dark": NSApp.appearance = NSAppearance(named: .darkAqua)
            case "Light": NSApp.appearance = NSAppearance(named: .aqua)
            default: break
            }
            if ProcessInfo.processInfo.environment["NANAICHI_MENU_BAR_PANEL_WINDOW"] == "1" { openMenuBarPanelWindow() }
        #endif
        model.start()
    }

    /// 最後のウィンドウを閉じたら終了するか。初めは終了せず、タイマーと音と通知を続ける
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !UserDefaults.standard.bool(forKey: PreferenceKey.keepsRunningWithoutWindows)
    }

    #if DEBUG
        /// メニューバーのパネルを、ふつうのウィンドウにも開く。XCUITest がメニューバーの表示を押さなくても、
        /// パネルのボタンだけでセッションを進めて撮れるようにする（メニューバーの表示は、テストの環境によって押せないことがある）
        private func openMenuBarPanelWindow() {
            let window = NSWindow(contentViewController: NSHostingController(rootView: MenuBarPanel(app: model)))
            window.title = "メニューバーのパネル"
            window.isReleasedWhenClosed = false
            window.makeKeyAndOrderFront(nil)
            menuBarPanelWindow = window
        }
    #endif

    /// ほかのアプリから戻ってきたら、同期の接続が生きているかを確かめる（スリープから戻ったときも含む）
    func applicationDidBecomeActive(_ notification: Notification) {
        Task { await model.checkSyncConnection() }
    }

    /// 終了する前に、通知の予約を音の鳴るものに入れ替える（動いている間はアプリが自分で鳴らす）
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task {
            await model.services.timer.prepareForTermination()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// アプリが前面にあるときに届いた通知。音はアプリが鳴らしているので、通知センターに残すだけにする
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.list]
    }
}
