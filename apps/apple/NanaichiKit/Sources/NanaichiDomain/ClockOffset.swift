/// 時計のずれ（GLOSSARY の「時計のずれ」）。サーバーの時刻 − 端末の時刻（ミリ秒）。
///
/// 操作イベントの時刻はサーバーが受け付けた時刻で記録する（ADR 0007）ので、画面は端末の時刻に
/// このずれを足してサーバーの時刻を見積もり、タイマーの状態の計算に渡す（ADR 0003）。
///
/// 往復の中間をとるので 0.5 ミリ秒の端数が出る。TS と同じ値になるよう `Double` で持つ
public struct ClockOffset: Hashable, Sendable, Codable {
    public let serverAheadMs: Double

    public init(serverAheadMs: Double) {
        self.serverAheadMs = serverAheadMs
    }

    /// スナップショットを取りに行った1回のやり取り。`serverTime` のほかは端末の時計で読んだ時刻
    public struct RoundTrip: Hashable, Sendable {
        public let requestedAt: Instant
        public let receivedAt: Instant
        public let serverTime: Instant

        public init(requestedAt: Instant, receivedAt: Instant, serverTime: Instant) {
            self.requestedAt = requestedAt
            self.receivedAt = receivedAt
            self.serverTime = serverTime
        }
    }

    /// 1回のやり取りからずれを測る。サーバーが時刻を読んだのは、送ってから受け取るまでの
    /// ちょうど中間だったとみなす（通信の行きと帰りにかかる時間は同じくらいと仮定する）
    public static func measure(_ roundTrip: RoundTrip) -> ClockOffset {
        let midpoint =
            Double(roundTrip.requestedAt.milliseconds + roundTrip.receivedAt.milliseconds) / 2
        return ClockOffset(serverAheadMs: Double(roundTrip.serverTime.milliseconds) - midpoint)
    }

    /// 端末の時刻 `deviceNow` のときの、サーバーの時刻の見積もり。
    ///
    /// 見積もりの誤差で、スナップショットのサーバー時刻（記録済みのどの操作イベントよりも後）より
    /// 前に戻らないようにする。戻ると、直前に記録した操作がまだ起きていないものとして計算されてしまう。
    /// 端数は TS の `new Date(ms)` と同じく 0 の側に切り捨てる
    public func serverNow(deviceNow: Instant, snapshotServerTime: Instant) -> Instant {
        let estimate = Int64((Double(deviceNow.milliseconds) + serverAheadMs).rounded(.towardZero))
        return Instant(milliseconds: max(snapshotServerTime.milliseconds, estimate))
    }
}
