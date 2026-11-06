import type { Snapshot } from "./types";

/** Rank recorded human actions without inferring urgency from task prose. */
export function focusTasks(snapshot: Pick<Snapshot, "tasks" | "tags" | "taskNotes">) {
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
    return { task, note: notes.get(task.id), unblocks: linked.size - 1, priority: priority < 0 ? 4 : priority };
  });
  ranked.sort((a, b) => a.priority - b.priority || b.unblocks - a.unblocks ||
    Number(b.task.status === "waiting_for_human") - Number(a.task.status === "waiting_for_human") ||
    a.task.updatedAt - b.task.updatedAt || a.task.id.localeCompare(b.task.id));
  return { total: ranked.length, items: ranked.slice(0, 10) };
}

