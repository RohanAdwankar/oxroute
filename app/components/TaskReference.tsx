import { createContext, useContext } from "react";
import type { TaskItem } from "../lib/types";
import { Icon } from "./Icon";
import { TaskApproval } from "./TaskApproval";

export const TaskActions = createContext<{
  threads: Map<string, string>; openThread: (id: string) => void;
  tasks: TaskItem[]; busy: (id: string) => boolean;
  approve: (task: TaskItem) => void; correct: (task: TaskItem) => void;
} | null>(null);

/** The task's associated conversation, including archived threads. */
export function TaskThread({ task }: { task: TaskItem }) {
  const actions = useContext(TaskActions);
  if (!task.agentId || !actions) return null;
  const name = actions.threads.get(task.agentId) ?? "Thread";
  return <button type="button" data-task-thread={task.agentId} aria-label={`Open thread ${name}`} title={name}
    onClick={event => { event.stopPropagation(); actions.openThread(task.agentId); }}
    className="max-w-40 shrink-0 cursor-pointer truncate text-[10.5px] leading-[1.8] text-faint hover:text-ink">
    {name}
  </button>;
}

export function TaskReference({ id, open }: { id: string; open: () => void }) {
  const actions = useContext(TaskActions);
  const task = actions?.tasks.find(task => task.id === id);
  if (!task || !actions) return null;
  return <span data-task-reference={id} className="inline-flex max-w-full flex-col gap-1 bg-band px-1.5 py-1 align-baseline text-[0.9em]">
    <span className="flex min-w-0 items-start justify-between gap-3">
    <button type="button" aria-label={`Task ${task.text}`} title="Open task" onClick={event => { event.stopPropagation(); open(); }}
      className="inline-flex min-w-0 cursor-pointer items-center gap-1 text-left text-ink hover:text-mid">
      <Icon name="tasks" size={12} />{task.text}
    </button>
      <TaskThread task={task} />
    </span>
    <span className="flex flex-wrap items-center gap-2">
    <span className="text-[11px] text-mid">{task.status === "complete" ? "Approved" : task.status === "done" ? "For review" : task.status.replaceAll("_", " ")}</span>
    <TaskApproval task={task} busy={actions.busy(id)} approve={() => actions.approve(task)} correct={() => actions.correct(task)} />
    </span>
  </span>;
}
