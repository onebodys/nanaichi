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

/// Watch から iPhone への頼み。iPhone は `PhoneMessage` で答える
public enum WatchMessage: Hashable, Sendable, Codable {
    /// iPhone の今のスナップショットをもらう。Watch が iPhone に届くようになったときに頼む
    case current
    /// セッションを開始する。`id` は開始の操作イベントの ID で、Watch が発行する。
    /// 届いたか確かめられずに頼み直すときも同じ ID で送れば、二重に開始しない（ADR 0007）
    case start(id: SessionEventId)
    /// 集中を中断する。`id` は中断の操作イベントの ID
    case abort(id: SessionEventId)
    /// Watch が振動で知らせる範囲が替わった（Issue #73）。iPhone はその範囲の切り替わりを通知しない。
    /// iPhone は通知の予約を入れ替えてから `accepted` で答え、Watch は答えを受け取ってから振動で知らせ始める
    case vibration(ToldWatchVibration)
}

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
/// 振動で知らせる範囲（`vibration`）は記録先に通さず、受け取ったとだけ答える。範囲を覚えて通知を予約し直すのは呼ぶ側
public func replyTo(_ message: WatchMessage, using backend: any Backend, recordStore: RecordStoreTag) async
    -> PhoneMessage
{
    let result: Result<SessionSnapshot, BackendError>
    switch message {
    case .current: result = await backend.getCurrentSession()
    case .start(let id): result = await backend.startSession(id: id)
    case .abort(let id): result = await backend.operateSession(id: id, kind: .abort)
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
