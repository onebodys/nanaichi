import { useState } from "react";
import type { CompletedTask, OpenTask } from "../domain/task.ts";
import { Button } from "./components/ui/button.tsx";
import { completionLabelOf, groupTasks } from "./task-list.ts";
import type { TasksState } from "./use-tasks.ts";

const INPUT_CLASS =
  "h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

const CHECKBOX_CLASS = "size-4 shrink-0 cursor-pointer accent-primary";

const AddForm = ({ create }: Readonly<{ create: TasksState["create"] }>) => {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void create(draft).then((created) => created && setDraft(""));
      }}
    >
      <input
        aria-label="タスクを追加"
        placeholder="やることを追加"
        className={INPUT_CLASS}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button type="submit" size="sm" variant="outline" disabled={draft.trim().length === 0}>
        追加
      </Button>
    </form>
  );
};

const TitleEditor = ({
  initial,
  save,
  cancel,
}: Readonly<{ initial: string; save: (title: string) => void; cancel: () => void }>) => {
  const [draft, setDraft] = useState(initial);
  return (
    <form
      className="flex min-w-0 flex-1 gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        save(draft);
      }}
    >
      <input
        aria-label="タスクのタイトルを編集"
        autoFocus
        className={INPUT_CLASS}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            cancel();
          }
        }}
      />
      <Button type="submit" size="xs" disabled={draft.trim().length === 0}>
        保存
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={cancel}>
        やめる
      </Button>
    </form>
  );
};

const OpenTaskItem = ({ task, tasks }: Readonly<{ task: OpenTask; tasks: TasksState }>) => {
  const [editing, setEditing] = useState(false);
  return (
    <li aria-label="未完了のタスク" className="flex items-center gap-2 py-1.5">
      <input
        type="checkbox"
        aria-label={`「${task.title}」を完了にする`}
        className={CHECKBOX_CLASS}
        checked={false}
        onChange={() => void tasks.complete(task.id)}
      />
      {editing ? (
        <TitleEditor
          initial={task.title}
          cancel={() => setEditing(false)}
          save={(title) =>
            void tasks.rename(task.id, title).then((saved) => saved && setEditing(false))
          }
        />
      ) : (
        <>
          <span className="min-w-0 flex-1 break-words text-sm">{task.title}</span>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => setEditing(true)}
          >
            編集
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => void tasks.remove(task.id)}
          >
            削除
          </Button>
        </>
      )}
    </li>
  );
};

const CompletedTaskItem = ({
  task,
  tasks,
}: Readonly<{ task: CompletedTask; tasks: TasksState }>) => {
  const label = completionLabelOf(task);
  return (
    <li aria-label="完了したタスク" className="flex items-center gap-2 py-1.5">
      <input
        type="checkbox"
        aria-label={`「${task.title}」を未完了に戻す`}
        className={CHECKBOX_CLASS}
        checked
        onChange={() => void tasks.reopen(task.id)}
      />
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">
        <span className="break-words line-through">{task.title}</span>
        {label !== undefined && <span className="ml-2 text-xs">{label}</span>}
      </span>
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onClick={() => void tasks.remove(task.id)}
      >
        削除
      </Button>
    </li>
  );
};

/**
 * ホーム画面の ToDo のパネル（GLOSSARY の「タスク」、ADR 0026）。アカウントの記録先でだけ出す。
 * 未完了のタスクをチェックすると完了になり、完了したタスクのチェックを外すと未完了に戻る。
 * ジャーナルに書いた内容から自動で完了になったタスクには、その印を出す。
 */
export const TaskPanel = ({ tasks }: Readonly<{ tasks: TasksState }>) => {
  const { view } = tasks;
  if (view.kind === "Unavailable") {
    return null;
  }
  const { open, completed } = view.kind === "Loaded" ? groupTasks(view.tasks) : groupTasks([]);
  return (
    <section aria-labelledby="task-panel-heading" className="flex flex-col gap-2">
      <h2 id="task-panel-heading" className="text-sm font-bold">
        ToDo
      </h2>
      <AddForm create={tasks.create} />
      {tasks.errorMessage !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {tasks.errorMessage}
        </p>
      )}
      {view.kind === "Loading" && <p className="text-xs text-muted-foreground">読み込み中</p>}
      {view.kind === "LoadFailed" && (
        <p role="alert" className="text-xs text-muted-foreground">
          タスクを読み込めませんでした。
          <Button variant="link" size="xs" onClick={tasks.refresh}>
            読み込み直す
          </Button>
        </p>
      )}
      {view.kind === "Loaded" && open.length === 0 && (
        <p className="text-xs text-muted-foreground">未完了のタスクはありません</p>
      )}
      {open.length > 0 && (
        <ul className="divide-y">
          {open.map((task) => (
            <OpenTaskItem key={task.id} task={task} tasks={tasks} />
          ))}
        </ul>
      )}
      {completed.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            完了したタスク ({completed.length})
          </summary>
          <ul className="divide-y">
            {completed.map((task) => (
              <CompletedTaskItem key={task.id} task={task} tasks={tasks} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
};
