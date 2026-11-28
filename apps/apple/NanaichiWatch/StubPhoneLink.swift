#if DEBUG
    import Foundation
    import NanaichiDevice
    import NanaichiDomain
    import NanaichiPresentation
    import NanaichiWatchLink
    import Synchronization

    /// XCUITest のための、ペアの iPhone の代わり。デバッグのビルドにだけある。
    /// watchOS のシミュレーターの XCUITest は iPhone のアプリを一緒に動かせないので、iPhone が Watch の頼みを通すのと
    /// 同じ `replyTo` を、メモリに置いたこの端末の記録先（iPhone の記録先と同じ実装）につなぐ
    ///
    /// - `NANAICHI_WATCH_PHONE`: `stub` なら届く iPhone、`unreachable` なら、前に受け取ったスナップショットだけを
    ///   残して届かなくなった iPhone の代わりにする。なければ実際の iPhone につなぐ
    /// - `NANAICHI_WATCH_PHONE_STARTS_AFTER`: 起動してから何秒後に、iPhone の側でセッションを始めたことにするか。
    ///   iPhone で操作した結果が Watch に届くのを確かめる
    /// - `NANAICHI_WATCH_PHONE_STARTED_AGO`: Watch で開始したセッションを、何秒前に始めたことにするか。そのあとの操作は今の時刻で
    ///   記録する（集中の 7 分を待たずに、切り替わりの振動や、ジャーナル・休憩の画面を確かめる）
    /// - `NANAICHI_MANUAL_ADVANCE`: 手動にするフェーズの切り替わり（iPhone のアプリと同じ）。切り替え待ちの画面を確かめる
    /// - `NANAICHI_WATCH_PHONE_LOSES_ANSWERS`: はじめの何回の開始・操作の頼みを、記録先には通したうえで答えを返さないか。
    ///   答えだけが返らなかったときに、Watch が今の様子を頼み直して確かめるのを見る
    final class StubPhoneLink: PhoneLink {
        private let backend: DeviceBackend
        private let reach: PhoneReach
        private let startsAfter: Duration?
        private let recordStore = RecordStoreTag("stub")
        private let startedAgo: StartedAgoClock
        private let manualAdvance: Set<PhaseTransition>
        private let answersToLose: Mutex<Int>

        init?(_ environment: [String: String], clock: @escaping @Sendable () -> Instant) {
            switch environment["NANAICHI_WATCH_PHONE"] {
            case "stub": reach = .reachable
            case "unreachable": reach = .unreachable
            default: return nil
            }
            let startedAgo = StartedAgoClock(
                behindMs: environment["NANAICHI_WATCH_PHONE_STARTED_AGO"].flatMap(Double.init).map { Int64($0 * 1000) } ?? 0,
                clock: clock)
            backend = DeviceBackend(location: .inMemory, clock: { startedAgo.read() })
            self.startedAgo = startedAgo
            startsAfter = environment["NANAICHI_WATCH_PHONE_STARTS_AFTER"].flatMap(Double.init).map { .seconds($0) }
            manualAdvance = Set(
                (environment["NANAICHI_MANUAL_ADVANCE"] ?? "").split(separator: ",")
                    .compactMap { PhaseTransition(rawValue: String($0)) })
            answersToLose = Mutex(environment["NANAICHI_WATCH_PHONE_LOSES_ANSWERS"].flatMap(Int.init) ?? 0)
        }

        func events() -> AsyncStream<PhoneLinkEvent> {
            let (stream, continuation) = AsyncStream<PhoneLinkEvent>.makeStream()
            Task { [backend, reach, startsAfter, recordStore, startedAgo, manualAdvance] in
                if !manualAdvance.isEmpty {
                    var mode = AdvanceMode.allAuto
                    for transition in manualAdvance { mode[transition] = .manual }
                    _ = await backend.changeAdvanceMode(mode)
                }
                // iPhone が前に置いていった最新のスナップショット
                continuation.yield(.message(await replyTo(.current, using: backend, recordStore: recordStore)))
                continuation.yield(.reach(reach))
                guard let startsAfter else { return }
                try? await Task.sleep(for: startsAfter)
                // iPhone の画面で開始すると、iPhone は替わったスナップショットを Watch に知らせる
                let started = await backend.startSession(id: SessionEventId(UUID().uuidString.lowercased())!)
                startedAgo.started()
                switch started {
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
            case .reachable:
                let answer = await replyTo(message, using: backend, recordStore: recordStore)
                switch message {
                case .start:
                    startedAgo.started()
                    return losesAnswer() ? nil : answer
                case .operate: return losesAnswer() ? nil : answer
                case .current, .vibration: return answer
                }
            case .unreachable: return nil
            }
        }
    }

    extension StubPhoneLink {
        /// 答えを返さない頼みが残っていれば、1つ使って true
        private func losesAnswer() -> Bool {
            answersToLose.withLock { left in
                guard left > 0 else { return false }
                left -= 1
                return true
            }
        }
    }

    /// 代わりの iPhone の記録先の時計。開始を記録するまでは `behindMs` だけ遅れ、開始したら今の時刻に戻る
    private final class StartedAgoClock: Sendable {
        private let behindMs: Mutex<Int64>
        private let clock: @Sendable () -> Instant

        init(behindMs: Int64, clock: @escaping @Sendable () -> Instant) {
            self.behindMs = Mutex(behindMs)
            self.clock = clock
        }

        func read() -> Instant { clock().adding(milliseconds: -behindMs.withLock { $0 }) }

        func started() { behindMs.withLock { $0 = 0 } }
    }
#endif
