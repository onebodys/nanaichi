import Foundation
import NanaichiDomain
import NanaichiPresentation
import NanaichiWatchLink
import Observation
import WatchKit
import os

/// 画面が消えていても（手首を下ろしたままでも）、フェーズの切り替わりを Watch の振動で知らせる（Issue #73、ADR 0033）。
///
/// - セッション中は拡張ランタイムセッションを動かし、手首を下ろしてもアプリを動かし続ける
/// - 振動で知らせる範囲（`WatchVibration`）を iPhone に伝え、iPhone が受け取ったと答えた範囲の切り替わりだけを振動で知らせる。
///   範囲の外は iPhone の通知（Watch に転送される）が知らせるので、1回の切り替わりで知らせは1回になる
@Observable
@MainActor
final class PhaseChangeVibrator {
    /// iPhone が受け取ったと答えた範囲
    private(set) var confirmed = WatchVibration.off
    /// いま振動で知らせているか（拡張ランタイムセッションが動いていて、iPhone が範囲を受け取った）
    private(set) var vibrating = false
    /// 振動で知らせた回数。デバッグのビルドで XCUITest が読む（振動そのものはシミュレーターで確かめられない）
    private(set) var played = 0

    @ObservationIgnored private let link: any PhoneLink
    @ObservationIgnored private let clock: @Sendable () -> Instant
    @ObservationIgnored private let runtime = RuntimeSession()
    @ObservationIgnored private var watch = PhaseChangeVibration()
    /// 前の刻みで受け取っていたスナップショット。拡張ランタイムセッションが止まったときに、刻みを待たずに範囲を閉じるのに使う
    @ObservationIgnored private var received: Received?
    /// iPhone に伝えて、答えを待っているもの。答えが来るまで、範囲を伸ばす頼みを重ねない
    @ObservationIgnored private var inFlight: ToldWatchVibration?
    /// iPhone に届かなかったもの（の種類）と、この端末の時刻でいつまで伝え直さないか（刻みごとに頼み続けない）
    @ObservationIgnored private var failed: (vibration: WatchVibration, retryAt: Instant)?

    private static let retryAfterMs: Int64 = 10_000

    init(link: any PhoneLink, clock: @escaping @Sendable () -> Instant) {
        self.link = link
        self.clock = clock
        runtime.stopped = { [weak self] in self?.runtimeStopped() }
    }

    /// アプリが前に出た。拡張ランタイムセッションは前にいるときにしか始められないので、ここで始め直せるようにする
    func appBecameActive() {
        runtime.appBecameActive()
    }

    /// iPhone に届くようになった。届かなかった頼みを待たずに伝え直す
    func phoneReachable() {
        failed = nil
    }

    /// 刻みごとに呼ぶ。`received` は iPhone から届いたスナップショット、`deviceNow` はこの端末の時刻
    func tick(_ received: Received?, inSession: Bool, deviceNow: Instant, appActive: Bool) {
        self.received = received
        runtime.keep(running: inSession, appActive: appActive)
        let now = received?.serverNow(deviceNow: deviceNow) ?? deviceNow
        let vibratableUntil = vibratableUntil(received)
        // 振動できないあいだは、範囲が残っていても知らせない（iPhone に閉じたと伝えるまでの間、知らせが抜ける）
        let within = vibratableUntil == nil ? .off : confirmed
        vibrating = within.covers(now)
        if let to = watch.observe(received?.snapshot, now: now, within: within) { play(to) }
        if let next = watchVibrationToTell(confirmed: confirmed, vibratableUntil: vibratableUntil, now: now) {
            tell(next, now: now, deviceNow: deviceNow)
        }
    }

    /// 拡張ランタイムセッションが止められた（ほかのアプリに移った・時間切れ・始められなかった）。止められたアプリはすぐ眠らされるので、
    /// 次の刻みを待たずに範囲を閉じると伝える
    private func runtimeStopped() {
        vibrating = false
        let deviceNow = clock()
        let now = received?.serverNow(deviceNow: deviceNow) ?? deviceNow
        if let next = watchVibrationToTell(confirmed: confirmed, vibratableUntil: nil, now: now) {
            tell(next, now: now, deviceNow: deviceNow)
        }
    }

    /// 振動できるのが記録先の時刻でいつまでか。振動できなければ nil
    private func vibratableUntil(_ received: Received?) -> Instant? {
        runtime.endsAt.map { end in
            let deviceEnd = Instant(milliseconds: Int64((end.timeIntervalSince1970 * 1000).rounded(.down)))
            return received?.serverNow(deviceNow: deviceEnd) ?? deviceEnd
        }
    }

    private func play(_ to: Phase) {
        WKInterfaceDevice.current().play(hapticOf(to.kind))
        played += 1
    }

