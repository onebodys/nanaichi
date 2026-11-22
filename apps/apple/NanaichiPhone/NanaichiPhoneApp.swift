import AVFoundation
import NanaichiAccount
import NanaichiDevice
import NanaichiDomain
import NanaichiWatchLink
import SwiftUI
import UIKit
import UserNotifications

/// iPhone のアプリ（ADR 0031）。タイマーとジャーナル記入だけを使う。ログインしていなければこの端末の記録先、
/// していればアカウントの記録先で動き、Mac・Web と同期する（Issue #71）。
/// スタッツ・タスク・タグの管理・設定の画面は Web と Mac で使う
@main
struct NanaichiPhoneApp: App {
    @UIApplicationDelegateAdaptor(PhoneAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            PhoneRootView(model: appDelegate.model)
                .preferredColorScheme(debugColorScheme())
        }
        .onChange(of: scenePhase) { _, phase in appDelegate.scenePhaseChanged(phase) }
    }
}

/// アプリの間ずっと生きている部品を持つ。裏に回るときは、音を鳴らせなくなるので通知に知らせを任せる
@MainActor
final class PhoneAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model: PhoneModel
    /// この端末の記録先。ログインしている間も閉じずに持つ
    private let device: DeviceBackend
    /// Watch とのつなぎ。Watch の頼みは、そのときの記録先に通す
    private let watch: WatchRelay

    override init() {
        let launch = LaunchConfiguration.current()
        let alertSettings = AlertSettingsStore()
        let alert = PhaseAlertPlayer()
        device = DeviceBackend(location: launch.database, clock: launch.clock.now)
        let watch = WatchRelay()
        self.watch = watch
        // タスク（ToDo）は iPhone では使わない（ADR 0031）
        model = PhoneModel(device: device, accounts: launch.accounts, thisDevice: launch.thisDevice) { backend, _ in
            let backend = debugBackend(backend)
            // 記録先を替えるたびに作り直すので、ここで記録先の印を発行する
            let recordStore = RecordStoreTag(UUID().uuidString)
            let timer = TimerModel(
                backend: backend, clock: launch.clock,
                alert: alert, notifications: PhaseNotificationScheduler(clock: launch.clock),
                alertSettings: { alertSettings.settings })
            timer.snapshotChanged = { watch.snapshotChanged(PhoneSnapshot(received: $0, recordStore: recordStore)) }
            return PhoneServices(backend: backend, timer: timer, recordStore: recordStore)
        }
        // Watch の頼みは、そのときの記録先に通す（ログイン・ログアウトで替わる）
        watch.activate { [model] in (model.services.backend, model.services.recordStore) }
        super.init()
        UNUserNotificationCenter.current().delegate = self
        // 切り替わりの音はほかのアプリの音に重ねて鳴らし、消音のスイッチに従う（時計のアラームのように鳴らし分けない）
        try? AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
    }

    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        Task { [model, device] in
            #if DEBUG
                await runSelfCheckIfAsked()
                await applyDebugAdvanceMode(ProcessInfo.processInfo.environment, to: device)
            #endif
            model.start()
        }
        return true
    }

    /// 裏に回るときは、アプリが止められて音を鳴らせなくなるので、通知の予約を音の鳴るものに入れ替える。
    /// 入れ替え終わるまで OS に止めるのを待ってもらう。前に戻ったら、アプリが自分で鳴らす
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            let handOver = BackgroundHandOver()
            Task { [timer = model.services.timer] in
                await timer.handOverAlertsToNotifications()
                handOver.finish()
            }
        case .active:
            model.services.timer.takeBackAlerts()
            // 裏にいる間に同期の接続が切れていることがある
            Task { [model] in await model.checkSyncConnection() }
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

/// アプリの間ずっと生きている部品（記録先を決め、替わるたびに `PhoneServices` を作り直す）。Mac と同じもの
typealias PhoneModel = RecordStoreModel<PhoneServices>

/// 1つの記録先につないだ画面の状態。iPhone にはタイマー（とジャーナル記入）だけがある（ADR 0031）
@MainActor
final class PhoneServices: RecordStoreServices {
    let backend: any Backend
    let timer: TimerModel
    /// Watch に送るスナップショットに添える、この記録先の印
    let recordStore: RecordStoreTag

    init(backend: any Backend, timer: TimerModel, recordStore: RecordStoreTag) {
        self.backend = backend
        self.timer = timer
        self.recordStore = recordStore
    }

    func run() async { await timer.run() }
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
