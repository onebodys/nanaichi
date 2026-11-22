import NanaichiDomain
import NanaichiPresentation
import NanaichiWatchLink
import Synchronization
import WatchConnectivity

/// Watch とのつなぎ（ADR 0031）。記録を書くのは iPhone だけなので、Watch の頼みはいまの記録先に通して答え、
/// 手元のスナップショットが替わったら Watch に知らせる。
///
/// Watch が頼むと、iPhone のアプリが裏で起こされることがある。起こされたときも頼みに答えられるよう、
/// アプリの部品を作ったところで WatchConnectivity を動かし始める
final class WatchRelay: NSObject, WCSessionDelegate, @unchecked Sendable {
    // WCSession は使う側が排他しなくてよい（どのスレッドから呼んでもよい）。記録先はメインアクターで読む
    private let session: WCSession? = WCSession.isSupported() ? .default : nil
    /// いまの記録先。`activate` で1回だけ決め、そのあとは読むだけ
    private var backend: @MainActor () -> any Backend = { preconditionFailure("WatchRelay を動かす前に頼みが届いた") }
    /// 手元の最新のスナップショット。Watch とつながったとき（動き始めた・Watch にアプリが入った）にも置き直す
    private let latest = Mutex<Received?>(nil)

    /// Watch とつなぎ始める。`backend` はいまの記録先で、ログイン・ログアウトで替わるので、頼みが届くたびに読む
    func activate(backend: @escaping @MainActor () -> any Backend) {
        self.backend = backend
        session?.delegate = self
        session?.activate()
    }

    /// 手元のスナップショットが替わった。Watch がいま届かなくても、届くようになったときに最新のものが渡るよう置いておき、
    /// 届くなら今すぐも送る
    func snapshotChanged(_ received: Received) {
        latest.withLock { $0 = received }
        deliverLatest(sendingNow: true)
    }

    private func deliverLatest(sendingNow: Bool) {
        guard let session, let received = latest.withLock({ $0 }), session.activationState == .activated,
            session.isPaired, session.isWatchAppInstalled
        else { return }
        let data = WatchLinkCoding.encode(PhoneMessage.snapshot(received))
        try? session.updateApplicationContext([WatchLinkCoding.latestKey: data])
        if sendingNow, session.isReachable { session.sendMessageData(data, replyHandler: nil) }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, didReceiveMessageData messageData: Data, replyHandler: @escaping (Data) -> Void) {
        let reply = UncheckedSendable(replyHandler)
        guard let message = WatchLinkCoding.decode(WatchMessage.self, from: messageData) else {
            reply.value(WatchLinkCoding.encode(PhoneMessage.refused(message: "iPhone のアプリを新しくしてください。")))
            return
        }
        Task { @MainActor [backend] in
            let answer = await replyTo(message, using: backend())
            reply.value(WatchLinkCoding.encode(answer))
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?)
    {
        deliverLatest(sendingNow: false)
    }

    /// Watch にアプリが入った・ペアの Watch が替わった
    func sessionWatchStateDidChange(_ session: WCSession) {
        deliverLatest(sendingNow: false)
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    /// ペアの Watch を替えると止まる。次の Watch とつなぐため、動かし直す
    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}

/// WatchConnectivity が渡す返事の関数は Sendable と書かれていないが、どのスレッドから呼んでもよい
struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
