"use client";

import { useMemo } from "react";
import { focusTasks } from "../lib/focus";
import { since } from "../lib/format";
import type { Snapshot, TaskItem } from "../lib/types";
import { TaskApproval } from "./TaskApproval";

export function Focus({ snapshot, busy, onOpenTask, onOpenAgent, onApprove, onCorrect }: {
  snapshot: Snapshot;
  busy: (id: string) => boolean;
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onApprove: (task: TaskItem) => void;
  onCorrect: (task: TaskItem) => void;
}) {
  const { items, total } = useMemo(() => focusTasks(snapshot), [snapshot]);
  const agents = new Map([...snapshot.agents, ...snapshot.archived].map(agent => [agent.id, agent]));
  return <section aria-label="Focus" className="quiet-scroll min-h-0 min-w-0 flex-1 overflow-auto">
    <div className="mx-auto max-w-5xl px-[var(--pane-x)] py-6">
      <h1 className="text-[20px] font-medium text-ink">Focus</h1>
      <p className="mt-1 text-[13px] text-mid">{total ? `${Math.min(total, 10)} of ${total} tasks needing your action` : "Nothing needs your action right now."}</p>
      <p className="mt-2 text-[11.5px] text-faint">Ordered by priority tags, work unblocked, human blockers, then waiting time. Work in progress stays in the task list.</p>
      <ol className="mt-5">
        {items.map(({ task, note, priority, unblocks }, index) => <li key={task.id} data-focus-task={task.id} className="flex gap-4 border-t border-hair py-4">
          <span className="tnum w-5 shrink-0 pt-1 text-[12px] text-faint">{index + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11.5px] text-faint">
              <span className="text-mid">{task.status === "done" ? "Review result" : "Decision or access needed"}</span>
              {priority < 4 && <span>priority p{priority}</span>}
              {unblocks > 0 && <span>unblocks {unblocks} {unblocks === 1 ? "task" : "tasks"}</span>}
              <span>waiting {since(task.updatedAt)}</span>
              <span>{agents.get(task.agentId)?.name ?? (task.agentId ? "Session unavailable" : "Unassigned")}{snapshot.archived.some(agent => agent.id === task.agentId) ? " · archived" : ""}</span>
            </div>
            <button type="button" title={task.text} onClick={() => onOpenTask(task.id)} className="mt-1 line-clamp-2 cursor-pointer text-left text-[15px] font-medium text-ink hover:underline">{task.text}</button>
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-mid">{note?.text || (task.status === "done" ? "Review the result, then approve it or send a correction." : "The agent has requested human input. Open the conversation for context.")}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {task.status === "done" && <TaskApproval task={task} busy={busy(task.id)} approve={() => onApprove(task)} correct={() => onCorrect(task)} />}
              {agents.has(task.agentId) && <button type="button" className="cursor-pointer text-[11.5px] text-mid hover:text-ink hover:underline" onClick={() => onOpenAgent(task.agentId)}>Open conversation</button>}
            </div>
          </div>
        </li>)}
      </ol>
    </div>
  </section>;
}
