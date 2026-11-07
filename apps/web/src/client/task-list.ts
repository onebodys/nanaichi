import type { CompletedTask, OpenTask, Task, TaskId } from "../domain/task.ts";

/** 応答や同期メッセージで届いたタスクを一覧に反映する。同じ ID があれば置き換える（古い内容では置き換えない） */
export const upsertTask = (tasks: ReadonlyArray<Task>, incoming: Task): ReadonlyArray<Task> => {
  const known = tasks.find(({ id }) => id === incoming.id);
  if (known === undefined) {
    return [...tasks, incoming];
  }
  // 応答と同期メッセージは前後して届くことがある。新しい内容を古い内容で戻さない
  if (known.updatedAt.getTime() > incoming.updatedAt.getTime()) {
    return tasks;
  }
  return tasks.map((task) => (task.id === incoming.id ? incoming : task));
};

export const removeTask = (tasks: ReadonlyArray<Task>, id: TaskId): ReadonlyArray<Task> =>
  tasks.filter((task) => task.id !== id);

/** 画面に出す順。未完了は作った順、完了は完了した新しい順 */
export const groupTasks = (
  tasks: ReadonlyArray<Task>,
): Readonly<{ open: ReadonlyArray<OpenTask>; completed: ReadonlyArray<CompletedTask> }> => ({
  open: tasks
    .flatMap((task) => (task.kind === "Open" ? [task] : []))
    .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
  completed: tasks
    .flatMap((task) => (task.kind === "Completed" ? [task] : []))
    .toSorted((a, b) => b.completedAt.getTime() - a.completedAt.getTime()),
});

/** 完了したタスクにつける、どう完了になったかの表示。手動の完了には何も出さない */
export const completionLabelOf = (task: CompletedTask): string | undefined => {
  switch (task.completion.kind) {
    case "Manual":
      return undefined;
    case "FromJournal":
      return `ジャーナルから完了 (${Math.round(task.completion.probability * 100)}%)`;
  }
};
