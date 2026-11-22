import AppKit
import Foundation
import NanaichiAccount
import NanaichiDevice
import NanaichiDomain
import NanaichiPresentation
import Observation

/// タイマーとジャーナル記入のメインのウィンドウの ID
let mainWindowId = "main"

/// スタッツとジャーナル記入の見返しのウィンドウの ID
let reviewWindowId = "review"

/// 1つの記録先につないだ画面の状態。どれも同じ記録先を使い、同期メッセージを受け取り続ける。
/// 記録先を替えるときは、作り直す（Web でページを読み込み直すのと同じ、ADR 0019）
@MainActor
final class AppServices: RecordStoreServices {
    let backend: any Backend
    let timer: TimerModel
    let timeline: TimelineModel
    let tags: TagsModel
    let advanceMode: AdvanceModeModel
    let review: ReviewModel
    /// ToDo。アカウントの記録先でだけあり、この端末の記録先では nil（ADR 0026）
    let tasks: TasksModel?
    let alertSettings: AlertSettingsStore
    let alert: PhaseAlertPlayer

    init(
        backend: any Backend, tasks: (any TaskBackend)?, clock: AppClock, alertSettings: AlertSettingsStore,
        alert: PhaseAlertPlayer
    ) {
        self.backend = backend
        self.alertSettings = alertSettings
        self.alert = alert
        timer = TimerModel(
            backend: backend, clock: clock, alert: alert, notifications: PhaseNotificationScheduler(clock: clock),
            alertSettings: { alertSettings.settings })
        timeline = TimelineModel(backend: backend)
        tags = TagsModel(backend: backend)
        advanceMode = AdvanceModeModel(backend: backend)
        review = ReviewModel(backend: backend)
        self.tasks = tasks.map { TasksModel(backend: backend, api: $0) }
    }

    func run() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.timer.run() }
            group.addTask { await self.timeline.run() }
            group.addTask { await self.tags.run() }
            group.addTask { await self.advanceMode.run() }
            group.addTask { await self.review.run() }
            if let tasks = self.tasks { group.addTask { await tasks.run() } }
        }
    }
}

/// アプリの間ずっと生きている部品（記録先を決め、替わるたびに `AppServices` を作り直す）。iPhone と同じもの
typealias AppModel = RecordStoreModel<AppServices>

extension AppModel {
    /// この Mac の記録先を `configuration` の記録のファイルで開き、置いてあるトークンから記録先を決める
    convenience init(configuration: LaunchConfiguration) {
        let alertSettings = AlertSettingsStore()
        let alert = PhaseAlertPlayer()
        self.init(
            device: DeviceBackend(location: configuration.database, clock: configuration.clock.now),
            accounts: configuration.accounts, thisDevice: configuration.thisDevice
        ) { backend, tasks in
            AppServices(
                backend: debugBackend(backend), tasks: tasks, clock: configuration.clock, alertSettings: alertSettings, alert: alert)
        }
    }
}

/// 設定で開いているタブ。メニューの「アカウント…」から、アカウントのタブを開く
@Observable
@MainActor
final class SettingsNavigation {
    var tab: SettingsTab = .timer
}
