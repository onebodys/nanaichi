import NanaichiDomain
import NanaichiPresentation
import NanaichiWatchLink
import WatchConnectivity

/// Watch とのつなぎ（ADR 0031）。記録を書くのは iPhone だけなので、Watch の頼みはいまの記録先に通して答え、
/// 手元のスナップショットが替わったら Watch に知らせる。
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

    /// Watch とつなぎ始める。`recordStore` はいまの記録先とその印で、ログイン・ログアウトで替わるので、頼みが届くたびに読む
    func activate(recordStore: @escaping @MainActor () -> (any Backend, RecordStoreTag)) {
        self.recordStore = recordStore
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
        let (backend, tag) = recordStore()
        let answer = await replyTo(message, using: backend, recordStore: tag)
        let (currentBackend, currentTag) = recordStore()
        guard currentTag != tag else { return answer }
        return await replyTo(.current, using: currentBackend, recordStore: currentTag)
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
            case .refused: break
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

/// WatchConnectivity が渡す返事の関数は Sendable と書かれていないが、どのスレッドから呼んでもよい
struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
