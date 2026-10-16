import type { TaskItem } from "./types";

/**
 * The task column as rows, in the order it is drawn. The band over the
 * finished tasks is a row like any other, so the cursor can land on it and
 * open it.
 */
export type TaskRow =
  | { kind: "task"; task: TaskItem; depth: number }
  | { kind: "band"; count: number };

/** Descendants cannot become parents, including through several levels. */
export function canParent(tasks: TaskItem[], id: string, parent: string): boolean {
  const seen = new Set<string>([id]);
  while (parent) {
    if (seen.has(parent)) return false;
    seen.add(parent);
    parent = tasks.find(task => task.id === parent)?.parentTaskId ?? "";
  }
  return true;
}

/** Keep a matching subtask attached to its ancestors when searching. */
export function taskAncestors(tasks: TaskItem[], matches: TaskItem[]): TaskItem[] {
  const parents = new Map(tasks.map(task => [task.id, task.parentTaskId]));
  const included = new Set(matches.map(task => task.id));
  for (const match of matches) {
    let parent = match.parentTaskId;
    while (parent && !included.has(parent)) {
      included.add(parent);
      parent = parents.get(parent) ?? "";
    }
  }
  return tasks.filter(task => included.has(task.id));
}

export function taskRows(tasks: TaskItem[], showDone: boolean): TaskRow[] {
  const ids = new Set(tasks.map(task => task.id));
  const children = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    const siblings = children.get(task.parentTaskId) ?? [];
    siblings.push(task);
    children.set(task.parentTaskId, siblings);
  }
  const branch = (task: TaskItem, depth = 0): TaskRow[] => [
    { kind: "task", task, depth }, ...(children.get(task.id) ?? []).flatMap(child => branch(child, depth + 1)),
  ];
  const roots = tasks.filter(task => !task.parentTaskId || !ids.has(task.parentTaskId));
  const branches = roots.map(task => branch(task));
  const live: TaskRow[][] = [], finished: TaskRow[][] = [];
  for (const rows of branches) {
    (rows.every(row => row.kind === "task" && row.task.status === "complete") ? finished : live).push(rows);
  }
  const count = finished.reduce((sum, rows) => sum + rows.length, 0);
  return [
    ...live.flat(),
    ...(count ? [{ kind: "band", count } as TaskRow] : []),
    ...(showDone ? finished.flat() : []),
  ];
}
