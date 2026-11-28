import Foundation
import NanaichiDomain
import NanaichiPresentation

// Watch と iPhone のあいだを WatchConnectivity で行き来するもの（ADR 0031）。
//
// Watch は記録先を持たない。操作は iPhone に頼み、iPhone が自分の記録先（ログインしていなければこの端末、
// していればアカウント）のワークフローに通して、返ってきたスナップショットを Watch に返す。
// iPhone の側の変化（iPhone・Mac・Web での操作）も、スナップショットにして Watch に送る。
// Watch はスナップショットからドメインの関数でタイマーの状態を計算して出す（ADR 0003）。
//
// 頼みごとを足すとき（音声入力の録音、#74）は、`WatchMessage` と `PhoneMessage` に種類を足す。
// 録音のファイルは WatchConnectivity のファイルの転送で送り、添える情報をここの型で書く

/// Watch から iPhone への頼み。iPhone は `PhoneMessage` で答える。
///
/// 記録を変える頼み（開始と操作）には、Watch が画面に出している記録先の印（とセッション）を添える。
/// Watch の画面が古いうちに押されたもの（iPhone が記録先を替えた・ほかの端末で次のセッションを始めた）を、
/// iPhone のいまの記録先やセッションに通さないため。食い違えば断り、Watch は今の様子を頼み直す
public enum WatchMessage: Hashable, Sendable, Codable {
    /// iPhone の今のスナップショットをもらう。Watch が iPhone に届くようになったときに頼む
    case current
    /// セッションを開始する。`id` は開始の操作イベントの ID で、Watch が発行する。
    /// 届いたか確かめられずに頼み直すときも同じ ID で送れば、二重に開始しない（ADR 0007）
    case start(id: SessionEventId, recordStore: RecordStoreTag)
    /// セッション中の操作（一時停止・再開・中断・終了）。`id` はその操作イベントの ID、`session` は Watch が画面に出している
    /// セッション。どの操作を Watch に出すかは Watch の画面が決め（`WatchFace`）、できるかどうかは iPhone の記録先が決める
    case operate(id: SessionEventId, kind: SessionOperationKind, session: SessionId, recordStore: RecordStoreTag)
    /// Watch が振動で知らせる範囲が替わった（Issue #73）。iPhone はその範囲の切り替わりを通知しない。
    /// iPhone は通知の予約を入れ替えてから `accepted` で答え、Watch は答えを受け取ってから振動で知らせ始める
    case vibration(ToldWatchVibration)
}

/// Watch が iPhone に頼んで記録を変えること
public enum WatchCommand: Hashable, Sendable {
    case start
    case operate(SessionOperationKind)
}

/// Watch が iPhone に送った、記録を変える頼みと、そのとき Watch が見ていた記録
public struct WatchRequest: Hashable, Sendable {
    public let message: WatchMessage
    let command: WatchCommand
    /// 見ていた記録先と変更の番号。同じなら同じ記録を見ている（ADR 0030）
    let basis: Basis

    struct Basis: Hashable, Sendable {
        let recordStore: RecordStoreTag
        let revision: Revision
    }

    /// 画面に出している `shown` を見て `command` を頼むときの頼み。セッションがないのに操作を頼むなら nil。
    ///
    /// `unanswered`（前に送って答えが返らなかった頼み）が、同じ記録を見た同じ頼みなら、そのまま送り直す。
    /// 答えが返らなくても記録先には届いていることがあり、同じ操作イベントの ID なら二重に記録しない（ADR 0007）。
    /// 届いていれば、Watch が今の様子を頼み直したときに記録が進み、次の頼みは新しい ID になる
    public static func of(
        _ command: WatchCommand, shown: PhoneSnapshot, unanswered: WatchRequest?,
        newEventId: () -> SessionEventId
    ) -> WatchRequest? {
        let basis = Basis(recordStore: shown.recordStore, revision: shown.received.snapshot.revision)
        if let unanswered, unanswered.command == command, unanswered.basis == basis { return unanswered }
        let message: WatchMessage
        switch (command, shown.received.snapshot) {
        case (.start, _):
            message = .start(id: newEventId(), recordStore: shown.recordStore)
        case (.operate(let kind), .session(_, _, let session, _)):
            message = .operate(id: newEventId(), kind: kind, session: session.id, recordStore: shown.recordStore)
        case (.operate, .noSession):
            return nil
        }
        return WatchRequest(message: message, command: command, basis: basis)
    }
}

