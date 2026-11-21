import AVFoundation
import NanaichiDevice
import SwiftUI
import UIKit
import UserNotifications

/// iPhone のアプリ（ADR 0031）。タイマーとジャーナル記入だけを、この端末の記録先で使う。
/// スタッツ・タスク・タグの管理・設定の画面は Web と Mac で使う
@main
struct NanaichiPhoneApp: App {
    @UIApplicationDelegateAdaptor(PhoneAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            HomeView(timer: appDelegate.timer)
                .preferredColorScheme(debugColorScheme())
        }
        .onChange(of: scenePhase) { _, phase in appDelegate.scenePhaseChanged(phase) }
    }
}

/// アプリの間ずっと生きている部品を持つ。裏に回るときは、音を鳴らせなくなるので通知に知らせを任せる
@MainActor
final class PhoneAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let timer: TimerModel
    private let backend: DeviceBackend
    private var running: Task<Void, Never>?

    override init() {
        let launch = currentDeviceLaunch()
        let alertSettings = AlertSettingsStore()
        backend = DeviceBackend(location: launch.database, clock: launch.clock.now)
        timer = TimerModel(
            backend: backend, clock: launch.clock,
            alert: PhaseAlertPlayer(), notifications: PhaseNotificationScheduler(clock: launch.clock),
            alertSettings: { alertSettings.settings })
        super.init()
        UNUserNotificationCenter.current().delegate = self
        // 切り替わりの音はほかのアプリの音に重ねて鳴らし、消音のスイッチに従う（時計のアラームのように鳴らし分けない）
        try? AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
    }

    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        running = Task { [timer, backend] in
            #if DEBUG
                await applyDebugAdvanceMode(ProcessInfo.processInfo.environment, to: backend)
            #endif
            await timer.run()
        }
        return true
    }

    /// 裏に回るときは、アプリが止められて音を鳴らせなくなるので、通知の予約を音の鳴るものに入れ替える。
    /// 入れ替え終わるまで OS に止めるのを待ってもらう。前に戻ったら、アプリが自分で鳴らす
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            let handOver = BackgroundHandOver()
            Task { [timer] in
                await timer.handOverAlertsToNotifications()
                handOver.finish()
            }
        case .active:
            timer.takeBackAlerts()
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    /// アプリが前にあるときに届いた通知。音はアプリが鳴らしているので、通知センターに残すだけにする
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.list]
    }
}

/// 裏に回ってから通知の予約を入れ替え終わるまで、OS にアプリを止めるのを待ってもらう。
/// 待てる時間を過ぎたら、入れ替えの途中でも OS に返す
@MainActor
private final class BackgroundHandOver {
    private var identifier = UIBackgroundTaskIdentifier.invalid

    init() {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "通知の予約を入れ替える") { [weak self] in
            self?.finish()
        }
    }

    func finish() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}

private func currentDeviceLaunch() -> DeviceLaunch {
    #if DEBUG
        if let debug = DeviceLaunch.debug(ProcessInfo.processInfo.environment) { return debug }
    #endif
    return .standard
}

/// XCUITest がダークの見た目を撮るための明るさ（`NANAICHI_APPEARANCE`）。デバッグのビルドにだけある
private func debugColorScheme() -> ColorScheme? {
    #if DEBUG
        switch ProcessInfo.processInfo.environment["NANAICHI_APPEARANCE"] {
        case "Dark": return .dark
        case "Light": return .light
        default: return nil
        }
    #else
        return nil
    #endif
}
