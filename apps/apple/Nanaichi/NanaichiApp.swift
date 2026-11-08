import AppKit
import NanaichiDevice
import NanaichiDomain
import NanaichiPresentation
import SwiftUI
import UserNotifications

@main
struct NanaichiApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // 1人が同時に持てるセッションは1つなので、ウィンドウも1つにする。閉じてもアプリは動き続け、音と通知で知らせる
        Window("nanaichi", id: "main") {
            MainView(app: appDelegate.app)
        }
        .defaultSize(width: 980, height: 720)
        .commands {
            TimerCommands(model: appDelegate.app.timer)
            ReviewCommands()
        }

        // スタッツは振り返るときに開く補助のウィンドウ。タイマーの隣に並べて見られる
        Window("スタッツ", id: reviewWindowId) {
            ReviewWindow(app: appDelegate.app)
        }
        .defaultSize(width: 1000, height: 720)

        Settings {
            SettingsView(app: appDelegate.app)
        }
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

/// アプリの間ずっと生きている部品を持つ。ウィンドウを閉じてもタイマーを進め、終了の前に通知の予約を整える
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let app: AppServices
    private var running: Task<Void, Never>?

    override init() {
        app = AppServices(configuration: LaunchConfiguration.current())
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        applyTheme(ThemePreference(rawValue: UserDefaults.standard.string(forKey: PreferenceKey.theme) ?? "") ?? .system)
        #if DEBUG
            // XCUITest がダークの見た目を撮るため。起動引数の -AppleInterfaceStyle は macOS 26 のアプリには効かない
            switch ProcessInfo.processInfo.environment["NANAICHI_APPEARANCE"] {
            case "Dark": NSApp.appearance = NSAppearance(named: .darkAqua)
            case "Light": NSApp.appearance = NSAppearance(named: .aqua)
            default: break
            }
        #endif
        running = Task { await app.run() }
    }

    /// 終了する前に、通知の予約を音の鳴るものに入れ替える（動いている間はアプリが自分で鳴らす）
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task {
            await app.timer.prepareForTermination()
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
