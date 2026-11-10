/// タグ `tag` のついた記入の1ページ（`GET /api/journal-entries/by-tag` の応答）。
/// 削除していない記入を、書いた時刻の新しい順に並べる
public struct TaggedEntriesPage: Hashable, Sendable, Codable {
    public let tag: TagName
    public let entries: [JournalEntry]
    public let next: PageCursor
}

/// 画面に出す、書いた日付ごとのまとまり。新しい日付が先
public struct TaggedEntriesDay: Hashable, Sendable, Encodable {
    public let date: LocalDate
    public let entries: [JournalEntry]
}

private func newestFirst(_ a: JournalEntry, _ b: JournalEntry) -> Bool { a.writtenAt > b.writtenAt }

public enum TaggedEntries {
    /// 1ページに含める記入の数
    public static let pageSize = 20

    /// 記録から読んだ記入を1ページにする。`found` は `limit + 1` 件まで読んだもので、
    /// `limit` を超えていれば次のページがある（`Timeline.page` と同じ）
    public static func page(tag: TagName, found: [JournalEntry], limit: Int) -> TaggedEntriesPage {
        let entries = Array(found.prefix(limit))
        guard found.count > limit, let oldest = entries.last else {
            return TaggedEntriesPage(tag: tag, entries: entries, next: .end)
        }
        return TaggedEntriesPage(tag: tag, entries: entries, next: .more(before: oldest.writtenAt))
    }

    /// 読み込んだ記入 `b` を `a` に足す。同じ ID は `b` で置き換え、書いた時刻の新しい順に並べる
    public static func merge(_ a: [JournalEntry], _ b: [JournalEntry]) -> [JournalEntry] {
        let ids = Set(b.map(\.id))
        return (a.filter { !ids.contains($0.id) } + b).sorted(by: newestFirst)
    }

    /// 新しい順の記入を、タイムゾーン `timeZone`（端末のタイムゾーン）で書いた日付ごとにまとめる
    public static func byDate(_ entries: [JournalEntry], timeZone: TimeZoneName) -> [TaggedEntriesDay] {
        var days: [(date: LocalDate, entries: [JournalEntry])] = []
        for entry in entries.sorted(by: newestFirst) {
            let date = timeZone.localDate(at: entry.writtenAt)
            if days.last?.date == date {
                days[days.count - 1].entries.append(entry)
            } else {
                days.append((date, [entry]))
            }
        }
        return days.map { TaggedEntriesDay(date: $0.date, entries: $0.entries) }
    }
}

// MARK: - 読み書きの契約

/// タグのついた記入を読む範囲。次のページがあるかを見分けるため、`limit` は1ページより1件多くする
public enum TaggedEntriesRange: Hashable, Sendable {
    case latest(tag: TagName, limit: Int)
    case before(tag: TagName, Instant, limit: Int)
}

/// タグのついた削除していない記入を、書いた時刻の新しい順に読む契約
public protocol TaggedEntriesStore {
    func findJournalEntriesWithTag(_ range: TaggedEntriesRange) throws -> [JournalEntry]
}
