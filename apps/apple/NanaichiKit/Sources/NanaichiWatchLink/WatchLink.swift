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
}

/// iPhone から Watch に届くもの。頼みへの答えと、iPhone の側で変わったときの知らせに使う
public enum PhoneMessage: Hashable, Sendable, Codable {
    /// iPhone の記録先のスナップショットと、iPhone が記録先と測った時計のずれ。
    /// Watch の時計は iPhone と揃っているとみなし、Watch の時刻にこのずれを足して記録先の時刻を見積もる
    case snapshot(Received)
    /// 頼んだ操作を記録先が断った・記録先に届かなかった。`message` は Watch にそのまま出す文言
    case refused(message: String)
}

/// iPhone が Watch の頼み `message` を、いまの記録先 `backend` に通して答える。
/// 断られても、iPhone の画面の状態は記録先の同期メッセージで変わり、Watch にも知らせとして届く
public func replyTo(_ message: WatchMessage, using backend: any Backend) async -> PhoneMessage {
    let result =
        switch message {
        case .current: await backend.getCurrentSession()
        case .start(let id): await backend.startSession(id: id)
        case .abort(let id): await backend.operateSession(id: id, kind: .abort)
        }
    switch result {
    case .success(let snapshot):
        return .snapshot(Received(snapshot: snapshot, offset: await backend.clockOffset()))
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
