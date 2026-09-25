import type { TaskItem } from "./types";

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
