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
/// 記録を変える頼み（開始と操作）には、Watch が画面に出している記録先（とセッション）を添える。
/// Watch の画面が古いうちに押されたもの（iPhone が記録先を替えた・ほかの端末で次のセッションを始めた）を、
/// iPhone のいまの記録先やセッションに通さないため。食い違えば断り、Watch は今の様子を頼み直す
public enum WatchMessage: Hashable, Sendable, Codable {
    /// iPhone の今のスナップショットをもらう。Watch が iPhone に届くようになったときに頼む
    case current
    /// セッションを開始する。`id` は開始の操作イベントの ID で、Watch が発行する。
    /// 届いたか確かめられずに頼み直すときも同じ ID で送れば、二重に開始しない（ADR 0007）
    case start(id: SessionEventId, recordStore: RecordStoreId)
    /// セッション中の操作（一時停止・再開・中断・終了）。`id` はその操作イベントの ID、`session` は Watch が画面に出している
    /// セッション。どの操作を Watch に出すかは Watch の画面が決め（`WatchFace`）、できるかどうかは iPhone の記録先が決める
    case operate(id: SessionEventId, kind: SessionOperationKind, session: SessionId, recordStore: RecordStoreId)
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
        let recordStore: RecordStoreId
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
        let basis = Basis(recordStore: shown.recordStore.store, revision: shown.received.snapshot.revision)
        if let unanswered, unanswered.command == command, unanswered.basis == basis { return unanswered }
        let message: WatchMessage
        switch (command, shown.received.snapshot) {
        case (.start, _):
            message = .start(id: newEventId(), recordStore: shown.recordStore.store)
        case (.operate(let kind), .session(_, _, let session, _)):
            message = .operate(
                id: newEventId(), kind: kind, session: session.id, recordStore: shown.recordStore.store)
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

/// どの記録先のスナップショットか（`store`）と、iPhone がその記録先をいつ開いたか（`generation`）
public struct RecordStoreTag: Hashable, Sendable, Codable {
    public let store: RecordStoreId
    public let generation: RecordStoreGeneration

    public init(store: RecordStoreId, generation: RecordStoreGeneration) {
        self.store = store
        self.generation = generation
    }
}

/// どの記録先か（`RecordStoreIds`）。変更の番号（`Revision`）は記録先ごとに数えるので、
/// 記録先が違うスナップショットどうしは変更の番号で新旧を比べられない
public struct RecordStoreId: Hashable, Sendable, Codable {
    public let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }
}

/// iPhone が記録先を開いた順。`launch` は iPhone のアプリの起動ごとの印、`opened` はその起動の中で記録先を開くたびに増える番号
public struct RecordStoreGeneration: Hashable, Sendable, Codable {
    public let launch: String
    public let opened: Int

    public init(launch: String, opened: Int) {
        self.launch = launch
        self.opened = opened
    }

    /// `other` より前に開いたか。起動が違えば順を比べられないので false
    func precedes(_ other: RecordStoreGeneration) -> Bool {
        launch == other.launch && opened < other.opened
    }
}

/// iPhone が記録先ごとに残しておく、Watch に送る記録先の ID（ADR 0031）。
///
/// iPhone のアプリは裏で終了させられ、Watch の頼みで起こされることがある。ID を起動のたびに作り直すと、Watch が持っている
/// 前の ID と食い違い、起こした頼みが「表示が古い」と断られる。そのため同じ記録先を開き直すときは前の ID を使う。
/// この端末の記録先は、記録が続く限り同じ ID にする。アカウントの記録先は、ログインするたびに新しい ID にする（前と別のアカウントの
/// ことがあり、変更の番号を比べられない）。起動したときに残っていたログインを開き直すときは、前の ID を使う
public struct RecordStoreIds: Hashable, Sendable, Codable {
    public private(set) var device: RecordStoreId
    public private(set) var account: RecordStoreId?

