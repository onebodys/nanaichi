import Testing

@testable import NanaichiDomain
@testable import NanaichiPresentation

@Test("ログインした直後の確かめに、この Mac に残っているセッションと記入の数を出す")
func importPrompt() {
    #expect(
        importPromptTextOf(ImportSummary(sessions: 3, entries: 12))
            == "ログインする前にこの Mac で記録した3セッション・記入 12件があります。アカウントに取り込むと、ほかの端末からも見られます。")
    #expect(remainingRecordsTextOf(ImportSummary(sessions: 0, entries: 0)) == "アカウントに取り込んでいない記録はありません")
}

@Test("取り込みを終えたら、重なったもの・開いたままのもの・タグの上限を、あるときだけ伝える")
func importResultLines() {
    #expect(
        importResultLinesOf(ImportResult(imported: 2, overlapping: 0, open: .noOpenSession), tagKindsOverLimit: false)
            == ["2セッションをアカウントに取り込みました。"])
    #expect(
        importResultLinesOf(ImportResult(imported: 1, overlapping: 1, open: .openSessionLeft), tagKindsOverLimit: true)
            == [
                "1セッションをアカウントに取り込みました。",
                "1セッションは、アカウントの記録と時間が重なるため取り込めませんでした。この Mac に残しています。",
                "この Mac で開いたままのセッションは、終えてから取り込めます。",
                "使っているタグが 20 種類を超えました。新しいタグをつけるには、設定の「タグ」で使わないタグを削除してください。",
            ])
}

@Test("途中で止まったら、やり直すと残りだけを取り込むと伝える")
func importFailure() {
    #expect(importFailureMessageOf(.backend(.unreachable)) == "通信できませんでした。やり直すと、残りの記録だけを取り込みます。")
    #expect(
        importFailureMessageOf(.rateLimitedTooLong)
            == "混み合っているため取り込めませんでした。しばらくしてからやり直してください。取り込めた分はそのままです。")
}
