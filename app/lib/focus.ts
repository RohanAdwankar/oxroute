import type { Snapshot } from "./types";

export type FocusSort = "recent" | "oldest" | "priority" | "unblocks";
export function focusOrder(a: {priority:number; unblocks:number; at:number; key:string; human:boolean}, b: typeof a, sort: FocusSort) {
  const order = sort === "priority" ? a.priority-b.priority || b.unblocks-a.unblocks || Number(b.human)-Number(a.human) || a.at-b.at
    : sort === "unblocks" ? b.unblocks-a.unblocks || b.at-a.at : sort === "oldest" ? a.at-b.at : b.at-a.at;
  return order || a.key.localeCompare(b.key);
}

/** Rank recorded human actions without inferring urgency from task prose. */
export function focusTasks(snapshot: Pick<Snapshot, "tasks" | "tags" | "taskNotes">, sort: FocusSort = "recent") {
  const dependents = new Map<string, string[]>();
  const notes = new Map<string, Snapshot["taskNotes"][number]>();
  for (const note of snapshot.taskNotes) {
    if (note.at >= (notes.get(note.taskId)?.at ?? -Infinity)) notes.set(note.taskId, note);
  }
  for (const task of snapshot.tasks) {
    if (task.status === "complete" || !task.blockedByTaskId) continue;
    dependents.set(task.blockedByTaskId, [...(dependents.get(task.blockedByTaskId) ?? []), task.id]);
  }
  const candidates = snapshot.tasks.filter(task => task.status === "waiting_for_human" || task.status === "done");
  const ranked = candidates.map(task => {
    const linked = new Set<string>([task.id]), pending = [...(dependents.get(task.id) ?? [])];
    while (pending.length) {
      const id = pending.pop()!;
      if (linked.has(id)) continue;
      linked.add(id); pending.push(...(dependents.get(id) ?? []));
    }
    const priority = ["p0", "p1", "p2", "p3"].findIndex(value => (snapshot.tags[task.agentId] ?? []).includes(`priority:${value}`));
    const note = notes.get(task.id);
    return {task, note, unblocks: linked.size-1, priority: priority < 0 ? 4 : priority, at: Math.max(task.updatedAt,note?.at ?? 0), key:task.id, human:task.status === "waiting_for_human"};
  });
  ranked.sort((a,b) => focusOrder(a,b,sort));
  return { total: ranked.length, items: ranked };
}