    /// どの記録先を、どう開くか
    public enum Opening: Sendable {
        /// この端末の記録先（起動したとき・ログアウトしたとき・ログインが切れたとき）
        case device
        /// 起動したときに残っていたログインのアカウントの記録先
        case restoredAccount
        /// ログインしたアカウントの記録先
        case signedInAccount
    }

    /// 何も残っていない（初めて起動した・記録を消した）。この端末の記録先の ID を新しく作る
    public init(newId: () -> RecordStoreId) {
        device = newId()
        account = nil
    }

    /// `opening` を開くときの ID。要るときだけ新しく作って覚える
    public mutating func id(opening: Opening, newId: () -> RecordStoreId) -> RecordStoreId {
        switch (opening, account) {
        case (.device, _): return device
        case (.restoredAccount, let restored?): return restored
        case (.restoredAccount, nil), (.signedInAccount, _):
            let id = newId()
            account = id
            return id
        }
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

    /// `current` より古いか。同じ記録先なら変更の番号で比べる（ADR 0012）。記録先が違えば、iPhone が同じ起動の中で
    /// 前に開いていた記録先のものが古い（答えが iPhone を出たあとに、iPhone がログイン・ログアウトした）。
    /// 起動が違えば比べられないので、古いとはしない
    func isOlder(than current: PhoneSnapshot) -> Bool {
        if recordStore.store == current.recordStore.store {
            return received.snapshot.isOlder(than: current.received.snapshot)
        }
        return recordStore.generation.precedes(current.recordStore.generation)
    }

    /// `other` と同じ記録先で、`other` のほうが同じ起動の中で後に開いたものなら、その印に替えたもの。
    /// 同じ記録先のスナップショットのどちらを残しても、手元の開いた順を戻さない（戻すと、そのあと遅れて届いた
    /// 前の記録先のスナップショットを古いと決められない）
    func keepingLaterOpening(of other: PhoneSnapshot) -> PhoneSnapshot {
        guard recordStore.store == other.recordStore.store,
            recordStore.generation.precedes(other.recordStore.generation)
        else { return self }
        return PhoneSnapshot(received: received, recordStore: other.recordStore)
    }
}

/// Watch（と、Watch に置いておく最新を決める iPhone）が持つ、iPhone から届いたスナップショット
public enum PhoneSnapshotLoading: Hashable, Sendable {
    /// まだ届いていない
    case waiting
    case loaded(PhoneSnapshot)

    /// 届いたスナップショットを反映する。手元より古いもの（`PhoneSnapshot.isOlder`）は捨てるが、同じ記録先を後に開いた
    /// ものなら、開いた順だけは引き継ぐ（iPhone の時計が戻って、後に開いたときのスナップショットの時刻が前になったとき）
    public func applying(_ arrived: PhoneSnapshot) -> PhoneSnapshotLoading {
        switch self {
        case .waiting: .loaded(arrived)
        case .loaded(let current) where arrived.isOlder(than: current): .loaded(current.keepingLaterOpening(of: arrived))
        case .loaded(let current): .loaded(arrived.keepingLaterOpening(of: current))
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
        guard shownStore == recordStore.store else { return .refused(message: watchOutdatedMessage) }
        result = await backend.startSession(id: id)
    case .operate(let id, let kind, let shownSession, let shownStore):
        guard shownStore == recordStore.store else { return .refused(message: watchOutdatedMessage) }
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
/// - 断ったときは、記録先が替わっていても断りを返す。替わった先の様子で上書きすると、Watch は頼みが通ったように見せてしまう
///   （ログインが切れて、この端末の記録先に替わったときなど）。Watch は断られたら今の様子を頼み直す
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
        guard case .snapshot(let snapshot) = answer else { return answer }
        let (current, currentTag) = recordStore()
        if currentTag != tag {
            (backend, tag) = (current, currentTag)
            answer = await replyTo(.current, using: backend, recordStore: tag)
            handedOver = false
        } else if !handedOver {
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
