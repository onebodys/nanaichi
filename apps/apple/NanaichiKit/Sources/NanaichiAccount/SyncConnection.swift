import NanaichiDomain

/// 同期の WebSocket で起きたこと。1つの接続では、開いた → テキスト… → 閉じた の順に届く。
/// 開けなかったときは、開いたを飛ばして閉じたが届く
public enum SyncSocketEvent: Hashable, Sendable {
    case opened
    case text(String)
    case closed
}

/// 開いた同期の WebSocket のうち、使うところだけ
public protocol SyncSocket: Sendable {
    func send(_ text: String)
    /// 閉じる。閉じる手続きの完了は待たない（切れた接続では返ってこないことがある）
    func close()
}

/// 同期の WebSocket を開き、起きたことを `onEvent` に順に渡す（1つ渡し終えてから次を渡す）。
/// アプリでは `WebSocketSyncSocket`、テストでは差し替える
public typealias OpenSyncSocket =
    @Sendable (_ onEvent: @escaping @Sendable (SyncSocketEvent) async -> Void) -> any SyncSocket

public protocol SyncTimer: Sendable {
    func cancel()
}

/// 繋ぎ直しと ping のタイマー。テストでは時計を進めて動かす
public protocol SyncScheduler: Sendable {
    func after(milliseconds: Int64, _ action: @escaping @Sendable () async -> Void) -> any SyncTimer
}

/// `Task.sleep` で待つタイマー
public struct SleepingSyncScheduler: SyncScheduler {
    public init() {}

    public func after(milliseconds: Int64, _ action: @escaping @Sendable () async -> Void) -> any SyncTimer {
        SleepingTimer(
            task: Task {
                try? await Task.sleep(for: .milliseconds(milliseconds))
                guard !Task.isCancelled else { return }
                await action()
            })
    }
}

private struct SleepingTimer: SyncTimer {
    let task: Task<Void, Never>
    func cancel() { task.cancel() }
}

