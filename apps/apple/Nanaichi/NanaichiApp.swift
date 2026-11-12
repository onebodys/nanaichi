import AppKit
import NanaichiDevice
import NanaichiPresentation
import SwiftUI
import UserNotifications

@main
struct NanaichiApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // 1人が同時に持てるセッションは1つなので、ウィンドウも1つにする。閉じてもアプリは動き続け、音と通知で知らせる
        Window("nanaichi", id: "main") {
            MainView(model: appDelegate.model)
        }
        .defaultSize(width: 980, height: 640)
        .commands { TimerCommands(model: appDelegate.model) }
    }
}

/// アプリの間ずっと生きている部品を持つ。ウィンドウを閉じてもタイマーを進め、終了の前に通知の予約を整える
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let model: TimerModel
    private var running: Task<Void, Never>?

    override init() {
        let configuration = LaunchConfiguration.current()
        model = TimerModel(
            backend: DeviceBackend(location: configuration.database, clock: configuration.clock.now),
            clock: configuration.clock, alert: PhaseAlertPlayer(),
            notifications: PhaseNotificationScheduler(clock: configuration.clock),
            alertSettings: AlertSettingsStore.load)
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
            // XCUITest がダークの見た目を撮るため。起動引数の -AppleInterfaceStyle は macOS 26 のアプリには効かない
            switch ProcessInfo.processInfo.environment["NANAICHI_APPEARANCE"] {
            case "Dark": NSApp.appearance = NSAppearance(named: .darkAqua)
            case "Light": NSApp.appearance = NSAppearance(named: .aqua)
            default: break
            }
        #endif
        running = Task { await model.run() }
    }

    /// 終了する前に、通知の予約を音の鳴るものに入れ替える（動いている間はアプリが自分で鳴らす）
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task {
            await model.prepareForTermination()
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

/// 知らせ方の設定を読む。設定の画面（#143）ができるまでは、いつも初期の設定になる
enum AlertSettingsStore {
    static let key = "alertSettings"

    static func load() -> AlertSettings {
        AlertSettings.parse(UserDefaults.standard.data(forKey: key))
    }
}
