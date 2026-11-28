import NanaichiDomain
import NanaichiPresentation
import NanaichiWatchLink
import WatchConnectivity

/// Watch とのつなぎ（ADR 0031）。記録を書くのは iPhone だけなので、Watch の頼みはいまの記録先に通して答え、
/// 手元のスナップショットが替わったら Watch に知らせる。
///
/// Watch が振動で知らせる範囲（ADR 0033）も受け取って覚える。その範囲の切り替わりは、iPhone で通知しない
///
/// Watch が頼むと、iPhone のアプリが裏で起こされることがある。起こされたときも頼みに答えられるよう、
/// アプリの部品を作ったところで WatchConnectivity を動かし始める
final class WatchRelay: NSObject, WCSessionDelegate, @unchecked Sendable {
    // WCSession は使う側が排他しなくてよい（どのスレッドから呼んでもよい）。記録先はメインアクターで読む
    private let session: WCSession? = WCSession.isSupported() ? .default : nil
    /// いまの記録先とその印。`activate` で1回だけ決め、そのあとは読むだけ
    private var recordStore: @MainActor () -> (any Backend, RecordStoreTag) = {
        preconditionFailure("WatchRelay を動かす前に頼みが届いた")
    }
    /// Watch に置いておく最新のスナップショット。Watch とつながったとき（動き始めた・Watch にアプリが入った）にも置き直す。
    /// 読むのも、application context に置くのもメインアクターだけで行い、古いものが新しいものを上書きしないようにする
    @MainActor private var latest = PhoneSnapshotLoading.waiting
    /// Watch が振動で知らせる範囲と、Watch がそれを伝えた順の番号。iPhone の通知の予約は、この範囲の切り替わりを除く。
    /// iPhone のアプリが裏で止められて起動し直しても範囲を忘れないよう、この端末に残しておく（忘れると、Watch が振動で
    /// 知らせる切り替わりを通知にも予約し直し、二重になる）。範囲には期限があるので、古いものが残っていても害はない
    @MainActor private(set) var vibration = restoredVibration()
    /// 範囲が替わったときに、通知を予約し直して終わるまで待つ。`activate` で1回だけ決める
    private var vibrationChanged: @MainActor () async -> Void = {}

    /// Watch とつなぎ始める。`recordStore` はいまの記録先とその印で、ログイン・ログアウトで替わるので、頼みが届くたびに読む。
    /// `vibrationChanged` は、Watch が振動で知らせる範囲が替わったときに、通知を予約し直して終わるまで待つ
    func activate(
        recordStore: @escaping @MainActor () -> (any Backend, RecordStoreTag),
        vibrationChanged: @escaping @MainActor () async -> Void
    ) {
        self.recordStore = recordStore
        self.vibrationChanged = vibrationChanged
        session?.delegate = self
        session?.activate()
    }

    /// 手元のスナップショットが替わった。Watch がいま届かなくても、届くようになったときに最新のものが渡るよう置いておき、
    /// 届くなら今すぐも送る
    @MainActor
    func snapshotChanged(_ snapshot: PhoneSnapshot) {
        latest = latest.applying(snapshot)
        deliverLatest(sendingNow: true)
    }

    @MainActor
    private func deliverLatest(sendingNow: Bool) {
        guard let session, case .loaded(let snapshot) = latest, session.activationState == .activated,
            session.isPaired, session.isWatchAppInstalled
        else { return }
        let data = WatchLinkCoding.encode(PhoneMessage.snapshot(snapshot))
        try? session.updateApplicationContext([WatchLinkCoding.latestKey: data])
        if sendingNow, session.isReachable { session.sendMessageData(data, replyHandler: nil) }
    }

    /// 頼みをいまの記録先に通す。答えを待つあいだにログイン・ログアウトで記録先が替わったら、前の記録先の答えは返さず、
    /// 替わった先の今の様子を返す。Watch が、もう使っていない記録先の様子を出し続けないように
    @MainActor
    private func answer(_ message: WatchMessage) async -> PhoneMessage {
        switch message {
        // 通知を予約し直し終えてから答える。Watch は答えを受け取ってから振動で知らせ始めるので、
        // その範囲の通知が残ったまま Watch も振動する、ということがない
        // 前に伝えられたものより前に伝えたもの（遅れて届いた）は捨て、受け取ったとは答えない
        // （Watch がその範囲を iPhone が持っていると思わないように）。同じ頼みの送り直しは、受け取ったと答える
        case .vibration(let told):
            guard let applied = vibration.applying(told) else {
                return .refused(message: "前に届いた頼みより古い頼みです。")
            }
            guard applied != vibration else { return .accepted }
            vibration = applied
            UserDefaults.standard.set(WatchLinkCoding.encode(applied), forKey: vibrationKey)
            await vibrationChanged()
            return .accepted
        case .current, .start, .abort:
            break
        }
        var (backend, tag) = recordStore()
        var answer = await replyTo(message, using: backend, recordStore: tag)
        // 取り直すあいだにまた替わることもあるので、替わらなくなるまで取り直す。開始・中断はやり直さない
        while case let (current, currentTag) = recordStore(), currentTag != tag {
            (backend, tag) = (current, currentTag)
            answer = await replyTo(.current, using: backend, recordStore: tag)
        }
        return answer
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, didReceiveMessageData messageData: Data, replyHandler: @escaping (Data) -> Void) {
        let reply = UncheckedSendable(replyHandler)
        guard let message = WatchLinkCoding.decode(WatchMessage.self, from: messageData) else {
            reply.value(WatchLinkCoding.encode(PhoneMessage.refused(message: "iPhone のアプリを新しくしてください。")))
            return
        }
        Task { @MainActor [self] in
            let answer = await answer(message)
            reply.value(WatchLinkCoding.encode(answer))
            // 答えたスナップショットも、Watch に置いておく最新にする（答えは Watch に直接届くので、送り直さない）
            switch answer {
            case .snapshot(let snapshot):
                latest = latest.applying(snapshot)
                deliverLatest(sendingNow: false)
            case .refused, .accepted: break
            }
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?)
    {
        Task { @MainActor in deliverLatest(sendingNow: false) }
    }

    /// Watch にアプリが入った・ペアの Watch が替わった
    func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in deliverLatest(sendingNow: false) }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    /// ペアの Watch を替えると止まる。次の Watch とつなぐため、動かし直す
    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}

/// この端末に残しておく、Watch が振動で知らせる範囲のキー
private let vibrationKey = "watchVibration"

/// 前に起動していたときに受け取った、Watch が振動で知らせる範囲。なければ（読めなければ）何も伝えられていない
private func restoredVibration() -> ToldWatchVibration {
    UserDefaults.standard.data(forKey: vibrationKey)
        .flatMap { WatchLinkCoding.decode(ToldWatchVibration.self, from: $0) } ?? .none
}

/// WatchConnectivity が渡す返事の関数は Sendable と書かれていないが、どのスレッドから呼んでもよい
struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