/// 同期の WebSocket（`GET /api/ws`、ADR 0012）を張り続ける（TS の `connectSync`）。
///
/// - 繋がるたびに（初回も繋ぎ直しも）`connected` を届ける。切れている間の同期メッセージは届かないので、
///   画面はここで読み込み直す
/// - 届いた同期メッセージは検証してから届ける。合わないものは捨てる
/// - 切れたら、間隔を延ばしながら（最大30秒）繋ぎ直す
/// - スリープなどで切れたことに気づけない接続を見つけるため、一定間隔で `ping` を送り、
///   `pong` が返らなければ切って繋ぎ直す
actor SyncConnection {
    /// 最初の繋ぎ直しまでの間隔。失敗が続くたびに倍にする
    static let reconnectBaseMs: Int64 = 1000
    static let reconnectMaxMs: Int64 = 30_000
    /// `ping` を送る間隔
    static let pingIntervalMs: Int64 = 25_000
    /// `ping` を送ってから `pong` を待つ時間。過ぎたら切れているとみなす
    static let pongTimeoutMs: Int64 = 10_000

    private struct Socket {
        let id: Int
        let socket: any SyncSocket
    }

    private struct Scheduled {
        let id: Int
        let timer: any SyncTimer
    }

    /// 開いている接続の生存確認。次の `ping` と、送った `ping` の `pong` を待つ期限
    private struct Heartbeat {
        let nextPing: Scheduled
        let pongDeadline: Scheduled?

        func cancel() {
            nextPing.timer.cancel()
            pongDeadline?.timer.cancel()
        }
    }

    private enum Phase {
        case connecting(Socket)
        case open(Socket, Heartbeat)
        /// 繋ぎ直しを待っている
        case waiting(Scheduled)
        /// 閉じた（受け取るのをやめた）。もう繋がない
        case closed
    }

    private let openSocket: OpenSyncSocket
    private let scheduler: any SyncScheduler
    private let deliver: AsyncStream<SyncEvent>.Continuation
    private var phase: Phase = .closed
    /// 続けて失敗した回数。繋がったら 0 に戻す
    private var failures = 0
    /// 接続とタイマーを見分ける番号。捨てた接続や止めたタイマーから遅れて届いたものを無視する
    private var lastId = 0

    init(openSocket: @escaping OpenSyncSocket, scheduler: any SyncScheduler, deliver: AsyncStream<SyncEvent>.Continuation) {
        self.openSocket = openSocket
        self.scheduler = scheduler
        self.deliver = deliver
    }

    /// 繋ぎ始める。作った直後に1回だけ呼ぶ
    func start() { connect() }

    /// 今すぐ確かめる。繋ぎ直しを待っていれば待たずに繋ぎ、開いていれば `ping` を送る
    func check() {
        switch phase {
        case .waiting(let reconnect):
            reconnect.timer.cancel()
            failures = 0
            connect()
        case .open(let socket, let heartbeat):
            phase = .open(socket, ping(socket, heartbeat))
        case .connecting, .closed:
            return
        }
    }

    func close() {
        switch phase {
        case .waiting(let reconnect): reconnect.timer.cancel()
        case .connecting(let socket): socket.socket.close()
        case .open(let socket, let heartbeat):
            heartbeat.cancel()
            socket.socket.close()
        case .closed: break
        }
        phase = .closed
        deliver.finish()
    }

    private func nextId() -> Int {
        lastId += 1
        return lastId
    }

    private func connect() {
        let id = nextId()
        let socket = openSocket { [weak self] event in await self?.receive(event, from: id) }
        phase = .connecting(Socket(id: id, socket: socket))
    }

    private func schedule(after milliseconds: Int64) -> Scheduled {
        let id = nextId()
        return Scheduled(
            id: id, timer: scheduler.after(milliseconds: milliseconds) { [weak self] in await self?.fire(id) })
    }

    private func scheduleReconnect() {
        // 2 の 5 乗で上限の30秒を超えるので、それより先は数えない
        let delay = min(Self.reconnectBaseMs << min(failures, 5), Self.reconnectMaxMs)
        failures += 1
        phase = .waiting(schedule(after: delay))
    }

    /// `pong` を待っていなければ `ping` を送り、待つ期限を決める
    private func ping(_ socket: Socket, _ heartbeat: Heartbeat) -> Heartbeat {
        guard heartbeat.pongDeadline == nil else { return heartbeat }
        socket.socket.send("ping")
        return Heartbeat(nextPing: heartbeat.nextPing, pongDeadline: schedule(after: Self.pongTimeoutMs))
    }

    private func receive(_ event: SyncSocketEvent, from id: Int) {
        switch (phase, event) {
        case (.connecting(let socket), .opened) where socket.id == id:
            failures = 0
            phase = .open(socket, Heartbeat(nextPing: schedule(after: Self.pingIntervalMs), pongDeadline: nil))
            deliver.yield(.connected)
        case (.open(let socket, let heartbeat), .text("pong")) where socket.id == id:
            heartbeat.pongDeadline?.timer.cancel()
            phase = .open(socket, Heartbeat(nextPing: heartbeat.nextPing, pongDeadline: nil))
        case (.open(let socket, _), .text(let text)) where socket.id == id:
            if let message = SyncMessage.deserialize(text) { deliver.yield(.message(message)) }
        case (.connecting(let socket), .closed) where socket.id == id:
            scheduleReconnect()
        case (.open(let socket, let heartbeat), .closed) where socket.id == id:
            heartbeat.cancel()
            scheduleReconnect()
        case (.connecting, _), (.open, _), (.waiting, _), (.closed, _):
            // 捨てた接続から遅れて届いたもの、開く前のテキスト、開いたあとの2回目の「開いた」
            return
        }
    }

    private func fire(_ id: Int) {
        switch phase {
        case .waiting(let reconnect) where reconnect.id == id:
            connect()
        case .open(let socket, let heartbeat) where heartbeat.nextPing.id == id:
            let pinged = ping(socket, heartbeat)
            phase = .open(
                socket, Heartbeat(nextPing: schedule(after: Self.pingIntervalMs), pongDeadline: pinged.pongDeadline))
        case .open(let socket, let heartbeat) where heartbeat.pongDeadline?.id == id:
            heartbeat.cancel()
            socket.socket.close()
            scheduleReconnect()
        case .connecting, .open, .waiting, .closed:
            // 止めたタイマーが、止める前に動き始めていた
            return
        }
    }
}
