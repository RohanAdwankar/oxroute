"use client";

import { useMemo, useState } from "react";

import type { Agent, TaskItem } from "../lib/types";
import { Icon } from "./Icon";

export function TaskPanel({
  tasks,
  agents,
  currentAgent,
  busy,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: {
  tasks: TaskItem[];
  agents: Agent[];
  currentAgent: string | null;
  busy: boolean;
  onClose: () => void;
  onCreate: (text: string, agent: string) => void;
  onUpdate: (task: TaskItem) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const names = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const currentName = currentAgent ? names.get(currentAgent) ?? "this session" : "";
  const ordered = [...tasks].sort((a, b) => {
    const group = (task: TaskItem) =>
      currentAgent ? task.agentId === currentAgent ? 0 : task.agentId ? 2 : 1 : 0;
    return group(a) - group(b) || Number(a.done) - Number(b.done) || b.updatedAt - a.updatedAt;
  });

  const create = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onCreate(text, currentAgent ?? "");
    setDraft("");
  };

  return (
    <aside className="flex w-[min(430px,calc(100vw-32px))] shrink-0 flex-col border-l border-rule bg-card">
      <header className="flex h-[63px] shrink-0 items-center gap-3 border-b border-rule px-5">
        <Icon name="tasks" />
        <span className="text-[15px] font-semibold">Tasks</span>
        <span className="text-[11px] text-faint">{tasks.filter((task) => !task.done).length} open</span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="close tasks" title="Close tasks" className="flex h-8 w-8 cursor-pointer items-center justify-center text-faint hover:text-ink">
          <Icon name="collapse" />
        </button>
      </header>

      <div className="flex shrink-0 gap-2 border-b border-rule p-4">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") create();
          }}
          placeholder={currentAgent ? `Add task for ${currentName}` : "Add a task"}
          className="min-w-0 flex-1 border-b border-edge bg-transparent px-1 py-2 text-[13px] outline-none placeholder:text-faint"
        />
        <button type="button" onClick={create} disabled={busy || !draft.trim()} aria-label="add task" title="Add task" className="flex h-9 w-9 cursor-pointer items-center justify-center text-ink disabled:cursor-not-allowed disabled:opacity-30">
          <Icon name="plus" />
        </button>
      </div>

      <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto">
        {ordered.length === 0 ? (
          <p className="px-5 py-6 text-[12.5px] text-faint">No tasks yet.</p>
        ) : ordered.map((task) => (
          <div key={task.id} className="group flex items-start gap-3 border-b border-hair px-5 py-4">
            <input
              type="checkbox"
              checked={task.done}
              disabled={busy}
              aria-label={`mark ${task.text} ${task.done ? "open" : "done"}`}
              onChange={() => onUpdate({ ...task, done: !task.done })}
              className="mt-[3px] h-4 w-4 cursor-pointer accent-[#28231f]"
            />
            <div className="min-w-0 flex-1">
              {editing === task.id ? (
                <input
                  autoFocus
                  value={editDraft}
                  onChange={(event) => setEditDraft(event.target.value)}
                  onBlur={() => {
                    const text = editDraft.trim();
                    setEditing(null);
                    if (text && text !== task.text) onUpdate({ ...task, text });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      setEditDraft(task.text);
                      event.currentTarget.blur();
                    }
                  }}
                  className="w-full border-b border-edge bg-transparent text-[13px] outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(task.id);
                    setEditDraft(task.text);
                  }}
                  className={`block w-full cursor-text text-left text-[13px] leading-[1.45] ${task.done ? "text-faint line-through" : "text-ink"}`}
                >
                  {task.text}
                </button>
              )}
              <select
                value={task.agentId}
                disabled={busy}
                aria-label={`assign ${task.text}`}
                onChange={(event) => onUpdate({ ...task, agentId: event.target.value })}
                className="mt-2 max-w-full cursor-pointer bg-transparent text-[10.5px] text-faint outline-none"
              >
                <option value="">Unassigned</option>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </div>
            <button type="button" onClick={() => onDelete(task.id)} disabled={busy} aria-label={`delete ${task.text}`} title="Delete task" className="flex h-7 w-7 cursor-pointer items-center justify-center text-faint opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-30">
              <Icon name="discard" size={14} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
