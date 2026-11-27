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
    @ObservationIgnored private let runtime = RuntimeSession()
    @ObservationIgnored private var watch = PhaseChangeVibration()
    /// iPhone に範囲を伝えて、答えを待っている。答えが来るまで次を伝えない（伝える順と届く順を入れ替えない）
    @ObservationIgnored private var telling = false
    /// iPhone に届かなかったので、この端末の時刻まで伝え直さない（刻みごとに頼み続けない）
    @ObservationIgnored private var retryAt: Instant?

    private static let retryAfterMs: Int64 = 10_000

    init(link: any PhoneLink) {
        self.link = link
    }

    /// アプリが前に出た。拡張ランタイムセッションは前にいるときにしか始められないので、ここで始め直せるようにする
    func appBecameActive() {
        runtime.appBecameActive()
    }

    /// 刻みごとに呼ぶ。`received` は iPhone から届いたスナップショット、`deviceNow` はこの端末の時刻
    func tick(_ received: Received?, inSession: Bool, deviceNow: Instant, appActive: Bool) {
        runtime.keep(running: inSession, appActive: appActive)
        let now = received?.serverNow(deviceNow: deviceNow) ?? deviceNow
        let vibratableUntil = runtime.endsAt.map { end in
            let deviceEnd = Instant(milliseconds: Int64((end.timeIntervalSince1970 * 1000).rounded(.down)))
            return received?.serverNow(deviceNow: deviceEnd) ?? deviceEnd
        }
        // 振動できないあいだは、範囲が残っていても知らせない（iPhone に閉じたと伝えるまでの間、知らせが抜ける）
        let within = vibratableUntil == nil ? .off : confirmed
        vibrating = within.covers(now)
        if let to = watch.observe(received?.snapshot, now: now, within: within) {
            WKInterfaceDevice.current().play(hapticOf(to.kind))
            played += 1
        }
        if let next = watchVibrationToTell(confirmed: confirmed, vibratableUntil: vibratableUntil, now: now) {
            tell(next, deviceNow: deviceNow)
        }
    }

    private func tell(_ vibration: WatchVibration, deviceNow: Instant) {
        guard !telling, retryAt.map({ deviceNow >= $0 }) ?? true else { return }
        telling = true
        Task {
            let answer = await link.ask(.vibration(vibration))
            telling = false
            switch answer {
            case .accepted?:
                confirmed = vibration
                retryAt = nil
            // 届かなかった・受け取れなかった（古い版の iPhone のアプリなど）。範囲は替わらないので、iPhone の通知が知らせる
            case .snapshot?, .refused?, nil:
                retryAt = deviceNow.adding(milliseconds: Self.retryAfterMs)
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
    /// 止められた（時間切れ・ほかのアプリに移った・始められなかった）。次にアプリが前に出るまで始め直さない
    private var waitsForActivation = false
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "app.nanaichi", category: "vibration")

    /// 残りがこれより短いときにアプリが前に出たら、始め直して伸ばす
    private static let renewWhenLeft: TimeInterval = 30 * 60

    /// 動いていれば、終わる時刻
    var endsAt: Date? {
        guard let session, session.state == .running else { return nil }
        return session.expirationDate
    }

    /// `running` なら動かし、そうでなければ止める。始められるのはアプリが前にいるときだけ
    func keep(running: Bool, appActive: Bool) {
        switch (running, session) {
        case (true, nil):
            guard appActive, !waitsForActivation else { return }
            let started = WKExtendedRuntimeSession()
            started.delegate = self
            started.start()
            session = started
        case (false, let current?):
            session = nil
            current.invalidate()
        case (true, .some), (false, nil):
            break
        }
    }

    func appBecameActive() {
        waitsForActivation = false
        guard let session, let end = endsAt, end.timeIntervalSinceNow < Self.renewWhenLeft else { return }
        self.session = nil
        session.invalidate()
    }

    nonisolated func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        let id = ObjectIdentifier(extendedRuntimeSession)
        Task { @MainActor in
            guard session.map(ObjectIdentifier.init) == id else { return }
            log.info("拡張ランタイムセッションが始まった")
        }
    }

    nonisolated func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {}

    /// 自分で止めたもの（`session` から外してから止める）でなければ、次にアプリが前に出るまで始め直さない
    nonisolated func extendedRuntimeSession(
        _ extendedRuntimeSession: WKExtendedRuntimeSession,
        didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: (any Error)?
    ) {
        let id = ObjectIdentifier(extendedRuntimeSession)
        let reasonText = String(describing: reason.rawValue)
        let errorText = error?.localizedDescription ?? "なし"
        Task { @MainActor in
            guard session.map(ObjectIdentifier.init) == id else { return }
            session = nil
            waitsForActivation = true
            log.info(
                "拡張ランタイムセッションが止まった: \(reasonText, privacy: .public)（\(errorText, privacy: .public)）")
        }
    }
}
