import Testing

@testable import NanaichiDevice
@testable import NanaichiDomain
@testable import NanaichiWorkflows

// Web の `apps/web/src/workflows/user-commands.test.ts` と同じ場面。どの書き込みで何を知らせるかを確かめる。
// 入力の形の誤り（ID が UUID でないなど）は Swift の型で起こらないので、本文の検証で確かめる

private let manual = AdvanceMode(focusToJournal: .manual, journalToFocus: .manual, journalToBreak: .manual, breakToFocus: .manual)

private func kinds(_ messages: [SyncMessage]) -> [String] {
    messages.map { message in
        switch message {
        case .sessionChanged: "SessionChanged"
        case .journalEntrySaved: "JournalEntrySaved"
        case .journalEntryDeleted: "JournalEntryDeleted"
        case .tagDeleted: "TagDeleted"
        case .advanceModeChanged: "AdvanceModeChanged"
        case .taskSaved: "TaskSaved"
        case .taskDeleted: "TaskDeleted"
        case .taskSettingChanged: "TaskSettingChanged"
        case .recordsImported: "RecordsImported"
        }
    }
}

private func started(_ records: SQLiteRecords) throws {
    _ = try startSessionCommand(records, id: eventId(), now: at(0), newSessionId: sessionId()).get()
}

@Suite("セッションの開始の知らせ")
struct StartSessionCommandTests {
    @Test("開始するとセッションの変化を知らせる")
    func start() throws {
        try freshStore { records in
            let executed = try startSessionCommand(records, id: eventId(), now: at(0), newSessionId: sessionId()).get()
            #expect(executed.messages == [.sessionChanged(executed.value)])
        }
    }

    @Test("セッションがあるうちに開始すると失敗し、何も知らせない")
    func alreadyInProgress() throws {
        try freshStore { records in
            try started(records)
            let result = try startSessionCommand(records, id: eventId(), now: at(1), newSessionId: sessionId())
            guard case .sessionAlreadyInProgress = try failed(result) else {
                Issue.record("セッションがあるうちに開始できてしまった")
                return
            }
        }
    }
}

@Suite("セッションへの操作の知らせ")
struct OperateSessionCommandTests {
    @Test("一時停止するとセッションの変化を知らせる")
    func pause() throws {
        try freshStore { records in
            try started(records)
            let executed = try operateSessionCommand(records, id: eventId(), kind: .pause, now: at(5)).get()
            #expect(kinds(executed.messages) == ["SessionChanged"])
        }
    }

    @Test("セッションがなければ操作は失敗し、何も知らせない")
    func noSession() throws {
        try freshStore { records in
            let result = try operateSessionCommand(records, id: eventId(), kind: .pause, now: at(0))
            #expect(try failed(result) == .noSessionInProgress)
        }
    }
}

@Suite("ジャーナル記入の知らせ")
struct JournalEntryCommandTests {
    @Test("記入を書くと記入の保存とセッションの変化を知らせる")
    func write() throws {
        try freshStore { records in
            try started(records)
            let executed = try writeJournalEntryCommand(records, id: entryId(), body: "集中できた", tags: [], now: at(1)).get()
            #expect(kinds(executed.messages) == ["JournalEntrySaved", "SessionChanged"])
            #expect(executed.messages.first == .journalEntrySaved(executed.value))
            guard case .sessionChanged(.session) = executed.messages.last else {
                Issue.record("書いたあとのスナップショットにセッションがない")
                return
            }
        }
    }

    @Test("セッションの外で記入を書くと失敗し、何も知らせない")
    func writeOutside() throws {
        try freshStore { records in
            let result = try writeJournalEntryCommand(records, id: entryId(), body: "集中できた", tags: [], now: at(0))
            #expect(try failed(result) == .noSessionInProgress)
        }
    }

    @Test("本文が空白だけなら書けず、何も記録しない")
    func blankBody() throws {
        try freshStore { records in
            try started(records)
            let id = entryId()
            let result = try writeJournalEntryCommand(records, id: id, body: " \n ", tags: [], now: at(1))
            #expect(try failed(result) == .invalidInput(ValidationError(field: "body")))
            #expect(try failed(result).rejectionCode == .invalidRequest)
            #expect(try records.findJournalEntry(id) == nil)
        }
    }

    @Test("記入を編集すると記入の保存だけを知らせる")
    func edit() throws {
        try freshStore { records in
            try started(records)
            let id = entryId()
            _ = try writeJournalEntryCommand(records, id: id, body: "前", tags: [], now: at(1)).get()
            let executed = try editJournalEntryCommand(records, id: id, body: "後", tags: [], now: at(2)).get()
            #expect(kinds(executed.messages) == ["JournalEntrySaved"])
        }
    }

    @Test("ない記入を編集すると失敗し、何も知らせない")
    func editMissing() throws {
        try freshStore { records in
            let id = entryId()
            let result = try editJournalEntryCommand(records, id: id, body: "後", tags: [], now: at(0))
            #expect(try failed(result) == .journalEntryNotFound(JournalEntryNotFound(id: id)))
        }
    }

    @Test("記入を削除すると記入の削除を知らせる")
    func delete() throws {
        try freshStore { records in
            try started(records)
            let id = entryId()
            _ = try writeJournalEntryCommand(records, id: id, body: "前", tags: [], now: at(1)).get()
            let executed = try deleteJournalEntryCommand(records, id: id, now: at(2)).get()
            #expect(executed.messages == [.journalEntryDeleted(executed.value)])
        }
    }
}

@Suite("タグの削除の知らせ")
struct DeleteTagCommandTests {
    @Test("タグを外すと削除したタグだけを知らせ、書き換えた記入は知らせない")
    func detach() throws {
        try freshStore { records in
            try started(records)
            _ = try writeJournalEntryCommand(records, id: entryId(), body: "前", tags: [tag("仕事")], now: at(1)).get()
            let executed = try deleteTagCommand(records, name: tag("仕事"), deletion: .detach).get()
            #expect(executed.messages == [.tagDeleted(executed.value)])
        }
    }

    @Test("使っていないタグを削除すると失敗し、何も知らせない")
    func unused() throws {
        try freshStore { records in
            let result = try deleteTagCommand(records, name: tag("仕事"), deletion: .detach)
            #expect(try failed(result) == .tagNotFound(name: tag("仕事")))
        }
    }
}

@Suite("フェーズの進め方の知らせ")
struct AdvanceModeCommandTests {
    @Test("フェーズの進め方を変えるとセッションがあれば進め方の変化とセッションの変化を知らせる")
    func withSession() throws {
        try freshStore { records in
            try started(records)
            let executed = try changeAdvanceModeCommand(records, to: manual, now: at(10))
            #expect(executed.value == manual)
            #expect(kinds(executed.messages) == ["AdvanceModeChanged", "SessionChanged"])
        }
    }

    @Test("フェーズの進め方を変えてもセッションがなければセッションの変化は知らせない")
    func withoutSession() throws {
        try freshStore { records in
            let executed = try changeAdvanceModeCommand(records, to: manual, now: at(0))
            #expect(executed.messages == [.advanceModeChanged(manual)])
        }
    }

    @Test("いまと同じ進め方にしても何も知らせない")
    func unchanged() throws {
        try freshStore { records in
            try started(records)
            #expect(try changeAdvanceModeCommand(records, to: .allAuto, now: at(10)).messages.isEmpty)
        }
    }
}
