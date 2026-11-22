import Foundation
import NanaichiDomain

// ジャーナル記入の入力欄の本文と、送れなかった記入（Web の journal-draft.ts、Issue #80）

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

/// 送れなかった記入（GLOSSARY）。送り直している間は、帯のボタンを押せなくする
public enum UnsentEntry: Hashable, Sendable, Identifiable {
    case unsent(JournalSubmission)
    case resending(JournalSubmission)

    public var submission: JournalSubmission {
        switch self {
        case .unsent(let submission), .resending(let submission): submission
        }
    }

    public var id: JournalEntryId { submission.id }
}

/// 入力欄の本文と、その上の帯に並べた送れなかった記入。
///
/// - 送るとすぐ入力欄を空にし、送っている間も続けて書ける
/// - 送れなかったとき、入力欄が空なら本文を戻す。書き足していれば、送れなかった記入を帯に残す
/// - 帯の記入は、それぞれの ID のまま送り直す・入力欄に戻す・捨てる。ほかの記入を送れても消えない
public struct JournalDraft: Hashable, Sendable {
    /// 入力欄の本文がどこから来たか。送れなかった記入を戻したもの（`returned`）なら、
    /// 本文とタグを変えずに送るとその記入の ID で送り、二重に書かない
    enum Origin: Hashable, Sendable {
        case typed
        case returned(JournalSubmission)
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

    /// 入力欄の本文を送る記入にし、入力欄を空にする。入力欄に戻した記入を本文もタグも変えずに送るなら、その ID を使う
    public mutating func submit(tags: [TagName], newId: () -> JournalEntryId) -> JournalSubmission {
        let id: JournalEntryId
        switch origin {
        case .returned(let returned) where returned.body == body && returned.tags == tags: id = returned.id
        case .typed, .returned: id = newId()
        }
        let submission = JournalSubmission(id: id, body: body, tags: tags)
        body = ""
        origin = .typed
        return submission
    }

    /// 入力欄から送った記入が送れなかった
    public mutating func failed(_ submission: JournalSubmission) {
        if body.isEmpty {
            body = submission.body
            origin = .returned(submission)
        } else {
            unsent.append(.unsent(submission))
        }
    }

    /// 帯の記入を送り直し始める。送る記入（最初に送ったときの ID・本文・タグのまま）を返す。
    /// 帯にないか、もう送り直しているなら返さない
    public mutating func resend(_ id: JournalEntryId) -> JournalSubmission? {
        guard let index = unsentIndex(of: id) else { return nil }
        let submission = unsent[index].submission
        unsent[index] = .resending(submission)
        return submission
    }

    /// 送り直した記入を送れたので、帯から消す
    public mutating func resent(_ id: JournalEntryId) {
        unsent.removeAll { $0.id == id }
    }

    /// 送り直しても送れなかったので、帯に残す
    public mutating func resendFailed(_ id: JournalEntryId) {
        unsent = unsent.map { $0.id == id ? .unsent($0.submission) : $0 }
    }

    /// 帯の記入を入力欄に戻す。入力欄が空ならそのまま入れ、空でなければ今の本文の前に改行をはさんでつなげる。
    /// つなげると本文が変わるので、次に送るときは新しい ID になる
    public mutating func returnToInput(_ id: JournalEntryId) {
        guard let index = unsentIndex(of: id) else { return }
        let submission = unsent.remove(at: index).submission
        if body.isEmpty {
            body = submission.body
            origin = .returned(submission)
        } else {
            body = "\(submission.body)\n\(body)"
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
            case .unsent(let submission): submission.id == id
            case .resending: false
            }
        }
    }
}
