import Foundation

/// 同期メッセージ（GLOSSARY の「同期メッセージ」）。UserDO が記録を変えるたびに、
/// そのユーザーのすべての接続へ WebSocket で送る（ADR 0012）
public enum SyncMessage: Hashable, Sendable {
    /// セッションが変わった（開始・操作・記入で自動終了の時刻が延びた）。新しいスナップショット
    case sessionChanged(SessionSnapshot)
    /// 記入を書いた・編集した
    case journalEntrySaved(JournalEntry)
    case journalEntryDeleted(DeletedJournalEntry)
    /// タグを削除した。外した・付け替えた記入そのものではなく、削除したタグと付け替え先を送り、
    /// 画面が読み込んだ記入に同じ削除を当てる（ADR 0017）
    case tagDeleted(DeletedTag)
    /// フェーズの進め方を変えた（ADR 0016）。進行中のセッションがあれば、あわせて `sessionChanged` も送る
    case advanceModeChanged(AdvanceMode)
    /// タスクを作った・タイトルを変えた・完了にした（ジャーナルからの完了を含む）・再開した。保存後のタスク
    case taskSaved(TodoTask)
    /// タスクを削除した（ADR 0026）
    case taskDeleted(DeletedTask)
    /// ToDo の設定を変えた（ADR 0027）
    case taskSettingChanged(TaskSetting)
    /// この端末の記録を取り込んだ（ADR 0020）。取り込んだ記録は送らず、画面がタイムライン・スタッツ・タグを読み込み直す
    case recordsImported

    /// 送る文字列にする。記入の本文は JSON にするときだけ取り出す（`JournalEntry` の JSON）
    public func serialize() throws -> String {
        String(decoding: try JSONEncoder().encode(self), as: UTF8.self)
    }

    /// 届いた文字列を同期メッセージに戻す。JSON でないか、形が合わなければ nil
    public static func deserialize(_ text: String) -> SyncMessage? {
        try? JSONDecoder().decode(SyncMessage.self, from: Data(text.utf8))
    }
}

extension SyncMessage: Codable {
    private enum Kind: String, Codable {
        case sessionChanged = "SessionChanged"
        case journalEntrySaved = "JournalEntrySaved"
        case journalEntryDeleted = "JournalEntryDeleted"
        case tagDeleted = "TagDeleted"
        case advanceModeChanged = "AdvanceModeChanged"
        case taskSaved = "TaskSaved"
        case taskDeleted = "TaskDeleted"
        case taskSettingChanged = "TaskSettingChanged"
        case recordsImported = "RecordsImported"
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        func field<T: Decodable>(_ key: JSONKey) throws -> T { try fields.decode(T.self, forKey: key) }
        switch try decoder.kind(Kind.self) {
        case .sessionChanged: self = .sessionChanged(try field("snapshot"))
        case .journalEntrySaved: self = .journalEntrySaved(try field("entry"))
        case .journalEntryDeleted: self = .journalEntryDeleted(try field("deleted"))
        case .tagDeleted: self = .tagDeleted(try field("deleted"))
        case .advanceModeChanged: self = .advanceModeChanged(try field("mode"))
        case .taskSaved: self = .taskSaved(try field("task"))
        case .taskDeleted: self = .taskDeleted(try field("deleted"))
        case .taskSettingChanged: self = .taskSettingChanged(try field("setting"))
        case .recordsImported: self = .recordsImported
        }
    }

    public func encode(to encoder: any Encoder) throws {
        func write(_ kind: Kind, _ key: JSONKey, _ value: some Encodable) throws {
            try encoder.encode(kind: kind) { try $0.encode(value, forKey: key) }
        }
        switch self {
        case .sessionChanged(let snapshot): try write(.sessionChanged, "snapshot", snapshot)
        case .journalEntrySaved(let entry): try write(.journalEntrySaved, "entry", entry)
        case .journalEntryDeleted(let deleted): try write(.journalEntryDeleted, "deleted", deleted)
        case .tagDeleted(let deleted): try write(.tagDeleted, "deleted", deleted)
        case .advanceModeChanged(let mode): try write(.advanceModeChanged, "mode", mode)
        case .taskSaved(let task): try write(.taskSaved, "task", task)
        case .taskDeleted(let deleted): try write(.taskDeleted, "deleted", deleted)
        case .taskSettingChanged(let setting): try write(.taskSettingChanged, "setting", setting)
        case .recordsImported: try encoder.encode(kind: Kind.recordsImported) { _ in }
        }
    }
}
