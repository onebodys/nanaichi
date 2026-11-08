import NanaichiDomain

public typealias DeleteTagStore = TagStore & JournalEntryStore

/// タグがついている記入すべてから、タグを外す（付け替える）
private func applyToEntries(_ store: some DeleteTagStore) -> (DeletedTag) throws -> Void {
    { deleted in
        for entry in try store.listJournalEntriesTaggedWith(deleted.name) {
            try store.saveJournalEntryTags(entry.deletingTag(deleted))
        }
    }
}

/// タグを削除する（GLOSSARY の「タグの削除」、ADR 0017）。
///
/// 使っているタグの読み込み → 削除するタグと付け替え先が使われているかの確認
/// → ついている記入すべてからタグを外す（付け替える）。記入は消さず、更新時刻も変えない。
/// 付け替え先は使っているタグなので、タグの種類は増えず、上限を確かめる必要はない。
/// 何件の記入を書き換えても、全部書くか何も書かないかは記録先のトランザクションが守る
public func deleteTag(_ store: some DeleteTagStore, name: TagName, deletion: TagDeletion) throws
    -> Result<DeletedTag, DeleteTagRejected>
{
    try DeletedTag(name: name, deletion: deletion).ensureDeletable(inUse: store.listTagsInUse())
        .andThrough(applyToEntries(store))
}
