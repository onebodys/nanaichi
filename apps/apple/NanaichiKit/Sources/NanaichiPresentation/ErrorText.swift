import NanaichiDomain

// 画面に出す失敗の文言。記録先の文言はそのまま出さない（Web の use-session-timer.ts・use-timeline.ts）

/// この端末に保存できなかったときの文言（ADR 0019・0028）
func storageFailedMessageOf(_ failure: StorageFailure) -> String {
    switch failure {
    case .quotaExceeded: "ディスクの空きが足りず、記録を保存できませんでした。"
    case .unavailable: "この Mac に記録を保存できませんでした。もう一度お試しください。"
    case .newerFormat: "この Mac の記録は新しい版のアプリで保存されたものなので開けません。アプリを新しくしてください。"
    }
}

/// タイマーの操作に失敗したときの文言。断られたときは、最新の状態を読み込み直す
public func operationErrorMessageOf(_ error: BackendError) -> String {
    switch error {
    case .unreachable: "通信できませんでした。もう一度お試しください。"
    case .storageFailed(let failure): storageFailedMessageOf(failure)
    case .rejected, .broken: "操作できませんでした。最新の状態を読み込み直しました。"
    }
}

/// ジャーナル記入を書けなかったときの文言
public func writeErrorMessageOf(_ error: BackendError) -> String {
    switch error {
    case .unreachable: "通信できませんでした。もう一度お試しください。"
    case .storageFailed(let failure): storageFailedMessageOf(failure)
    case .rejected(.noSessionInProgress): "セッションの外では書けません。"
    case .rejected(.tagLimitExceeded): "タグは\(Tag.kindsMax)種類までです。使っていないタグを外してください。"
    case .rejected, .broken: "保存できませんでした。"
    }
}

/// 記入の編集・削除ができなかったときの文言
public func entryChangeErrorMessageOf(_ error: BackendError) -> String {
    switch error {
    case .rejected(.journalEntryNotFound): "この記入は削除されています。"
    case .unreachable, .storageFailed, .rejected, .broken: writeErrorMessageOf(error)
    }
}

/// タグを削除できなかったときの文言。使われなくなっていたときは、一覧を読み込み直す
public func tagDeletionErrorMessageOf(_ error: BackendError) -> String {
    switch error {
    case .unreachable: "通信できませんでした。もう一度お試しください。"
    case .storageFailed(let failure): storageFailedMessageOf(failure)
    case .rejected(.tagNotFound): "そのタグはもう使われていません。一覧を読み込み直しました。"
    case .rejected, .broken: "削除できませんでした。"
    }
}

/// フェーズの進め方を変えられなかったときの文言
public func advanceModeErrorMessageOf(_ error: BackendError) -> String {
    switch error {
    case .storageFailed(let failure): storageFailedMessageOf(failure)
    case .unreachable, .rejected, .broken: "変更できませんでした。もう一度お試しください。"
    }
}
