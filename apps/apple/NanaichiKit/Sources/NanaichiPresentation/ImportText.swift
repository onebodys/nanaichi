import NanaichiDomain

// 取り込み（ADR 0020）の文言。判断はせず、取り込みの様子を言葉にするだけ（Web の import-text.ts）

/// この Mac に残っている記録の数（`3セッション・記入 12件`）
public func deviceRecordsLabelOf(_ summary: ImportSummary) -> String {
    "\(summary.sessions)セッション・記入 \(summary.entries)件"
}

/// ログインした直後の確かめの本文
public func importPromptTextOf(_ summary: ImportSummary) -> String {
    "ログインする前にこの Mac で記録した\(deviceRecordsLabelOf(summary))があります。アカウントに取り込むと、ほかの端末からも見られます。"
}

/// 設定のアカウントの欄に出す、この Mac に残っている記録
public func remainingRecordsTextOf(_ summary: ImportSummary) -> String {
    summary.sessions == 0
        ? "アカウントに取り込んでいない記録はありません"
        : "アカウントに取り込んでいない\(deviceRecordsLabelOf(summary))があります"
}

public func importProgressLabelOf(_ progress: ImportProgress) -> String {
    "取り込んでいます… \(progress.done) / \(progress.total) セッション"
}

public func openSessionLinesOf(_ open: OpenSessionLeft) -> [String] {
    switch open {
    case .noOpenSession: []
    case .openSessionLeft: ["この Mac で開いたままのセッションは、終えてから取り込めます。"]
    }
}

/// 取り込みを終えたときに出す文。重なったもの・開いたままのもの・タグの上限は、あるときだけ
public func importResultLinesOf(_ result: ImportResult, tagKindsOverLimit: Bool) -> [String] {
    ["\(result.imported)セッションをアカウントに取り込みました。"]
        + (result.overlapping == 0
            ? []
            : ["\(result.overlapping)セッションは、アカウントの記録と時間が重なるため取り込めませんでした。この Mac に残しています。"])
        + openSessionLinesOf(result.open)
        + (tagKindsOverLimit
            ? ["使っているタグが \(Tag.kindsMax) 種類を超えました。新しいタグをつけるには、設定の「タグ」で使わないタグを削除してください。"]
            : [])
}

private func backendFailureMessageOf(_ error: BackendError) -> String {
    switch error {
    case .unreachable: "通信できませんでした。"
    case .storageFailed(let failure): storageFailedMessageOf(failure)
    case .rejected, .broken: "取り込めませんでした。"
    }
}

/// 途中で止まったときの文言。取り込めた分はこの Mac から消えているので、やり直すと残りだけを送る
public func importFailureMessageOf(_ failure: ImportFailure) -> String {
    switch failure {
    case .rateLimitedTooLong:
        "混み合っているため取り込めませんでした。しばらくしてからやり直してください。取り込めた分はそのままです。"
    case .backend(let error): "\(backendFailureMessageOf(error))やり直すと、残りの記録だけを取り込みます。"
    }
}

/// この Mac の記録を読めなかったとき
public func deviceUnreadableMessageOf(_ error: BackendError) -> String {
    switch error {
    case .storageFailed(let failure): storageFailedMessageOf(failure)
    case .unreachable, .rejected, .broken: "この Mac の記録を読めませんでした。"
    }
}