/// Watch が画面に出している記録が、iPhone のいまの記録先やセッションと食い違っていたときの文言
public let watchOutdatedMessage = "Watch の表示が古くなっていました。最新の状態を読み込み直しました。"

/// iPhone から Watch に届くもの。頼みへの答えと、iPhone の側で変わったときの知らせに使う
public enum PhoneMessage: Hashable, Sendable, Codable {
    case snapshot(PhoneSnapshot)
    /// 頼んだ操作を記録先が断った・記録先に届かなかった。`message` は Watch にそのまま出す文言。
    /// 断られたときは iPhone の様子が Watch の思っているものと違うかもしれないので、Watch は今の様子を頼み直す
    case refused(message: String)
    /// 頼みを受け取った。記録先に通さない頼み（`vibration`）への答え
    case accepted
}

/// Watch が伝えた振動で知らせる範囲と、伝えた順の番号。iPhone はこれを覚えておく（ADR 0033）。
///
/// Watch は範囲を閉じる（`off`）ときは急ぐので、伸ばす頼みの答えを待たずに送る。WatchConnectivity は送った順に届くとは限らないので、
/// iPhone は番号で新旧を決め、先に伝えた範囲が後から届いても、閉じたままにする。
/// 番号は Watch が伝えるたびに増やし、Watch に残しておく（アプリを起動し直しても戻らない）。記録先の時刻の見積もりは、
/// 時計のずれを測り直したり記録先を替えたりすると戻ることがあるので、新旧には使わない
public struct ToldWatchVibration: Hashable, Sendable, Codable {
    public let vibration: WatchVibration
    public let sequence: Int64

    public init(vibration: WatchVibration, sequence: Int64) {
        self.vibration = vibration
        self.sequence = sequence
    }

    /// まだ何も伝えられていない
    public static let none = ToldWatchVibration(vibration: .off, sequence: 0)

    /// 届いた `arrived` を反映した結果。いま覚えているものより前に伝えたもの（遅れて届いた）なら nil。
    /// 同じ番号は同じ頼み（届いたか確かめられずに送り直した）なので、いま覚えているままにする
    public func applying(_ arrived: ToldWatchVibration) -> ToldWatchVibration? {
        if arrived.sequence < sequence { return nil }
        return arrived.sequence == sequence ? self : arrived
    }
}

/// Watch が次に伝える番号。前に伝えた番号 `last` より大きく、Watch の時計のミリ秒 `deviceNow` を下回らない。
/// 時計を使うのは、Watch のアプリを入れ直して `last` が消えても、前より大きい番号から始めるため
public func nextWatchVibrationSequence(after last: Int64, deviceNow: Instant) -> Int64 {
    max(deviceNow.milliseconds, last + 1)
}

/// どの記録先のスナップショットか。iPhone がログイン・ログアウトで記録先を替えるたびに、新しいものを発行する。
/// 変更の番号（`Revision`）は記録先ごとに数えるので、記録先が違うスナップショットどうしは新旧を比べられない
public struct RecordStoreTag: Hashable, Sendable, Codable {
    public let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }
}

/// iPhone の記録先のスナップショットと、iPhone が記録先と測った時計のずれ（`received`）、どの記録先のものか。
/// Watch の時計は iPhone と揃っているとみなし、Watch の時刻にこのずれを足して記録先の時刻を見積もる
public struct PhoneSnapshot: Hashable, Sendable, Codable {
    public let received: Received
    public let recordStore: RecordStoreTag

    public init(received: Received, recordStore: RecordStoreTag) {
        self.received = received
        self.recordStore = recordStore
    }
}

/// Watch（と、Watch に置いておく最新を決める iPhone）が持つ、iPhone から届いたスナップショット
public enum PhoneSnapshotLoading: Hashable, Sendable {
    /// まだ届いていない
    case waiting
    case loaded(PhoneSnapshot)

    /// 届いたスナップショットを反映する。同じ記録先で手元より古いものは捨てる（ADR 0012）。
    /// iPhone が記録先を替えたあとのものは、変更の番号を比べずに置き換える
    public func applying(_ arrived: PhoneSnapshot) -> PhoneSnapshotLoading {
        switch self {
        case .loaded(let current)
        where current.recordStore == arrived.recordStore
            && arrived.received.snapshot.isOlder(than: current.received.snapshot):
            self
        case .waiting, .loaded: .loaded(arrived)
        }
    }

    /// タイマーの様子を計算するための読み込みの状態
    public var timer: TimerLoading {
        switch self {
        case .waiting: .loading
        case .loaded(let snapshot): .loaded(snapshot.received)
        }
    }
}

