import Foundation

/// `URLSessionWebSocketTask` で開く同期の WebSocket。ブラウザと違い `Authorization: Bearer` を付けて繋ぐ（ADR 0029）。
///
/// URLSession の delegate と受信のループから届くものを1本のストリームに並べ、そこから順に `onEvent` へ渡す
public final class WebSocketSyncSocket: SyncSocket {
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    public static func opener(server: URL, token: SessionToken) -> OpenSyncSocket {
        let url = AccountServer.syncURL(server)
        return { onEvent in WebSocketSyncSocket(url: url, token: token, onEvent: onEvent) }
    }

    init(url: URL, token: SessionToken, onEvent: @escaping @Sendable (SyncSocketEvent) async -> Void) {
        let (events, continuation) = AsyncStream<SyncSocketEvent>.makeStream()
        // 接続ごとに URLSession を作り、delegate で開いた・閉じたを受け取る。閉じるときに invalidate する
        session = URLSession(configuration: .ephemeral, delegate: Delegate(continuation), delegateQueue: nil)
        var request = URLRequest(url: url)
        request.setValue(token.authorization, forHTTPHeaderField: "Authorization")
        task = session.webSocketTask(with: request)
        Task {
            for await event in events {
                await onEvent(event)
            }
        }
        task.resume()
    }

    public func send(_ text: String) {
        // 送れなかったときは、受信のループが切れたことに気づいて閉じたを届ける
        task.send(.string(text)) { _ in }
    }

    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
        session.finishTasksAndInvalidate()
    }

    private final class Delegate: NSObject, URLSessionWebSocketDelegate {
        private let events: AsyncStream<SyncSocketEvent>.Continuation

        init(_ events: AsyncStream<SyncSocketEvent>.Continuation) {
            self.events = events
        }

        /// 閉じたを届けて終える。終えたあとの yield は捨てられる。受信のループと delegate から同時に届いて
        /// 2回になっても、`SyncConnection` は繋ぎ直しを待っている間の閉じたを捨てる
        private func end(_ session: URLSession) {
            events.yield(.closed)
            events.finish()
            // 自分で切れた接続でも URLSession と delegate を手放す
            session.finishTasksAndInvalidate()
        }

        func urlSession(
            _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol _: String?
        ) {
            events.yield(.opened)
            Task {
                while true {
                    let message: URLSessionWebSocketTask.Message
                    do {
                        message = try await webSocketTask.receive()
                    } catch {
                        break
                    }
                    switch message {
                    case .string(let text): events.yield(.text(text))
                    // サーバーはテキストしか送らない
                    case .data: continue
                    @unknown default: continue
                    }
                }
                end(session)
            }
        }

        func urlSession(
            _ session: URLSession, webSocketTask _: URLSessionWebSocketTask,
            didCloseWith _: URLSessionWebSocketTask.CloseCode, reason _: Data?
        ) {
            end(session)
        }

        func urlSession(_ session: URLSession, task _: URLSessionTask, didCompleteWithError _: (any Error)?) {
            end(session)
        }
    }
}
