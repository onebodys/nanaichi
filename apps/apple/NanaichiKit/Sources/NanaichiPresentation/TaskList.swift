import NanaichiDomain

// ToDo の一覧の並びと文言（Web の task-list.ts・task-panel.tsx・use-tasks.ts、ADR 0026）

/// 画面に出す順に分けたタスク。未完了は作った順、完了は完了した新しい順
public struct GroupedTasks: Hashable, Sendable {
    public let open: [OpenTask]
    public let completed: [CompletedTask]
}

public func groupTasks(_ tasks: [TodoTask]) -> GroupedTasks {
    GroupedTasks(
        open: tasks.compactMap { task in
            guard case .open(let open) = task else { return nil }
            return open
        }.sorted { $0.createdAt < $1.createdAt },
        completed: tasks.compactMap { task in
            guard case .completed(let completed) = task else { return nil }
            return completed
        }.sorted { $0.completedAt > $1.completedAt })
}

/// 応答や同期メッセージで届いたタスクを一覧に反映する。同じ ID があれば置き換える。
/// 応答と同期メッセージは前後して届くことがあるので、新しい内容を古い内容では置き換えない
public func upsertTask(_ tasks: [TodoTask], _ incoming: TodoTask) -> [TodoTask] {
    guard let index = tasks.firstIndex(where: { $0.id == incoming.id }) else { return tasks + [incoming] }
    guard tasks[index].updatedAt <= incoming.updatedAt else { return tasks }
    var next = tasks
    next[index] = incoming
    return next
}

public func removeTask(_ tasks: [TodoTask], id: TaskId) -> [TodoTask] {
    tasks.filter { $0.id != id }
}

/// 同期メッセージが読み込んだタスクの一覧に当てる変更。タスクに関わらないメッセージなら nil
public func taskListChangeOf(_ message: SyncMessage) -> (([TodoTask]) -> [TodoTask])? {
    switch message {
    case .taskSaved(let task): return { tasks in upsertTask(tasks, task) }
    case .taskDeleted(let deleted): return { tasks in removeTask(tasks, id: deleted.id) }
    case .sessionChanged, .journalEntrySaved, .journalEntryDeleted, .tagDeleted, .advanceModeChanged,
        .taskSettingChanged:
        return nil
    }
}

/// 完了したタスクにつける、どう完了になったかの表示。手動の完了には何も出さない
public func completionLabelOf(_ task: CompletedTask) -> String? {
    switch task.completion {
    case .manual: nil
    case .fromJournal(_, let probability): "ジャーナルから完了 (\(Int((probability.value * 100).rounded()))%)"
    }
}

public func completedTasksHeaderTextOf(count: Int) -> String {
    "完了したタスク (\(count))"
}

/// タスクの操作に失敗したときの文言。どれも一覧を読み込み直す
public func taskErrorMessageOf(_ error: BackendError) -> String {
    switch error {
    case .unreachable: "通信できませんでした。もう一度お試しください。"
    case .rejected(.taskNotFound): "そのタスクはもうありません。一覧を読み込み直しました。"
    case .rejected, .storageFailed, .broken: "操作できませんでした。"
    }
}

/// ToDo の設定を変えられなかったときの文言
public func taskSettingErrorMessageOf(_ error: BackendError) -> String {
    advanceModeErrorMessageOf(error)
}
