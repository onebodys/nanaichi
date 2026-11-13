import Foundation

// 取り込み（GLOSSARY の「取り込み」、ADR 0020）。この端末の閉じたセッションをアカウントへ移す。
// 送る形は TS の `domain/session-record.ts` と `domain/import.ts` と同じ（`POST /api/imports` の本文）。
// どの行をアカウントに足すか・重なるかの判断はサーバーがするので、ここには送る形と束の分け方だけを置く

// MARK: - セッションの記録

/// 記録されている記入。削除した記入は本文とタグを捨て、ID・削除した時刻・セッション・書いた時刻だけを送る。
/// ID は同じ記入の再送を見分けるため、書いた時刻は自動終了の判断で削除した記入も数えるため（ADR 0010）
public enum StoredEntry: Hashable, Sendable {
    case written(JournalEntry)
    case deleted(DeletedJournalEntry, sessionId: SessionId, writtenAt: Instant)
}

/// 閉じたセッション。`sessions.ended_at` / `ended_by` と同じものだけを持ち、終了の状態はサーバーが計算し直す
public struct ClosedSession: Hashable, Sendable {
    public let id: SessionId
    /// 同じミリ秒の操作は記録した順（SQLite の `ORDER BY at, rowid`）
    public let events: RecordedSessionEvents
    public let entries: [StoredEntry]
    public let endedAt: Instant
    public let endedBy: EndedBy

    public init(id: SessionId, events: RecordedSessionEvents, entries: [StoredEntry], endedAt: Instant, endedBy: EndedBy) {
        self.id = id
        self.events = events
        self.entries = entries
        self.endedAt = endedAt
        self.endedBy = endedBy
    }

    public var startedAt: Instant { events.start.event.at }
}

/// セッションの記録の JSON の形式の版（TS の `SESSION_RECORD_FORMAT_VERSION`）
let sessionRecordFormatVersion = 1

private enum StoredEntryKind: String {
    case written = "Written"
    case deleted = "Deleted"
}

private enum ClosingKind: String {
    case closed = "Closed"
}

extension StoredEntry: Encodable {
    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .written(let entry):
            try encoder.encode(kind: StoredEntryKind.written) { try $0.encode(entry, forKey: "entry") }
        case .deleted(let deleted, let sessionId, let writtenAt):
            try encoder.encode(kind: StoredEntryKind.deleted) {
                try $0.encode(deleted, forKey: "deleted")
                try $0.encode(sessionId, forKey: "sessionId")
                try $0.encode(writtenAt, forKey: "writtenAt")
            }
        }
    }
}

/// TS の `SessionRecord.toJson({ kind: "Closed", session })` と同じ形。記入の本文はここでだけ取り出す
extension ClosedSession: Encodable {
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: JSONKey.self)
        try container.encode(sessionRecordFormatVersion, forKey: "version")
        try container.encode(id, forKey: "id")
        try container.encode(events, forKey: "events")
        var closing = container.nestedContainer(keyedBy: JSONKey.self, forKey: "closing")
        try closing.encode(ClosingKind.closed.rawValue, forKey: "kind")
        try closing.encode(endedAt, forKey: "endedAt")
        try closing.encode(endedBy, forKey: "endedBy")
        try container.encode(entries, forKey: "entries")
    }
}

// MARK: - 取り込みの束

/// 1回の `POST /api/imports` の本文
public struct ImportBatch: Hashable, Sendable, Encodable {
    /// 閉じたセッション。この端末の記録の順（始めた時刻の順）
    public let sessions: [ClosedSession]
    /// この端末の進め方の変更履歴の全部（時刻の順）。どの行をアカウントに足すかはサーバーが決める
    public let advanceModeChanges: [AdvanceModeChange]

    public init(sessions: [ClosedSession], advanceModeChanges: [AdvanceModeChange]) {
        self.sessions = sessions
        self.advanceModeChanges = advanceModeChanges
    }
}

// MARK: - 取り込みの応答

/// セッションごとの結果。この端末は `imported` と `alreadyImported` だけを消す
public enum SessionImportOutcomeKind: String, Hashable, Sendable, Decodable {
    /// 受け取ってアカウントに書いた
    case imported = "Imported"
    /// 同じ ID のセッションがアカウントにすでにある。上書きしていない
    case alreadyImported = "AlreadyImported"
    /// アカウントのセッションと時間が重なるので書いていない
    case overlapping = "Overlapping"
}

public struct SessionImportOutcome: Hashable, Sendable, Decodable {
    public let sessionId: SessionId
    public let kind: SessionImportOutcomeKind

    public init(sessionId: SessionId, kind: SessionImportOutcomeKind) {
        self.sessionId = sessionId
        self.kind = kind
    }
}

/// `POST /api/imports` の応答。束のセッションと同じ順
public struct ImportReceipt: Hashable, Sendable, Decodable {
    public let outcomes: [SessionImportOutcome]