    /// 範囲 `vibration` を、記録先の時刻 `now` に iPhone に伝える。
    ///
    /// 伸ばす・始めるのは、前の答えを待ってから。閉じるのは急ぐので、伸ばす頼みの答えを待たず、伸ばす頼みが届かなかったあとでも
    /// 待たずに伝える。iPhone は伝えた時刻で新旧を決めるので、先に送った範囲が後から届いても閉じたままになる（`ToldWatchVibration`）
    private func tell(_ vibration: WatchVibration, now: Instant, deviceNow: Instant) {
        if let inFlight, inFlight.vibration == .off || vibration != .off { return }
        if let failed, failed.vibration == vibration || vibration != .off, deviceNow < failed.retryAt { return }
        let told = ToldWatchVibration(vibration: vibration, toldAt: now)
        let since = watch.checkpoint
        inFlight = told
        Task {
            let answer = await link.ask(.vibration(told))
            // あとから伝えたものがあれば、この答えでは決めない（あとのものの答えで決める）
            guard inFlight == told else { return }
            inFlight = nil
            switch answer {
            case .accepted?:
                let previous = confirmed
                confirmed = vibration
                failed = nil
                // 答えを待つあいだに過ぎた切り替わりのうち、新しく任された分は、iPhone がもう通知を消している
                if let since, let to = watch.widened(from: previous, to: vibration, since: since) { play(to) }
            // 届かなかった・受け取れなかった（古い版の iPhone のアプリなど）。範囲は替わらないので、iPhone の通知が知らせる
            case .snapshot?, .refused?, nil:
                failed = (vibration, deviceNow.adding(milliseconds: Self.retryAfterMs))
            }
        }
    }
}

/// 移った先のフェーズごとの振動。手首を下ろしたままでも、どのフェーズに移ったかを感じ分けられるように変える
private func hapticOf(_ to: PhaseKind) -> WKHapticType {
    switch to {
    case .focus: .start
    case .journal: .notification
    case .breakTime: .success
    }
}

/// 拡張ランタイムセッション（Info.plist の WKBackgroundModes が mindfulness）。動いているあいだは、画面が消えても
/// アプリが前にいるまま動き続け、振動を鳴らせる。1回に動けるのは1時間まで
@MainActor
private final class RuntimeSession: NSObject, WKExtendedRuntimeSessionDelegate {
    private var session: WKExtendedRuntimeSession?
    /// 伸ばすために止めた前のもの。同時に2つは動かせないので、止まった知らせを受けてから次を始める
    private var retiring: ObjectIdentifier?
    /// 伸ばすために入れ替えているあいだ（前のものを止めてから次が動き出すまで）、前のものが終わるはずだった時刻。
    /// 入れ替えはアプリが前にいるときにしか行わず、そのあいだもアプリは動いて振動できるので、振動できる時刻として使い続ける
    /// （iPhone に範囲を閉じると伝えて、すぐまた伸ばす往復をしない）
    private var bridging: Date?
    /// 止められた（時間切れ・ほかのアプリに移った・始められなかった）。次にアプリが前に出るまで始め直さない
    private var waitsForActivation = false
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "app.nanaichi", category: "vibration")
    /// 自分で止めたのでなく止められたときに呼ぶ
    var stopped: () -> Void = {}

    /// 残りがこれより短いときにアプリが前に出たら、始め直して伸ばす
    private static let renewWhenLeft: TimeInterval = 30 * 60

    /// 動いていれば（入れ替えているあいだも）、終わる時刻
    var endsAt: Date? {
        if let session, session.state == .running { return session.expirationDate }
        return bridging
    }

    /// `running` なら動かし、そうでなければ止める。始められるのはアプリが前にいるときだけ
    func keep(running: Bool, appActive: Bool) {
        // 前のものの止まった知らせが来ないまま、前のものが終わるはずだった時刻を過ぎたら、入れ替えをあきらめる
        if let bridging, bridging <= Date() {
            self.bridging = nil
            retiring = nil
        }
        switch (running, session) {
        case (true, nil):
            guard appActive, !waitsForActivation, retiring == nil else { return }
            let started = WKExtendedRuntimeSession()
            started.delegate = self
            started.start()
            session = started
        case (false, let current?):
            bridging = nil
            session = nil
            current.invalidate()
        case (false, nil):
            bridging = nil
        case (true, .some):
            break
        }
    }

    /// 止まった知らせ（`didInvalidate`）が前に出たあとに遅れて届いても、始め直しを止めないよう、
    /// 止まっているものはここで外す（外したものの知らせは、`session` と比べて捨てる）
    func appBecameActive() {
        waitsForActivation = false
        guard let session else { return }
        switch session.state {
        case .invalid:
            self.session = nil
        case .running:
            guard let end = session.expirationDate, end.timeIntervalSinceNow < Self.renewWhenLeft else { return }
            retiring = ObjectIdentifier(session)
            bridging = end
            self.session = nil
            session.invalidate()
        // 始めている途中。始まるか止まるかの知らせを待つ
        case .notStarted, .scheduled:
            break
        @unknown default:
            break
        }
    }

    nonisolated func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        let id = ObjectIdentifier(extendedRuntimeSession)
        Task { @MainActor in
            guard session.map(ObjectIdentifier.init) == id else { return }
            // 次が動き出したので、入れ替えは終わり
            bridging = nil
            log.info("拡張ランタイムセッションが始まった")
        }
    }

    nonisolated func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {}

    /// 伸ばすために止めた前のものなら、次を始められるようにする。自分で止めたもの（`session` から外してから止める）でもなければ、
    /// 次にアプリが前に出るまで始め直さず、止められたことを知らせる
    nonisolated func extendedRuntimeSession(
        _ extendedRuntimeSession: WKExtendedRuntimeSession,
        didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: (any Error)?
    ) {
        let id = ObjectIdentifier(extendedRuntimeSession)
        let reasonText = String(describing: reason.rawValue)
        let errorText = error?.localizedDescription ?? "なし"
        Task { @MainActor in
            if retiring == id {
                retiring = nil
                return
            }
            guard session.map(ObjectIdentifier.init) == id else { return }
            session = nil
            bridging = nil
            waitsForActivation = true
            log.info(
                "拡張ランタイムセッションが止まった: \(reasonText, privacy: .public)（\(errorText, privacy: .public)）")
            stopped()
        }
    }
}
