import type { TaskItem } from "./types";

/**
 * The task column as rows, in the order it is drawn. The band over the
 * finished tasks is a row like any other, so the cursor can land on it and
 * open it.
 */
export type TaskRow =
  | { kind: "task"; task: TaskItem }
  | { kind: "band"; count: number };

export function taskRows(
  tasks: TaskItem[],
  currentAgent: string | null,
  showDone: boolean,
): TaskRow[] {
  const ordered = orderTasks(tasks, currentAgent);
  const live = ordered.filter((task) => task.status !== "complete");
  const finished = ordered.filter((task) => task.status === "complete");
  return [
    ...live.map((task): TaskRow => ({ kind: "task", task })),
    ...(finished.length > 0 ? [{ kind: "band", count: finished.length } as TaskRow] : []),
    ...(showDone ? finished.map((task): TaskRow => ({ kind: "task", task })) : []),
  ];
}

/**
 * The order the task column reads in: this session's work first, then
 * everything unassigned, then other agents', and what is finished last.
 *
 * It lives here rather than in the panel because the keyboard has to count
 * the same rows the panel draws.
 */
export function orderTasks(tasks: TaskItem[], currentAgent: string | null): TaskItem[] {
  const group = (task: TaskItem) =>
    currentAgent ? (task.agentId === currentAgent ? 0 : task.agentId ? 2 : 1) : 0;
  return [...tasks].sort(
    (a, b) =>
      group(a) - group(b) ||
      Number(a.status === "complete") - Number(b.status === "complete") ||
      b.updatedAt - a.updatedAt,
  );
}