    public init(outcomes: [SessionImportOutcome]) {
        self.outcomes = outcomes
    }

    /// アカウントに入ったので、この端末から消してよいセッション
    public var acceptedIds: [SessionId] {
        outcomes.compactMap { outcome in
            switch outcome.kind {
            case .imported, .alreadyImported: outcome.sessionId
            case .overlapping: nil
            }
        }
    }

    public var overlappingCount: Int {
        outcomes.count { $0.kind == .overlapping }
    }
}

/// 束を1つ送った失敗（TS の `ImportCallError`）
public enum ImportCallError: Error, Hashable, Sendable {
    case backend(BackendError)
    /// 429（送りすぎ）。`retryAfterMs` は Retry-After（秒）から
    case rateLimited(retryAfterMs: Int)
}

/// 取り込みが途中で止まった理由
public enum ImportFailure: Error, Hashable, Sendable {
    /// 通信・この端末の保存・応答の形の失敗。やり直せば、残っている分だけを送る
    case backend(BackendError)
    /// 送りすぎ（429）が続いた
    case rateLimitedTooLong
}

/// 取り込みを最後まで終えたときの結果
public struct ImportResult: Hashable, Sendable {
    /// アカウントに入ったセッションの数（`Imported` と `AlreadyImported`。人にとってはどちらも入った）
    public let imported: Int
    /// 時間が重なって取り込めず、この端末に残したセッションの数
    public let overlapping: Int
    public let open: OpenSessionLeft

    public init(imported: Int, overlapping: Int, open: OpenSessionLeft) {
        self.imported = imported
        self.overlapping = overlapping
        self.open = open
    }
}

public struct ImportProgress: Hashable, Sendable {
    public let done: Int
    public let total: Int

    public init(done: Int, total: Int) {
        self.done = done
        self.total = total
    }
}

// MARK: - この端末の取り込める記録

/// 自動終了を確定させたあとも開いているセッションがあるか。開いているセッションは取り込まない
public enum OpenSessionLeft: Hashable, Sendable {
    case noOpenSession
    case openSessionLeft
}

/// 取り込める記録（TS の `ImportableRecords`）
public struct ImportableRecords: Hashable, Sendable {
    /// 閉じたセッション。始めた時刻の順
    public let sessions: [ClosedSession]
    /// この端末の進め方の変更履歴の全部（時刻の順）
    public let advanceModeChanges: [AdvanceModeChange]
    public let open: OpenSessionLeft

    public init(sessions: [ClosedSession], advanceModeChanges: [AdvanceModeChange], open: OpenSessionLeft) {
        self.sessions = sessions
        self.advanceModeChanges = advanceModeChanges
        self.open = open
    }
}

/// 取り込みの確かめに出す数
public struct ImportSummary: Hashable, Sendable {
    public let sessions: Int
    /// 削除していない記入の数
    public let entries: Int
}

// MARK: - 判断

public enum Import {
    /// 1つの束に入れるセッションの数の上限（TS の `IMPORT_BATCH_MAX_SESSIONS`。サーバーはこれを超える束を断る）
    public static let batchMaxSessions = 100
    /// 1つの束の大きさの目安（送る JSON のバイト数）。1件で超えるセッションは、そのセッションだけの束にする。
    /// TS は UTF-16 の文字数で数える。UTF-8 のバイト数はそれ以上になるので、TS より小さい束になる側にずれる
    public static let batchMaxBytes = 1_000_000

    /// 取り込みの確かめに出す数。記入は削除していないものだけを数える
    public static func summaryOf(_ sessions: [ClosedSession]) -> ImportSummary {
        ImportSummary(
            sessions: sessions.count,
            entries: sessions.reduce(0) { sum, session in
                sum
                    + session.entries.count { entry in
                        switch entry {
                        case .written: true
                        case .deleted: false
                        }
                    }
            })
    }

    /// 閉じたセッションを、件数と大きさの上限で束に分ける（順は保つ）。どの束にも端末の進め方の履歴を全部持たせる。
    /// 大きさは送る形の JSON のバイト数で見積もる
    public static func batches(_ sessions: [ClosedSession], advanceModeChanges: [AdvanceModeChange]) throws
        -> [ImportBatch]
    {
        let encoder = JSONEncoder()
        let base = try encoder.encode(ImportBatch(sessions: [], advanceModeChanges: advanceModeChanges)).count
        var groups: [(sessions: [ClosedSession], size: Int)] = []
        for session in sessions {
            // 区切りのカンマの分を1バイト足す
            let size = try encoder.encode(session).count + 1
            if let last = groups.last, last.sessions.count < batchMaxSessions, last.size + size <= batchMaxBytes {
                groups[groups.count - 1] = (last.sessions + [session], last.size + size)
            } else {
                groups.append(([session], base + size))
            }
        }
        return groups.map { ImportBatch(sessions: $0.sessions, advanceModeChanges: advanceModeChanges) }
    }
}
