import Foundation
import NanaichiDomain
import NanaichiPresentation
import NanaichiWatchLink
import Observation

/// Watch の画面の状態と操作（ADR 0031）。
///
/// - iPhone から届いたスナップショットを持ち、刻みごとに Watch の時刻で状態を計算し直す（ADR 0003）
/// - 開始と中断は iPhone に頼み、返ってきたスナップショットに置き換える。iPhone に届かないあいだは頼まない
/// - iPhone の側の変化は、iPhone からの知らせで届く。頼みの答えと知らせは入れ替わって届くので、古いものは捨てる（ADR 0012）
/// - セッション中は、フェーズの切り替わりを振動で知らせる（`PhaseChangeVibrator`、ADR 0033）
@Observable
@MainActor
final class WatchModel {
    private(set) var loading: PhoneSnapshotLoading = .waiting
    private(set) var reach: PhoneReach = .unreachable
    private(set) var deviceNow: Instant
    /// 頼んだ操作の答えを待っている
    private(set) var pending = false
    /// 直前の操作の失敗
    private(set) var errorMessage: String?
    let vibrator: PhaseChangeVibrator

    @ObservationIgnored private let link: any PhoneLink
    @ObservationIgnored private let clock: @Sendable () -> Instant
    /// アプリが前にいる（画面に出ている）
    @ObservationIgnored private var active = false

    /// 刻みの間隔。表示は秒単位なので、秒の変わり目から遅れても 1/4 秒まで
    private static let tick = Duration.milliseconds(250)

    init(link: any PhoneLink, clock: @escaping @Sendable () -> Instant) {
        self.link = link
        self.clock = clock
        vibrator = PhaseChangeVibrator(link: link, clock: clock)
        deviceNow = clock()
    }

    /// アプリが前に出た・前から外れた（手首を下ろした・ほかのアプリに移った）
    func activeChanged(_ active: Bool) {
        self.active = active
        if active { vibrator.appBecameActive() }
    }

    var face: WatchFace { .of(.of(loading.timer, deviceNow: deviceNow), reach: reach, pending: pending) }

    /// iPhone からの知らせを受け取り、刻み続ける。アプリが動いている間ずっと呼んだままにする
    func run() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.receive() }
            group.addTask { await self.keepTicking() }
        }
    }

    private func keepTicking() async {
        while !Task.isCancelled {
            deviceNow = clock()
            let view = TimerView.of(loading.timer, deviceNow: deviceNow)
            vibrator.tick(loading.timer.received, inSession: view.isInSession, deviceNow: deviceNow, appActive: active)
            try? await Task.sleep(for: Self.tick)
        }
    }

    private func receive() async {
        for await event in link.events() {
            switch event {
            case .reach(let reach):
                self.reach = reach
                if reach == .reachable { vibrator.phoneReachable() }
                // 届かなかったあいだの変化は知らせで届くが、届くようになったら今の様子を確かめる
                if reach == .reachable { Task { await ask(.current) } }
            case .message(let message):
                handle(message)
            }
        }
    }

    // MARK: - 操作

    func start() { send(.start(id: newEventId())) }

    func abort() { send(.abort(id: newEventId())) }

    private func send(_ message: WatchMessage) {
        pending = true
        errorMessage = nil
        Task {
            await ask(message)
            pending = false
        }
    }

    private func ask(_ message: WatchMessage) async {
        let answer = await link.ask(message)
        switch (message, answer) {
        case (_, .snapshot(let snapshot)?):
            apply(snapshot)
        case (.start, .refused(let refusal)?), (.abort, .refused(let refusal)?):
            errorMessage = refusal
            // iPhone の様子が、Watch の思っているものと違ったのかもしれない（自動終了したなど）
            await ask(.current)
        case (.start, nil), (.abort, nil):
            errorMessage = phoneDidNotAnswerMessage
        // 今の様子を読めなくても、操作の失敗ではないので、前に受け取ったものを出し続ける
        case (.current, .refused?), (.current, nil):
            break
        // 受け取っただけの答えは、記録先に通さない頼み（振動で知らせる範囲。`PhaseChangeVibrator` が頼む）にしか返らない
        case (_, .accepted?), (.vibration, _):
            break
        }
    }

    private func handle(_ message: PhoneMessage) {
        switch message {
        case .snapshot(let snapshot): apply(snapshot)
        // 知らせで断られることはない（断るのは頼みへの答えだけ）
        case .refused, .accepted: break
        }
    }

    private func apply(_ snapshot: PhoneSnapshot) {
        loading = loading.applying(snapshot)
        deviceNow = clock()
    }
}

// UUID の文字列は必ず UUID の形なので、読めないのは実装の誤り
private func newEventId() -> SessionEventId { SessionEventId(UUID().uuidString.lowercased())! }
