import type { TaskItem } from "./types";

/**
 * The task column as rows, in the order it is drawn. The band over the
 * finished tasks is a row like any other, so the cursor can land on it and
 * open it.
 */
export type TaskRow =
  | { kind: "task"; task: TaskItem }
  | { kind: "band"; count: number };

/// Tasks arrive in the order the queue holds them, so the column draws them
/// as they come and only sets the finished ones aside.
export function taskRows(tasks: TaskItem[], showDone: boolean): TaskRow[] {
  const live = tasks.filter((task) => task.status !== "complete");
  const finished = tasks.filter((task) => task.status === "complete");
  return [
    ...live.map((task): TaskRow => ({ kind: "task", task })),
    ...(finished.length > 0 ? [{ kind: "band", count: finished.length } as TaskRow] : []),
    ...(showDone ? finished.map((task): TaskRow => ({ kind: "task", task })) : []),
  ];
}
