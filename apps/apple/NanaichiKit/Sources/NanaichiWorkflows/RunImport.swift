import NanaichiDomain

/// 取り込みが使う口。この端末の記録先を読んで消すものと、アカウントへ束を送るもの
public struct ImportDeps: Sendable {
    public let load: @Sendable () async -> Result<ImportableRecords, BackendError>
    public let remove: @Sendable ([SessionId]) async -> Result<Void, BackendError>
    public let send: @Sendable (ImportBatch) async -> Result<ImportReceipt, ImportCallError>
    public let wait: @Sendable (_ milliseconds: Int) async -> Void
    public let onProgress: @Sendable (ImportProgress) async -> Void

    public init(
        load: @escaping @Sendable () async -> Result<ImportableRecords, BackendError>,
        remove: @escaping @Sendable ([SessionId]) async -> Result<Void, BackendError>,
        send: @escaping @Sendable (ImportBatch) async -> Result<ImportReceipt, ImportCallError>,
        wait: @escaping @Sendable (_ milliseconds: Int) async -> Void,
        onProgress: @escaping @Sendable (ImportProgress) async -> Void
    ) {
        self.load = load
        self.remove = remove
        self.send = send
        self.wait = wait
        self.onProgress = onProgress
    }
}

/// 同じ束に 429 が続いたら諦める回数。Retry-After が 10 秒なら1分ほど（Web と同じ）
let rateLimitedAttempts = 6

/// 429 なら Retry-After だけ待って同じ束を送り直す。答えをもらった束は送り直さない
private func sendPatiently(_ deps: ImportDeps, _ batch: ImportBatch) async -> Result<ImportReceipt, ImportFailure> {
    var attempt = 1
    while true {
        switch await deps.send(batch) {
        case .success(let receipt): return .success(receipt)
        case .failure(.backend(let error)): return .failure(.backend(error))
        case .failure(.rateLimited(let retryAfterMs)):
            if attempt >= rateLimitedAttempts { return .failure(.rateLimitedTooLong) }
            await deps.wait(retryAfterMs)
            attempt += 1
        }
    }
}

/// この端末の閉じたセッションをアカウントへ取り込む（ADR 0020、Web の `runImport`）。
///
/// 1. この端末の記録を読み、束に分ける（1回の取り込みで1度だけ。答えをもらったセッションを送り直さない）
/// 2. 束を順に送り、アカウントに入ったと返ったセッションだけをこの端末から消す
/// 3. 失敗したらそこで止まる。やり直しは最初からでよい: 消した分は送らず、送ったが消せなかった分は
///    `AlreadyImported` が返って消える
public func runImport(_ deps: ImportDeps) async -> Result<ImportResult, ImportFailure> {
    let records: ImportableRecords
    switch await deps.load() {
    case .success(let loaded): records = loaded
    case .failure(let error): return .failure(.backend(error))
    }
    let batches: [ImportBatch]
    do {
        batches = try Import.batches(records.sessions, advanceModeChanges: records.advanceModeChanges)
    } catch {
        // ドメインの型を JSON にできないのは、記録が壊れているか実装の誤り
        return .failure(.backend(.broken))
    }
    let total = records.sessions.count
    var done = 0
    var imported = 0
    var overlapping = 0
    await deps.onProgress(ImportProgress(done: done, total: total))

    for batch in batches {
        let receipt: ImportReceipt
        switch await sendPatiently(deps, batch) {
        case .success(let received): receipt = received
        case .failure(let failure): return .failure(failure)
        }
        let accepted = receipt.acceptedIds
        if case .failure(let error) = await deps.remove(accepted) { return .failure(.backend(error)) }
        done += batch.sessions.count
        imported += accepted.count
        overlapping += receipt.overlappingCount
        await deps.onProgress(ImportProgress(done: done, total: total))
    }
    return .success(ImportResult(imported: imported, overlapping: overlapping, open: records.open))
}
