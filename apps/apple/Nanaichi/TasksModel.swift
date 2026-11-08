import Foundation
import NanaichiDomain
import NanaichiPresentation
import Observation

/// ToDo の設定とタスク（GLOSSARY の「タスク」「ToDo の設定」、ADR 0026・0027、Web の use-tasks.ts・use-task-setting.ts）。
/// アカウントの記録先でだけ作る。この端末の記録先には ToDo がない
///
/// - 繋がるたびに読み込み直し、切れていた間の変更を取り込む
/// - 自分の操作の応答と、ほかの端末や自動完了の同期メッセージを、同じ一覧に反映する
@Observable
@MainActor
final class TasksModel {
    private(set) var setting: Loadable<TaskSetting> = .loading
    private(set) var settingErrorMessage: String?
    private(set) var tasks: Loadable<[TodoTask]> = .loading
    private(set) var errorMessage: String?

    /// 同期メッセージを受け取る記録先
    @ObservationIgnored private let backend: any Backend
    @ObservationIgnored private let api: any TaskBackend

    init(backend: any Backend, api: any TaskBackend) {
        self.backend = backend
        self.api = api
    }

    func run() async {
        for await event in await backend.subscribe() {
            switch event {
            case .connected: await refresh()
            case .message(.taskSettingChanged(let changed)): setting = .loaded(changed)
            case .message(let message):
                if let change = taskListChangeOf(message) { apply(change) }
            }
        }
    }

    func refresh() async {
        setting = setting.replacing(with: await api.getTaskSetting())
        tasks = tasks.replacing(with: await api.getTasks().map(\.tasks))
    }

    private func apply(_ change: ([TodoTask]) -> [TodoTask]) {
        guard case .loaded(let current) = tasks else { return }
        tasks = .loaded(change(current))
    }

    // MARK: - ToDo の設定

    /// 押した見た目がすぐ変わるよう先に手元を替え、変えられなければ元に戻す
    func changeSetting(_ next: TaskSetting) {
        let before = setting
        setting = .loaded(next)
        settingErrorMessage = nil
        Task {
            switch await api.changeTaskSetting(next) {
            case .success(let changed): setting = .loaded(changed)
            case .failure(let error):
                setting = before
                settingErrorMessage = taskSettingErrorMessageOf(error)
            }
        }
    }

    // MARK: - タスクの操作。通ったかを返す

    /// 空白だけのタイトルでは作らない
    func create(_ title: String) async -> Bool {
        guard let title = TaskTitle(title) else { return false }
        let id = TaskId(UUID().uuidString.lowercased())!
        return await operate({ await $0.createTask(id: id, title: title) }, then: saved)
    }

    func rename(_ id: TaskId, to title: String) async -> Bool {
        guard let title = TaskTitle(title) else { return false }
        return await operate({ await $0.renameTask(id: id, title: title) }, then: saved)
    }

    func complete(_ id: TaskId) async -> Bool {
        await operate({ await $0.completeTask(id: id) }, then: saved)
    }

    func reopen(_ id: TaskId) async -> Bool {
        await operate({ await $0.reopenTask(id: id) }, then: saved)
    }

    func delete(_ id: TaskId) async -> Bool {
        await operate({ await $0.deleteTask(id: id) }, then: { deleted in self.apply { removeTask($0, id: deleted.id) } })
    }

    private func saved(_ task: TodoTask) {
        apply { upsertTask($0, task) }
    }

    /// 失敗したら文言を出し、一覧を読み込み直す
    private func operate<Value>(
        _ call: (any TaskBackend) async -> Result<Value, BackendError>, then done: (Value) -> Void
    ) async -> Bool {
        switch await call(api) {
        case .success(let value):
            errorMessage = nil
            done(value)
            return true
        case .failure(let error):
            errorMessage = taskErrorMessageOf(error)
            tasks = tasks.replacing(with: await api.getTasks().map(\.tasks))
            return false
        }
    }
}
