import Foundation
import NanaichiDomain
import NanaichiPresentation
import Observation

/// 読み込んだものの様子。読み込み直している間は、前に読み込んだものを出し続ける
enum Loadable<Value> {
    case loading
    case loadFailed
    case loaded(Value)

    var value: Value? {
        switch self {
        case .loaded(let value): value
        case .loading, .loadFailed: nil
        }
    }

    /// 読み込み直した結果。読めなかったときは、読み込めていたものを残す
    func replacing(with result: Result<Value, BackendError>) -> Loadable<Value> {
        switch (result, self) {
        case (.success(let value), _): .loaded(value)
        case (.failure, .loaded): self
        case (.failure, .loading), (.failure, .loadFailed): .loadFailed
        }
    }
}

/// 使っているタグ・設定のタグの一覧・タグの削除と、入力欄でつけたままのタグ（Web の use-tags.ts・use-tag-usage.ts・
/// use-attached-tags.ts）。
///
/// 記入を書いた・編集した・削除した、タグを削除したという同期メッセージが届くたびに読み込み直す。
/// つけたままのタグは端末ごとに UserDefaults に覚え、記録先には送らない（ADR 0013）
@Observable
@MainActor
final class TagsModel {
    /// 入力の候補に出す、使っているタグ（最近使った順）
    private(set) var known: [TagName] = []
    /// 設定に出す、使っているタグとその記入の数
    private(set) var usage: Loadable<[TagUsage]> = .loading
    private var attached: AttachedTags

    @ObservationIgnored private let backend: any Backend
    @ObservationIgnored private let defaults: UserDefaults
    /// 覚える UserDefaults のキー。Web の localStorage と同じく、この端末の記録先の分であることを名前に含める（ADR 0019）
    private static let attachedKey = "attachedTags:device"

    init(backend: any Backend, defaults: UserDefaults = .standard) {
        self.backend = backend
        self.defaults = defaults
        attached = AttachedTags.parse(defaults.data(forKey: Self.attachedKey))
    }

    func run() async {
        for await event in await backend.subscribe() {
            switch event {
            case .connected, .message(.journalEntrySaved), .message(.journalEntryDeleted), .message(.recordsImported):
                await refresh()
            case .message(.tagDeleted(let deleted)):
                store(attached.deletingTag(deleted))
                await refresh()
            case .message(.sessionChanged), .message(.advanceModeChanged), .message(.taskSaved),
                .message(.taskDeleted), .message(.taskSettingChanged):
                break
            }
        }
    }

    func refresh() async {
        if case .success(let list) = await backend.getTags() { known = list.tags }
        usage = usage.replacing(with: await backend.getTagUsage().map(\.tags))
    }

    // MARK: - つけたままのタグ

    /// 今のセッション `sessionId`（なければ nil）で入力欄につけたままのタグ
    func attached(in sessionId: SessionId?) -> [TagName] { attached.attached(in: sessionId) }

    func attach(_ tags: [TagName], in sessionId: SessionId?) {
        store(.attaching(tags, in: sessionId))
    }

    /// セッションが始まったら、準備しておいたタグをそのセッションのタグとして覚え直す（終わったら外れるように）
    func adopt(by sessionId: SessionId?) {
        if let adopted = attached.adopted(by: sessionId) { store(adopted) }
    }

    private func store(_ next: AttachedTags) {
        attached = next
        defaults.set(next.serialized(), forKey: Self.attachedKey)
    }

    // MARK: - タグの削除

    /// タグを削除する（GLOSSARY の「タグの削除」、ADR 0017）。削除できなければ画面に出す文言を返す
    func delete(_ name: TagName, deletion: TagDeletion) async -> String? {
        let result = await backend.deleteTag(name: name, deletion: deletion)
        await refresh()
        switch result {
        case .success(let deleted):
            store(attached.deletingTag(deleted))
            return nil
        case .failure(let error):
            return tagDeletionErrorMessageOf(error)
        }
    }
}
