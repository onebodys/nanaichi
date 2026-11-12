import NanaichiDomain
import Testing

@testable import NanaichiPresentation

private func task(_ number: Int, _ title: String, createdAt: Instant) -> OpenTask {
    TodoTask.create(
        id: TaskId("cccccccc-0000-4000-8000-00000000000\(number)")!, title: TaskTitle(title)!, now: createdAt)
}

private let entryId = JournalEntryId("aaaaaaaa-0000-4000-8000-000000000001")!

@Test("未完了のタスクは作った順、完了したタスクは完了した新しい順に並ぶ")
func groupsTasksInDisplayOrder() {
    let first = task(1, "企画書を書く", createdAt: minutes(1))
    let second = task(2, "メールを返す", createdAt: minutes(2))
    let earlier = task(3, "資料を読む", createdAt: minutes(0)).complete(.manual, now: minutes(5))
    let later = task(4, "電話する", createdAt: minutes(3)).complete(.manual, now: minutes(9))
    let grouped = groupTasks([.open(second), .completed(earlier), .open(first), .completed(later)])
    #expect(grouped.open == [first, second])
    #expect(grouped.completed == [later, earlier])
}

@Test("届いたタスクは同じ ID を置き換え、知らないタスクは足し、古い内容では戻さない")
func upsertKeepsTheNewest() {
    let open = task(1, "企画書を書く", createdAt: minutes(1))
    let completed = open.complete(.manual, now: minutes(3))
    let added = upsertTask([], .open(open))
    #expect(added == [.open(open)])
    let replaced = upsertTask(added, .completed(completed))
    #expect(replaced == [.completed(completed)])
    #expect(upsertTask(replaced, .open(open)) == replaced)
}

@Test("同期メッセージでタスクの保存と削除が一覧に反映され、タスクに関わらないメッセージは何もしない")
func syncMessagesChangeTaskList() throws {
    let open = task(1, "企画書を書く", createdAt: minutes(1))
    let save = try #require(taskListChangeOf(.taskSaved(.open(open))))
    let saved = save([])
    #expect(saved == [.open(open)])
    let delete = try #require(taskListChangeOf(.taskDeleted(DeletedTask(id: open.id))))
    #expect(delete(saved) == [])
    let setting = taskListChangeOf(.taskSettingChanged(.enabled))
    #expect(setting == nil)
    let unrelated = taskListChangeOf(.advanceModeChanged(.allAuto))
    #expect(unrelated == nil)
}

@Test("ジャーナルからの完了には確率を添え、手動の完了には何も出さない")
func completionLabel() {
    let open = task(1, "企画書を書く", createdAt: minutes(1))
    let fromJournal = open.complete(
        .fromJournal(entryId: entryId, probability: Probability(0.955)!), now: minutes(2))
    #expect(completionLabelOf(fromJournal) == "ジャーナルから完了 (96%)")
    #expect(completionLabelOf(open.complete(.manual, now: minutes(2))) == nil)
    #expect(completedTasksHeaderTextOf(count: 2) == "完了したタスク (2)")
}

@Test("もうないタスクを操作したときは、一覧を読み込み直したと伝える")
func taskErrorMessages() {
    #expect(taskErrorMessageOf(.rejected(.taskNotFound)) == "そのタスクはもうありません。一覧を読み込み直しました。")
    #expect(taskErrorMessageOf(.unreachable) == "通信できませんでした。もう一度お試しください。")
    #expect(taskErrorMessageOf(.broken) == "操作できませんでした。")
}
