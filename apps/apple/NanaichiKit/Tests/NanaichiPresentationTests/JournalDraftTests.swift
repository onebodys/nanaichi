import NanaichiDomain
import Testing

@testable import NanaichiPresentation

private func entryId(_ n: Int) -> JournalEntryId {
    JournalEntryId(String(format: "00000000-0000-4000-8000-%012d", n))!
}

/// 呼ぶたびに 1, 2, 3… の ID を発行する
private final class Ids {
    private var n = 0
    func next() -> JournalEntryId {
        n += 1
        return entryId(n)
    }
}

private let reading = TagName("読書")!

/// 入力欄に書いて送る
private func writeAndSubmit(_ draft: inout JournalDraft, _ body: String, _ ids: Ids, tags: [TagName] = [])
    -> JournalSubmission
{
    draft.body = body
    return draft.submit(tags: tags, newId: ids.next)
}

private func bodies(_ draft: JournalDraft) -> [String] { draft.unsent.map(\.submission.body) }

@Test("A を送っている間に B を書き、A が送れなかったら、入力欄には B が残り帯に A が出る")
func unsentWhileWriting() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids)
    draft.body = "B"
    draft.failed(a)
    #expect(draft.body == "B")
    #expect(draft.unsent == [.unsent(a)])
}

@Test("帯の記入を送り直すと、最初に送ったときと同じ ID・本文・タグで送る")
func resendKeepsIdBodyAndTags() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids, tags: [reading])
    draft.body = "B"
    draft.failed(a)
    let resending = draft.resend(a.id)
    #expect(resending == JournalSubmission(id: entryId(1), body: "A", tags: [reading]))
    #expect(draft.unsent == [.resending(a)])
    // 送り直している間は、もう一度送り直せない
    #expect(draft.resend(a.id) == nil)
}

@Test("送り直して送れたら帯から消え、送れなかったら帯に残ってまた送り直せる")
func resendOutcome() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids)
    draft.body = "B"
    draft.failed(a)
    _ = draft.resend(a.id)
    var succeeded = draft
    succeeded.resent(a.id)
    #expect(succeeded.unsent.isEmpty)
    draft.resendFailed(a.id)
    #expect(draft.unsent == [.unsent(a)])
    #expect(draft.resend(a.id) == a)
}

@Test("帯の記入を入力欄に戻すと、書き足した本文の前に改行をはさんでつながり、帯から消える")
func returnToInputJoins() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids)
    draft.body = "B"
    draft.failed(a)
    draft.returnToInput(a.id)
    #expect(draft.body == "A\nB")
    #expect(draft.unsent.isEmpty)
    // 本文が変わったので、次に送るときは新しい ID
    #expect(draft.submit(tags: [], newId: ids.next).id == entryId(2))
}

@Test("入力欄が空のときに帯の記入を戻すと、そのまま入り、変えずに送ると同じ ID で送る")
func returnToEmptyInputKeepsId() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids)
    draft.body = "B"
    draft.failed(a)
    draft.body = ""
    draft.returnToInput(a.id)
    #expect(draft.body == "A")
    #expect(draft.submit(tags: [], newId: ids.next).id == entryId(1))
}

@Test("帯の記入を捨てると帯から消え、入力欄は変わらない")
func discardRemoves() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids)
    draft.body = "B"
    draft.failed(a)
    draft.discard(a.id)
    #expect(draft.unsent.isEmpty)
    #expect(draft.body == "B")
}

@Test("送り直している記入は、入力欄に戻すことも捨てることもしない")
func resendingIsLocked() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids)
    draft.body = "B"
    draft.failed(a)
    _ = draft.resend(a.id)
    let resending = draft
    draft.returnToInput(a.id)
    draft.discard(a.id)
    #expect(draft == resending)
}

@Test("帯に記入を残したまま次を送って送れず、書き足していれば帯に2件並び、片方を送り直せてももう片方は残る")
func twoUnsentEntriesStay() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids)
    draft.body = "B"
    draft.failed(a)
    let b = draft.submit(tags: [], newId: ids.next)
    draft.body = "C"
    // 帯の記入があるうちに別の記入を送れても、帯は変わらない
    let c = writeAndSubmit(&draft, "C", ids)
    #expect(c.id == entryId(3))
    draft.body = "D"
    draft.failed(b)
    #expect(bodies(draft) == ["A", "B"])
    #expect(draft.unsent.map(\.id) == [entryId(1), entryId(2)])
    #expect(draft.body == "D")
    _ = draft.resend(b.id)
    draft.resent(b.id)
    #expect(bodies(draft) == ["A"])
}

@Test("書き足していないときに送れなければ、今まで通り入力欄に戻って帯は出ず、変えずに送ると同じ ID で送る")
func failedWithoutTypingReturnsToInput() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids, tags: [reading])
    draft.failed(a)
    #expect(draft.body == "A")
    #expect(draft.unsent.isEmpty)
    #expect(draft.submit(tags: [reading], newId: ids.next).id == entryId(1))
}

@Test("入力欄に戻った記入の本文かタグを変えて送ると、新しい ID で送る")
func changedReturnedDraftGetsNewId() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids, tags: [reading])
    draft.failed(a)
    var untagged = draft
    #expect(untagged.submit(tags: [], newId: ids.next).id == entryId(2))
    draft.body = "A2"
    #expect(draft.submit(tags: [reading], newId: ids.next).id == entryId(3))
}

@Test("入力欄に戻った記入を送ったら、そのあとに同じ本文を書いても新しい ID で送る")
func sentReturnedDraftForgetsId() {
    let ids = Ids()
    var draft = JournalDraft()
    let a = writeAndSubmit(&draft, "A", ids)
    draft.failed(a)
    #expect(draft.submit(tags: [], newId: ids.next).id == entryId(1))
    #expect(writeAndSubmit(&draft, "A", ids).id == entryId(2))
}
