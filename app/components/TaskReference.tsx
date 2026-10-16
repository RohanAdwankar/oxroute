import { createContext, useContext } from "react";
import type { TaskItem } from "../lib/types";
import { Icon } from "./Icon";
import { TaskApproval } from "./TaskApproval";

export const TaskActions = createContext<{
  tasks: TaskItem[]; busy: (id: string) => boolean;
  approve: (task: TaskItem) => void; correct: (task: TaskItem) => void;
} | null>(null);

export function TaskReference({ id, open }: { id: string; open: () => void }) {
  const actions = useContext(TaskActions);
  const task = actions?.tasks.find(task => task.id === id);
  if (!task || !actions) return null;
  return <span data-task-reference={id} className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 bg-band px-1.5 py-0.5 align-baseline text-[0.9em]">
    <button type="button" aria-label={`Task ${task.text}`} title="Open task" onClick={event => { event.stopPropagation(); open(); }}
      className="inline-flex min-w-0 cursor-pointer items-center gap-1 text-left text-ink hover:text-mid">
      <Icon name="tasks" size={12} />{task.text}
    </button>
    <span className="text-[11px] text-mid">{task.status === "complete" ? "Approved" : task.status === "done" ? "For review" : task.status.replaceAll("_", " ")}</span>
    <TaskApproval task={task} busy={actions.busy(id)} approve={() => actions.approve(task)} correct={() => actions.correct(task)} />
  </span>;
}
