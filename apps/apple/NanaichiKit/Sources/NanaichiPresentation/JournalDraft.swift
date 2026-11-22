import Foundation
import NanaichiDomain

// ジャーナル記入の入力欄の本文と、送れなかった記入（Web の journal-draft.ts、Issue #80・#88）

/// 送る記入。ID は送る側が発行し、同じ記入を送り直すときは変えない（ADR 0010）
public struct JournalSubmission: Hashable, Sendable {
    public let id: JournalEntryId
    public let body: String
    public let tags: [TagName]

    public init(id: JournalEntryId, body: String, tags: [TagName]) {
        self.id = id
        self.body = body
        self.tags = tags
    }
}

/// 送れなかった記入（GLOSSARY）。送ろうとしたときのセッションを持つ。送り直している間は、帯のボタンを押せなくする
public enum UnsentEntry: Hashable, Sendable, Identifiable {
    case unsent(JournalSubmission, session: SessionId)
    case resending(JournalSubmission, session: SessionId)

    public var submission: JournalSubmission {
        switch self {
        case .unsent(let submission, _), .resending(let submission, _): submission
        }
    }

    /// 送ろうとしたときのセッション
    public var session: SessionId {
        switch self {
        case .unsent(_, let session), .resending(_, let session): session
        }
    }

    public var id: JournalEntryId { submission.id }

    /// 今のセッション（nil ならセッションの外）でどう扱えるか
    public func standing(in current: SessionId?) -> UnsentEntryStanding {
        switch self {
        case .resending: .resending
        case .unsent(_, let session):
            switch current {
            case nil: .outsideSession
            case session: .currentSession
            case .some: .previousSession
            }
        }
    }
}

/// 帯の記入が今どう扱えるか（Issue #88）。どれでも本文はコピーでき、送り直している間のほかは捨てられる
public enum UnsentEntryStanding: Hashable, Sendable {
    /// 送り直している。どのボタンも押せない
    case resending
    /// 今のセッションで送ろうとした。送り直す・入力欄に戻す・捨てるを選べる
    case currentSession
    /// 前のセッションで送ろうとした。送り直すと今のセッションの記入になる（紐付きはサーバーが受け付けた時刻で
    /// 決まる。ADR 0010）ので、送り直せない。入力欄に戻して、今のセッションの新しい記入として書ける
    case previousSession
    /// セッションの外。送り直すことも入力欄に戻すこともできない
    case outsideSession

    public var canResend: Bool {
        switch self {
        case .currentSession: true
        case .resending, .previousSession, .outsideSession: false
        }
    }

    /// セッションの外では入力欄を使えず、戻すと本文を選んでコピーできなくなるので、帯に残す
    public var canReturnToInput: Bool {
        switch self {
        case .currentSession, .previousSession: true
        case .resending, .outsideSession: false
        }
    }

    public var canDiscard: Bool {
        switch self {
        case .resending: false
        case .currentSession, .previousSession, .outsideSession: true
        }
    }
}

/// 入力欄の本文と、その上の帯に並べた送れなかった記入。
///
/// - 送るとすぐ入力欄を空にし、送っている間も続けて書ける
/// - 送れなかったとき、入力欄が空なら本文を戻す。書き足していれば、送れなかった記入を帯に残す
/// - 帯の記入は、それぞれの ID のまま送り直す・入力欄に戻す・捨てる。ほかの記入を送れても消えない
/// - 送り直せるのは、送ろうとしたのと同じセッションの間だけ（Issue #88）。前のセッションの記入は、入力欄に戻すと
///   今のセッションの新しい記入（新しい ID）として送る
public struct JournalDraft: Hashable, Sendable {
    /// 入力欄の本文がどこから来たか。送れなかった記入を戻したもの（`returned`）なら、
    /// 送ろうとしたのと同じセッションで、本文とタグを変えずに送るとその記入の ID で送り、二重に書かない
    enum Origin: Hashable, Sendable {
        case typed
        case returned(JournalSubmission, session: SessionId)
    }

    /// 入力欄の本文
    public var body: String
    var origin: Origin
    public private(set) var unsent: [UnsentEntry]

    public init() {
        body = ""
        origin = .typed
        unsent = []
    }

    /// 入力欄の本文を `session` に送る記入にし、入力欄を空にする。
    /// 入力欄に戻した記入を、送ろうとしたのと同じセッションで本文もタグも変えずに送るなら、その ID を使う
    public mutating func submit(tags: [TagName], in session: SessionId, newId: () -> JournalEntryId)
        -> JournalSubmission
    {
        let id: JournalEntryId
        switch origin {
        case .returned(let returned, let returnedSession)
        where returnedSession == session && returned.body == body && returned.tags == tags:
            id = returned.id
        case .typed, .returned: id = newId()
        }
        let submission = JournalSubmission(id: id, body: body, tags: tags)
        body = ""
        origin = .typed
        return submission
    }

    /// `session` に入力欄から送った記入が送れなかった
    public mutating func failed(_ submission: JournalSubmission, in session: SessionId) {
        if body.isEmpty {
            body = submission.body
            origin = .returned(submission, session: session)
        } else {
            unsent.append(.unsent(submission, session: session))
        }
    }

    /// 帯の記入を今のセッション（`session`）で送り直し始める。送る記入（最初に送ったときの ID・本文・タグのまま）を返す。
    /// 帯にないか、もう送り直しているか、前のセッションの記入なら返さない
    public mutating func resend(_ id: JournalEntryId, in session: SessionId) -> JournalSubmission? {
        guard let index = unsentIndex(of: id), unsent[index].session == session else { return nil }
        let submission = unsent[index].submission
        unsent[index] = .resending(submission, session: session)
        return submission
    }

    /// 送り直した記入を送れたので、帯から消す
    public mutating func resent(_ id: JournalEntryId) {
        unsent.removeAll { $0.id == id }
    }

    /// 送り直しても送れなかったので、帯に残す
    public mutating func resendFailed(_ id: JournalEntryId) {
        unsent = unsent.map { $0.id == id ? .unsent($0.submission, session: $0.session) : $0 }
    }

    /// 帯の記入を入力欄に戻す。入力欄が空ならそのまま入れ、空でなければ今の本文の前に改行をはさんでつなげる。
    /// つなげると本文が変わるので、次に送るときは新しい ID になる。前のセッションの記入を戻したときも、
    /// 次に送るときは新しい ID になる（`submit`）
    public mutating func returnToInput(_ id: JournalEntryId) {
        guard let index = unsentIndex(of: id) else { return }
        let entry = unsent.remove(at: index)
        if body.isEmpty {
            body = entry.submission.body
            origin = .returned(entry.submission, session: entry.session)
        } else {
            body = "\(entry.submission.body)\n\(body)"
            origin = .typed
        }
    }

    /// 帯の記入を捨てる（実は保存できていたときのため）
    public mutating func discard(_ id: JournalEntryId) {
        guard let index = unsentIndex(of: id) else { return }
        unsent.remove(at: index)
    }

    /// 帯の記入のうち、送り直していないものの位置。送り直している間は戻すことも捨てることもしない
    private func unsentIndex(of id: JournalEntryId) -> Int? {
        unsent.firstIndex { entry in
            switch entry {
            case .unsent(let submission, _): submission.id == id
            case .resending: false
            }
        }
    }
}
