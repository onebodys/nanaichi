import NanaichiDevice
import NanaichiDomain
import NanaichiPresentation

/// スタッツとジャーナル記入の見返しのウィンドウの ID
let reviewWindowId = "review"

/// アプリの間ずっと生きている画面の状態。どれも同じ記録先を使い、同期メッセージを受け取り続ける
@MainActor
final class AppServices {
    let timer: TimerModel
    let timeline: TimelineModel
    let tags: TagsModel
    let advanceMode: AdvanceModeModel
    let review: ReviewModel
    let alertSettings: AlertSettingsStore
    let alert: PhaseAlertPlayer

    init(configuration: LaunchConfiguration) {
        let backend = DeviceBackend(location: configuration.database, clock: configuration.clock.now)
        let alertSettings = AlertSettingsStore()
        let alert = PhaseAlertPlayer()
        self.alertSettings = alertSettings
        self.alert = alert
        timer = TimerModel(
            backend: backend, clock: configuration.clock, alert: alert,
            notifications: PhaseNotificationScheduler(clock: configuration.clock),
            alertSettings: { alertSettings.settings })
        timeline = TimelineModel(backend: backend)
        tags = TagsModel(backend: backend)
        advanceMode = AdvanceModeModel(backend: backend)
        review = ReviewModel(backend: backend)
    }

    func run() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.timer.run() }
            group.addTask { await self.timeline.run() }
            group.addTask { await self.tags.run() }
            group.addTask { await self.advanceMode.run() }
            group.addTask { await self.review.run() }
        }
    }
}
