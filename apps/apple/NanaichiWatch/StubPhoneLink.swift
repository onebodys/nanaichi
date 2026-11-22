#if DEBUG
    import Foundation
    import NanaichiDevice
    import NanaichiDomain
    import NanaichiPresentation
    import NanaichiWatchLink

    /// XCUITest のための、ペアの iPhone の代わり。デバッグのビルドにだけある。
    /// watchOS のシミュレーターの XCUITest は iPhone のアプリを一緒に動かせないので、iPhone が Watch の頼みを通すのと
    /// 同じ `replyTo` を、メモリに置いたこの端末の記録先（iPhone の記録先と同じ実装）につなぐ
    ///
    /// - `NANAICHI_WATCH_PHONE`: `stub` なら届く iPhone、`unreachable` なら、前に受け取ったスナップショットだけを
    ///   残して届かなくなった iPhone の代わりにする。なければ実際の iPhone につなぐ
    /// - `NANAICHI_WATCH_PHONE_STARTS_AFTER`: 起動してから何秒後に、iPhone の側でセッションを始めたことにするか。
    ///   iPhone で操作した結果が Watch に届くのを確かめる
    final class StubPhoneLink: PhoneLink {
        private let backend: DeviceBackend
        private let reach: PhoneReach
        private let startsAfter: Duration?

        init?(_ environment: [String: String], clock: @escaping @Sendable () -> Instant) {
            switch environment["NANAICHI_WATCH_PHONE"] {
            case "stub": reach = .reachable
            case "unreachable": reach = .unreachable
            default: return nil
            }
            backend = DeviceBackend(location: .inMemory, clock: clock)
            startsAfter = environment["NANAICHI_WATCH_PHONE_STARTS_AFTER"].flatMap(Double.init).map { .seconds($0) }
        }

        func events() -> AsyncStream<PhoneLinkEvent> {
            let (stream, continuation) = AsyncStream<PhoneLinkEvent>.makeStream()
            Task { [backend, reach, startsAfter] in
                // iPhone が前に置いていった最新のスナップショット
                continuation.yield(.message(await replyTo(.current, using: backend)))
                continuation.yield(.reach(reach))
                guard let startsAfter else { return }
                try? await Task.sleep(for: startsAfter)
                // iPhone の画面で開始すると、iPhone は替わったスナップショットを Watch に知らせる
                switch await backend.startSession(id: SessionEventId(UUID().uuidString.lowercased())!) {
                case .success(let snapshot):
                    continuation.yield(
                        .message(.snapshot(Received(snapshot: snapshot, offset: await backend.clockOffset()))))
                case .failure: break
                }
            }
            return stream
        }

        func ask(_ message: WatchMessage) async -> PhoneMessage? {
            switch reach {
            case .reachable: await replyTo(message, using: backend)
            case .unreachable: nil
            }
        }
    }
#endif
