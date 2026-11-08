import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// ToDo の一覧（GLOSSARY の「タスク」、ADR 0026、Web の task-panel.tsx）。ToDo を使うときに、左のペインの簡略のタイマーの下に出す。
///
/// チェックで完了・未完了を切り替える。名前の変更と削除は右クリックのメニューから。行をダブルクリックするか、
/// 選んで Return を押すと名前を変え、⌫ で確かめてから削除する。ジャーナルから自動で完了したタスクには、その印を出す
struct TaskListView: View {
    let model: TasksModel
    @State private var draft = ""
    @State private var selection: TaskId?
    @State private var renaming: TaskId?
    @State private var renameDraft = ""
    @State private var deleting: TodoTask?
    @FocusState private var focus: TaskField?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ToDo")
                .font(.headline)
                .padding(.horizontal, 20)
            AddField(draft: $draft, focus: $focus, add: add)
                .padding(.horizontal, 20)
            if let message = model.errorMessage {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 20)
                    .accessibilityIdentifier("tasks.error")
            }
            switch model.tasks {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .loadFailed:
                ContentUnavailableView {
                    Label("タスクを読み込めませんでした", systemImage: "exclamationmark.triangle")
                } actions: {
                    Button("読み込み直す") { Task { await model.refresh() } }
                }
            case .loaded(let tasks):
                list(groupTasks(tasks))
            }
        }
        .padding(.top, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .confirmationDialog(
            deleting.map { "「\(titleOf($0))」を削除しますか？" } ?? "",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            presenting: deleting
        ) { task in
            Button("タスクを削除", role: .destructive) {
                Task { _ = await model.delete(task.id) }
            }
            .accessibilityIdentifier("taskDeletion.confirm")
            Button("やめる", role: .cancel) {}
        } message: { _ in
            Text("削除したタスクは元に戻せません。")
        }
    }

    private func list(_ grouped: GroupedTasks) -> some View {
        List(selection: $selection) {
            Section {
                if grouped.open.isEmpty {
                    Text("未完了のタスクはありません")
                        .foregroundStyle(.secondary)
                        .selectionDisabled()
                }
                ForEach(grouped.open, id: \.id) { row(.open($0)) }
            }
            if !grouped.completed.isEmpty {
                Section(completedTasksHeaderTextOf(count: grouped.completed.count)) {
                    ForEach(grouped.completed, id: \.id) { row(.completed($0)) }
                }
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .contextMenu(forSelectionType: TaskId.self) { ids in
            if let id = ids.first, let task = find(id, in: grouped) {
                menu(for: task)
            }
        } primaryAction: { ids in
            if let id = ids.first, let task = find(id, in: grouped) { startRenaming(task) }
        }
        .onDeleteCommand {
            if let selection, let task = find(selection, in: grouped) { deleting = task }
        }
        .accessibilityIdentifier("tasks.list")
    }

    private func row(_ task: TodoTask) -> some View {
        TaskRow(
            task: task,
            renaming: renaming == task.id,
            renameDraft: $renameDraft,
            focus: $focus,
            toggle: { toggle(task) },
            saveRename: { saveRename(task) },
            cancelRename: { renaming = nil }
        )
        .tag(task.id)
    }

    @ViewBuilder
    private func menu(for task: TodoTask) -> some View {
        switch task {
        case .open: Button("完了にする") { toggle(task) }
        case .completed: Button("未完了に戻す") { toggle(task) }
        }
        Button("名前を変更") { startRenaming(task) }
        Divider()
        Button("削除…", role: .destructive) { deleting = task }
    }

    private func find(_ id: TaskId, in grouped: GroupedTasks) -> TodoTask? {
        grouped.open.first { $0.id == id }.map(TodoTask.open)
            ?? grouped.completed.first { $0.id == id }.map(TodoTask.completed)
    }

    private func add() {
        let title = draft
        Task {
            if await model.create(title) { draft = "" }
            focus = .add
        }
    }

    private func toggle(_ task: TodoTask) {
        Task {
            switch task {
            case .open(let open): _ = await model.complete(open.id)
            case .completed(let completed): _ = await model.reopen(completed.id)
            }
        }
    }

    private func startRenaming(_ task: TodoTask) {
        renameDraft = titleOf(task)
        renaming = task.id
        focus = .rename
    }

    private func saveRename(_ task: TodoTask) {
        let title = renameDraft
        Task {
            if await model.rename(task.id, to: title) { renaming = nil }
        }
    }
}

/// 文字を入れている欄。名前を変えている行は一度に1つだけ
private enum TaskField: Hashable {
    case add
    case rename
}

private func titleOf(_ task: TodoTask) -> String {
    switch task {
    case .open(let open): open.title.rawValue
    case .completed(let completed): completed.title.rawValue
    }
}

/// やることを足す欄。Return で足す
private struct AddField: View {
    @Binding var draft: String
    var focus: FocusState<TaskField?>.Binding
    let add: () -> Void

    var body: some View {
        HStack {
            TextField("やることを追加", text: $draft)
                .textFieldStyle(.roundedBorder)
                .focused(focus, equals: .add)
                .onSubmit(add)
                .accessibilityIdentifier("tasks.add")
            Button("追加", action: add)
                .disabled(TaskTitle(draft) == nil)
                .accessibilityIdentifier("tasks.addButton")
        }
    }
}

/// 1つのタスクの行。名前を変えている間は、タイトルの代わりに入力欄を出す（Return で保存、esc でやめる）
private struct TaskRow: View {
    let task: TodoTask
    let renaming: Bool
    @Binding var renameDraft: String
    var focus: FocusState<TaskField?>.Binding
    let toggle: () -> Void
    let saveRename: () -> Void
    let cancelRename: () -> Void

    private var title: String { titleOf(task) }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Toggle(isOn: Binding(get: { isCompleted }, set: { _ in toggle() })) { EmptyView() }
                .toggleStyle(.checkbox)
                .labelsHidden()
                .accessibilityLabel(isCompleted ? "「\(title)」を未完了に戻す" : "「\(title)」を完了にする")
                .accessibilityIdentifier("task.check.\(title)")
            if renaming {
                TextField("タスクのタイトル", text: $renameDraft)
                    .textFieldStyle(.roundedBorder)
                    .focused(focus, equals: .rename)
                    .onSubmit(saveRename)
                    .onExitCommand(perform: cancelRename)
                    .accessibilityIdentifier("task.rename")
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .strikethrough(isCompleted)
                        .foregroundStyle(isCompleted ? .secondary : .primary)
                        .accessibilityIdentifier("task.title.\(title)")
                    if case .completed(let completed) = task, let label = completionLabelOf(completed) {
                        Text(label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("task.completion.\(title)")
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var isCompleted: Bool {
        switch task {
        case .open: false
        case .completed: true
        }
    }
}