/// iPhone が Watch の頼み `message` を、いまの記録先 `backend`（その印が `recordStore`）に通して答える。
/// 開始と操作は、Watch が見ていた記録先とセッションが、いまのものと同じときだけ通す。
/// 振動で知らせる範囲（`vibration`）は記録先に通さず、受け取ったとだけ答える。範囲を覚えて通知を予約し直すのは呼ぶ側
public func replyTo(_ message: WatchMessage, using backend: any Backend, recordStore: RecordStoreTag) async
    -> PhoneMessage
{
    let result: Result<SessionSnapshot, BackendError>
    switch message {
    case .current: result = await backend.getCurrentSession()
    case .start(let id, let shownStore):
        guard shownStore == recordStore else { return .refused(message: watchOutdatedMessage) }
        result = await backend.startSession(id: id)
    case .operate(let id, let kind, let shownSession, let shownStore):
        guard shownStore == recordStore else { return .refused(message: watchOutdatedMessage) }
        // 記録先はセッションを指定して操作できないので、いまのセッションを読んで確かめてから通す。
        // いまのセッションがない（終わった）ときは通す。同じ ID の頼み直しなら記録先が前の答えを返し、そうでなければ断る
        switch await backend.getCurrentSession() {
        case .success(.session(_, _, let current, _)) where current.id != shownSession:
            return .refused(message: watchOutdatedMessage)
        case .success(.session), .success(.noSession):
            result = await backend.operateSession(id: id, kind: kind)
        case .failure(let error):
            result = .failure(error)
        }
    case .vibration: return .accepted
    }
    switch result {
    case .success(let snapshot):
        let received = Received(snapshot: snapshot, offset: await backend.clockOffset())
        return .snapshot(PhoneSnapshot(received: received, recordStore: recordStore))
    case .failure(let error):
        return .refused(message: operationErrorMessageOf(error))
    }
}

/// iPhone が、振動で知らせる範囲のほかの Watch の頼み `message` を、いまの記録先に通して答える。
///
/// - `recordStore` はいまの記録先とその印。ログイン・ログアウトで替わるので、頼みが届くたびに読む。答えを待つあいだや画面に渡す
///   あいだに替わったら、前の記録先の答えは返さず、替わった先の今の様子を返す（Watch が、もう使っていない記録先の様子を出し続けない
///   ように）。開始と操作はやり直さない
/// - 答えのスナップショットは、Watch に答える前に `answered` に渡し、終わるまで待つ。iPhone はそこで画面と通知の予約に
///   反映する。Watch の頼みで裏で起こされたアプリは答えたあとすぐ止められることがあり、アカウントの記録先の同期の接続も
///   裏では切れていることがあるので、同期メッセージを待たない
@MainActor
public func answerWatch(
    _ message: WatchMessage, recordStore: () -> (any Backend, RecordStoreTag),
    answered: (PhoneSnapshot) async -> Void
) async -> PhoneMessage {
    var (backend, tag) = recordStore()
    var answer = await replyTo(message, using: backend, recordStore: tag)
    var handedOver = false
    // 取り直すあいだや画面に渡すあいだにまた替わることもあるので、替わらなくなるまで取り直す
    while true {
        let (current, currentTag) = recordStore()
        if currentTag != tag {
            (backend, tag) = (current, currentTag)
            answer = await replyTo(.current, using: backend, recordStore: tag)
            handedOver = false
        } else if !handedOver, case .snapshot(let snapshot) = answer {
            await answered(snapshot)
            handedOver = true
        } else {
            return answer
        }
    }
}

/// WatchConnectivity で送るデータにする・データから戻す。両方のアプリは一緒に入れ替わるので、版をまたいだ形は考えない
public enum WatchLinkCoding {
    /// iPhone が Watch に置いておく最新のスナップショット（application context）のキー。
    /// Watch が届かないあいだに変わっても、届くようになったときにいちばん新しいものだけが届く
    public static let latestKey = "latest"

    public static func encode(_ value: some Encodable) -> Data {
        // 送るのはこのファイルの型と、JSON にできるドメインの型だけなので、失敗するのは実装の誤り
        do { return try JSONEncoder().encode(value) } catch { preconditionFailure("Watch に送る形にできない: \(error)") }
    }

    /// 読めなければ nil。相手のアプリが別の版で、知らない種類だったとき
    public static func decode<Value: Decodable>(_ type: Value.Type, from data: Data) -> Value? {
        try? JSONDecoder().decode(type, from: data)
    }
}
