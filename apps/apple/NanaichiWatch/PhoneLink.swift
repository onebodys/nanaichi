import NanaichiPresentation
import NanaichiWatchLink
import WatchConnectivity

/// Watch に届く、iPhone とのつながりの変化
enum PhoneLinkEvent: Sendable {
    /// iPhone に届くかが変わった
    case reach(PhoneReach)
    /// iPhone から知らせが届いた（iPhone の側でスナップショットが替わった）
    case message(PhoneMessage)
}

/// Watch から見た iPhone（ADR 0031）。Watch は記録先を持たず、操作はこれで iPhone に頼む
protocol PhoneLink: Sendable {
    /// iPhone とのつながりの変化を受け取り始める。受け取る側は1つだけ
    func events() -> AsyncStream<PhoneLinkEvent>
    /// iPhone に頼んで答えを待つ。iPhone に届かなかった・答えが返らなかったら nil
    func ask(_ message: WatchMessage) async -> PhoneMessage?
}

/// WatchConnectivity でペアの iPhone につなぐ
final class WatchConnectivityPhoneLink: NSObject, PhoneLink, WCSessionDelegate, @unchecked Sendable {
    // WCSession はどのスレッドから呼んでもよい。`continuation` は `events()` で1回だけ決める
    private let session = WCSession.default
    private var continuation: AsyncStream<PhoneLinkEvent>.Continuation?

    func events() -> AsyncStream<PhoneLinkEvent> {
        let (stream, continuation) = AsyncStream<PhoneLinkEvent>.makeStream()
        self.continuation = continuation
        session.delegate = self
        session.activate()
        return stream
    }

    func ask(_ message: WatchMessage) async -> PhoneMessage? {
        guard session.activationState == .activated, session.isReachable else { return nil }
        let data = WatchLinkCoding.encode(message)
        return await withCheckedContinuation { (answer: CheckedContinuation<PhoneMessage?, Never>) in
            session.sendMessageData(
                data,
                replyHandler: { answer.resume(returning: WatchLinkCoding.decode(PhoneMessage.self, from: $0)) },
                errorHandler: { _ in answer.resume(returning: nil) })
        }
    }

    private func yieldReach(_ session: WCSession) {
        let reachable = session.activationState == .activated && session.isReachable
        continuation?.yield(.reach(reachable ? .reachable : .unreachable))
    }

    private func yieldLatest(_ context: [String: Any]) {
        guard let data = context[WatchLinkCoding.latestKey] as? Data,
            let message = WatchLinkCoding.decode(PhoneMessage.self, from: data)
        else { return }
        continuation?.yield(.message(message))
    }

    // MARK: - WCSessionDelegate

    /// 動き始めたら、iPhone が前に置いていった最新のスナップショットから出す
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?)
    {
        yieldLatest(session.receivedApplicationContext)
        yieldReach(session)
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        yieldReach(session)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        yieldLatest(applicationContext)
    }

    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        guard let message = WatchLinkCoding.decode(PhoneMessage.self, from: messageData) else { return }
        continuation?.yield(.message(message))
    }
}
