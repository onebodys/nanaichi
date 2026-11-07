import { Result } from "@praha/byethrow";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { Task, TaskId, type FindTask, type SaveTask, type TaskNotFound } from "../domain/task.ts";
import { loadTask } from "./task-not-found.ts";

export type CompleteTaskError = ValidationError | TaskNotFound;

export type CompleteTaskDeps = Readonly<{ findTask: FindTask; saveTask: SaveTask }>;

const parseId = schemaResult(TaskId.schema);

/**
 * タスクを自分で完了にする。
 *
 * すでに完了していれば、通信のやり直しや自動完了との行き違いとして、記録済みのタスクをそのまま返す
 * （完了した時刻とそのしかたは先に完了にしたものを残す）。
 */
export const completeTask =
  (deps: CompleteTaskDeps) =>
  (rawId: unknown, now: Date): Result.Result<Task, CompleteTaskError> =>
    Result.pipe(
      parseId(rawId),
      Result.andThen(loadTask(deps.findTask)),
      Result.map((task): Task => {
        if (task.kind === "Completed") {
          return task;
        }
        const completed = Task.complete(task, { kind: "Manual" }, now);
        deps.saveTask(completed);
        return completed;
      }),
    );
