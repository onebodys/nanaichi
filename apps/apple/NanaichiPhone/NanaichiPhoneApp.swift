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
        // 起動したときから前にいれば、そのときも呼ぶ（裏で起動したときは音を通知に任せたまま始めるので、前に出たら取り戻す）
        .onChange(of: scenePhase, initial: true) { _, phase in appDelegate.scenePhaseChanged(phase) }
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
        let recordStoreTags = WatchRecordStoreTags(reusesSaved: reusesSavedRecordStoreTags(launch.database))
        // タスク（ToDo）は iPhone では使わない（ADR 0031）
        model = PhoneModel(device: device, accounts: launch.accounts, thisDevice: launch.thisDevice) { backend, _ in
            let recordStore = recordStoreTags.tag(opening: backend is DeviceBackend)
            let backend = debugBackend(backend)
            let timer = TimerModel(
                backend: backend, clock: launch.clock,
                alert: alert, notifications: PhaseNotificationScheduler(clock: launch.clock),
                alertSettings: { alertSettings.settings },
                // 前にいないとき（Watch の頼みで裏で起動した、など）は、アプリが音を鳴らせないので通知に任せて始める。
                // 裏に回る知らせ（scenePhase）は、裏で起動したときには来ない
                alertsHandedOver: UIApplication.shared.applicationState != .active)
            timer.snapshotChanged = { watch.snapshotChanged(PhoneSnapshot(received: $0, recordStore: recordStore)) }
            // Watch が振動で知らせる切り替わりは通知しない（ADR 0033）
            timer.watchVibration = { watch.vibration.vibration }
            return PhoneServices(backend: backend, timer: timer, recordStore: recordStore)
        }
        recordStoreTags.launched()
        // Watch の頼みは、そのときの記録先に通す（ログイン・ログアウトで替わる）
        watch.activate(
            recordStore: { [model] in (model.services.backend, model.services.recordStore) },
            vibrationChanged: { [model] in await model.services.timer.watchVibrationChanged() },
            // 答えたスナップショットが、いまの記録先のものなら画面に反映する
            snapshotAnswered: { [model] snapshot in
                guard snapshot.recordStore == model.services.recordStore else { return }
                await model.services.timer.applyAnsweredToWatch(snapshot.received)
            })
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

/// 前に起動したときの記録先の印を使い直せるか。記録を残さないときと、デバッグのビルドで記録を消して起動したとき（XCUITest）は、
/// この端末の記録先の変更の番号が 0 から数え直しになるので使い直さない
private func reusesSavedRecordStoreTags(_ database: DeviceDatabaseLocation) -> Bool {
    if case .inMemory = database { return false }
    #if DEBUG
        if ProcessInfo.processInfo.environment["NANAICHI_RESET_DATABASE"] == "1" { return false }
    #endif
    return true
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
