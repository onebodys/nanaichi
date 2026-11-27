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
    /// - `NANAICHI_WATCH_PHONE_CLOCK_BEHIND`: iPhone の記録先の時計を何秒遅らせるか。Watch で開始すると、その秒数だけ前に
    ///   始めたセッションになる（集中の 7 分を待たずに、切り替わりの振動を確かめる）
    final class StubPhoneLink: PhoneLink {
        private let backend: DeviceBackend
        private let reach: PhoneReach
        private let startsAfter: Duration?
        private let recordStore = RecordStoreTag("stub")

        init?(_ environment: [String: String], clock: @escaping @Sendable () -> Instant) {
            switch environment["NANAICHI_WATCH_PHONE"] {
            case "stub": reach = .reachable
            case "unreachable": reach = .unreachable
            default: return nil
            }
            let behindMs = environment["NANAICHI_WATCH_PHONE_CLOCK_BEHIND"].flatMap(Double.init).map { Int64($0 * 1000) } ?? 0
            backend = DeviceBackend(location: .inMemory, clock: { clock().adding(milliseconds: -behindMs) })
            startsAfter = environment["NANAICHI_WATCH_PHONE_STARTS_AFTER"].flatMap(Double.init).map { .seconds($0) }
        }

        func events() -> AsyncStream<PhoneLinkEvent> {
            let (stream, continuation) = AsyncStream<PhoneLinkEvent>.makeStream()
            Task { [backend, reach, startsAfter, recordStore] in
                // iPhone が前に置いていった最新のスナップショット
                continuation.yield(.message(await replyTo(.current, using: backend, recordStore: recordStore)))
                continuation.yield(.reach(reach))
                guard let startsAfter else { return }
                try? await Task.sleep(for: startsAfter)
                // iPhone の画面で開始すると、iPhone は替わったスナップショットを Watch に知らせる
                switch await backend.startSession(id: SessionEventId(UUID().uuidString.lowercased())!) {
                case .success(let snapshot):
                    let received = Received(snapshot: snapshot, offset: await backend.clockOffset())
                    continuation.yield(.message(.snapshot(PhoneSnapshot(received: received, recordStore: recordStore))))
                case .failure: break
                }
            }
            return stream
        }

        func ask(_ message: WatchMessage) async -> PhoneMessage? {
            switch reach {
            case .reachable: await replyTo(message, using: backend, recordStore: recordStore)
            case .unreachable: nil
            }
        }
    }
#endif
