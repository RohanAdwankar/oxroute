import type { TaskItem, Snapshot } from "./types";

/** Visible task rows, in keyboard order. */
export type TaskRow = { task: TaskItem; depth: number };

/** A task and every nested child, including children hidden by search. */
export function taskSubtree(tasks: TaskItem[], id: string): TaskItem[] {
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    const siblings = children.get(task.parentTaskId) ?? [];
    siblings.push(task.id);
    children.set(task.parentTaskId, siblings);
  }
  const included = new Set<string>(), pending = [id];
  while (pending.length) {
    const next = pending.pop()!;
    if (included.has(next)) continue;
    included.add(next);
    pending.push(...(children.get(next) ?? []));
  }
  return tasks.filter(task => included.has(task.id));
}

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

export function taskRows(tasks: TaskItem[]): TaskRow[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    if (task.status === "complete") continue;
    let parent = byId.get(task.parentTaskId);
    while (parent?.status === "complete") parent = byId.get(parent.parentTaskId);
    const siblings = children.get(parent?.id ?? "") ?? [];
    siblings.push(task);
    children.set(parent?.id ?? "", siblings);
  }
  // A prioritized child brings its branch forward without breaking ancestry.
  const rank = new Map(tasks.map((task, index) => [task.id, index]));
  const branchRank = (task: TaskItem): number => Math.min(rank.get(task.id)!, ...(children.get(task.id) ?? []).map(branchRank));
  for (const siblings of children.values()) siblings.sort((a, b) => branchRank(a) - branchRank(b));
  const branch = (task: TaskItem, depth = 0): TaskRow[] => [
    { task, depth }, ...(children.get(task.id) ?? []).flatMap(child => branch(child, depth + 1)),
  ];
  return (children.get("") ?? []).flatMap(task => branch(task));
}

/** Context review does not resolve a verified obligation; changed task facts withdraw it. */
export function humanDecision(state: NonNullable<Snapshot["taskPriorities"]>[string] | undefined): boolean {
  const advice = state?.recommendation;
  return !!state && !state.stale && advice?.nextActor === "human" && !!advice.humanReason?.trim() && !!advice.unblocks?.trim();
}
