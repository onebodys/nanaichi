import Foundation
import NanaichiDevice
import NanaichiDomain
import NanaichiPresentation
import NanaichiWorkflows
import Observation

/// 最後に取り込んだときの結果。アプリを開いている間だけ覚える（Web の use-import.ts の LastImport）
enum LastImport {
    case notRun
    case finished(ImportResult, tagKindsOverLimit: Bool)
    case failed(ImportFailure)
}

/// 取り込みの様子
enum ImportState {
    /// この Mac の記録を読んでいる
    case checking
    /// この Mac の記録を読めなかった。画面に出す文言
    case unreadable(String)
    case idle(ImportableRecords, last: LastImport)
    case running(ImportProgress)
}

/// ログインしているあいだの、この Mac の記録の取り込み（ADR 0020）。ログインするたびに作り直す。
///
/// 判断（どのセッションを送り、どれを消すか）は `runImport` に任せ、ここは画面に出す様子を持つだけ
@Observable
@MainActor
final class ImportModel {
    private(set) var state: ImportState = .checking
    /// ログインした直後の確かめを出すか。閉じたら（あとでにしても、取り込み終えても）出さない
    var prompting: Bool

    @ObservationIgnored private let device: DeviceBackend
    @ObservationIgnored private let account: SignedIn

    /// - Parameter askNow: ログインした直後なら true。起動したときにログインしていたなら、設定から取り込む
    init(device: DeviceBackend, account: SignedIn, askNow: Bool) {
        self.device = device
        self.account = account
        prompting = askNow
    }

    /// 確かめに出す中身。取り込める記録がなく、取り込んでもいなければ出さない
    var prompt: ImportState? {
        guard prompting else { return nil }
        switch state {
        case .checking, .unreadable: return nil
        case .running: return state
        case .idle(let records, .notRun): return records.sessions.isEmpty ? nil : state
        case .idle(_, .finished), .idle(_, .failed): return state
        }
    }

    var isRunning: Bool {
        if case .running = state { return true }
        return false
    }

    /// この Mac の記録を読み直す。最後の結果は残す
    func check() async {
        let last: LastImport =
            switch state {
            case .idle(_, let last): last
            case .checking, .unreadable, .running: .notRun
            }
        switch await device.loadImportable() {
        case .success(let records): state = .idle(records, last: last)
        case .failure(let error): state = .unreadable(deviceUnreadableMessageOf(error))
        }
    }

    /// 取り込む。途中で止まっても、やり直せば残りだけを送る
    func start() async {
        guard !isRunning else { return }
        state = .running(ImportProgress(done: 0, total: 0))
        let device = device
        let account = account
        let result = await runImport(
            ImportDeps(
                load: { await device.loadImportable() },
                remove: { await device.removeClosedSessions($0) },
                send: { await account.sendImportBatch($0) },
                wait: { milliseconds in try? await Task.sleep(for: .milliseconds(milliseconds)) },
                onProgress: { [weak self] progress in await self?.progressed(progress) }))
        let last: LastImport =
            switch result {
            case .success(let imported): .finished(imported, tagKindsOverLimit: await tagKindsOverLimit())
            case .failure(let failure): .failed(failure)
            }
        switch await device.loadImportable() {
        case .success(let records): state = .idle(records, last: last)
        case .failure(let error): state = .unreadable(deviceUnreadableMessageOf(error))
        }
    }

    private func progressed(_ progress: ImportProgress) {
        state = .running(progress)
    }

    /// 取り込みで、使っているタグが上限を超えたか（取り込みでは断らない、ADR 0020）
    private func tagKindsOverLimit() async -> Bool {
        guard case .success(let usage) = await account.backend.getTagUsage() else { return false }
        return usage.tags.count > Tag.kindsMax
    }
}
