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
@Observable
@MainActor
final class WatchModel {
    private(set) var loading: TimerLoading = .loading
    private(set) var reach: PhoneReach = .unreachable
    private(set) var deviceNow: Instant
    /// 頼んだ操作の答えを待っている
    private(set) var pending = false
    /// 直前の操作の失敗
    private(set) var errorMessage: String?

    @ObservationIgnored private let link: any PhoneLink
    @ObservationIgnored private let clock: @Sendable () -> Instant

    /// 刻みの間隔。表示は秒単位なので、秒の変わり目から遅れても 1/4 秒まで
    private static let tick = Duration.milliseconds(250)

    init(link: any PhoneLink, clock: @escaping @Sendable () -> Instant) {
        self.link = link
        self.clock = clock
        deviceNow = clock()
    }

    var face: WatchFace { .of(.of(loading, deviceNow: deviceNow), reach: reach, pending: pending) }

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
            try? await Task.sleep(for: Self.tick)
        }
    }

    private func receive() async {
        for await event in link.events() {
            switch event {
            case .reach(let reach):
                self.reach = reach
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
        guard let answer = await link.ask(message) else {
            switch message {
            case .start, .abort: errorMessage = phoneDidNotAnswerMessage
            // 今の様子は、届かなくても前に受け取ったものを出し続ける
            case .current: break
            }
            return
        }
        handle(answer)
    }

    private func handle(_ message: PhoneMessage) {
        switch message {
        case .snapshot(let received):
            loading = loading.applying(received)
            deviceNow = clock()
        case .refused(let message):
            errorMessage = message
        }
    }
}

// UUID の文字列は必ず UUID の形なので、読めないのは実装の誤り
private func newEventId() -> SessionEventId { SessionEventId(UUID().uuidString.lowercased())! }
