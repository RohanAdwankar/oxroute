"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { TaskRow } from "../lib/tasks";
import type { Agent, TaskItem, TaskNote, TaskStatus } from "../lib/types";
import { clock } from "../lib/format";
import { Icon } from "./Icon";

const STATES: { value: TaskStatus; label: string }[] = [
  { value: "incomplete", label: "Incomplete" },
  { value: "complete", label: "Complete" },
  { value: "waiting_for_human", label: "Waiting for human" },
  { value: "blocked", label: "Blocked" },
];

/// Choosing one of these makes the agent rather than naming one.
const NEW_AGENT = "new-agent";
const FORK_AGENT = "fork-agent";

const STATE_COLOR: Record<TaskStatus, string> = {
  incomplete: "text-mid",
  complete: "text-ok",
  waiting_for_human: "text-hold",
  blocked: "text-[#a6493d]",
};

/** One task, and whether the keyboard is on it. */
function Row({ focused, children }: { focused: boolean; children: React.ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) row.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  return (
    <div
      ref={row}
      data-task-row
      className={`group flex items-start gap-3 border-b border-hair border-l-[3px] py-4 pr-5 pl-[17px] ${
        focused ? "border-l-ink bg-wash" : "border-l-transparent"
      }`}
    >
      {children}
    </div>
  );
}

export function TaskPanel({
  tasks,
  rows,
  notes,
  onShowDone,
  cursor,
  active,
  agents,
  named,
  currentAgent,
  busy,
  onClose,
  onCreate,
  onUpdate,
  onHandOff,
  onDelete,
}: {
  tasks: TaskItem[];
  /// The rows on screen, in order; the keyboard counts these.
  rows: TaskRow[];
  /// Why each task is where it is, oldest first.
  notes: TaskNote[];
  onShowDone: () => void;
  cursor: number;
  active: boolean;
  /// The agents a task can be given to.
  agents: Agent[];
  /// Every agent, live or archived, for reading a name back.
  named: Agent[];
  currentAgent: string | null;
  busy: boolean;
  onClose: () => void;
  onCreate: (text: string, agent: string) => void;
  /// A status change carries why it changed.
  onUpdate: (task: TaskItem, note?: string) => void;
  /// Move a task to an agent that does not exist yet.
  onHandOff: (task: TaskItem, fork: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /// A status waiting on its account of itself.
  const [pending, setPending] = useState<{ task: TaskItem; status: TaskStatus } | null>(null);
  const [why, setWhy] = useState("");
  // Names cover archived sessions so a task assigned to one still reads,
  // while only live agents can be chosen.
  const names = useMemo(() => new Map(named.map((agent) => [agent.id, agent.name])), [named]);
  const currentName = currentAgent ? names.get(currentAgent) ?? "this session" : "";
  const graphVersion = tasks.map((task) => task.updatedAt).join("-");
  // A flowchart of things that do not depend on each other is a list with
  // extra steps, so it is drawn only once something is waiting on something.
  const linked = tasks.some(
    (task) =>
      task.blockedByTaskId && tasks.some((other) => other.id === task.blockedByTaskId),
  );

  const row = (task: TaskItem, at: number) => {
    const blockers = tasks.filter((candidate) => candidate.id !== task.id);
    const mine = notes.filter((note) => note.taskId === task.id);
    const asking = pending?.task.id === task.id ? pending : null;
    return <Row key={task.id} focused={active && at === cursor}>
    <span className={`mt-[6px] h-2 w-2 shrink-0 rounded-full bg-current ${STATE_COLOR[task.status]}`} />
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
          data-task-open
          className={`block w-full cursor-text text-left text-[13px] leading-[1.45] ${task.status === "complete" ? "text-faint line-through" : "text-ink"}`}
        >
          {task.text}
        </button>
      )}
      {task.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {task.images.map((image) => (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              key={image}
              src={`/api/attachments/${encodeURIComponent(image)}`}
              alt=""
              className="max-h-28 rounded-[2px] border border-rule"
            />
          ))}
        </div>
      )}
      {mine.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {mine.map((note) => (
            <li key={note.id} className="text-[11px] leading-[1.45] text-faint">
              <span className="tnum mr-2 text-[10px]">{clock(note.at)}</span>
              {note.text}
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <input
          autoFocus
          value={why}
          placeholder={`Why ${STATES.find((s) => s.value === asking.status)?.label.toLowerCase()}? A sentence or a commit`}
          onChange={(event) => setWhy(event.target.value)}
          onBlur={() => setPending(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") return setPending(null);
            if (event.key !== "Enter") return;
            const note = why.trim();
            if (!note) return;
            const status = asking.status;
            setPending(null);
            onUpdate(
              {
                ...task,
                status,
                blockedByTaskId:
                  status === "blocked" ? task.blockedByTaskId || blockers[0]?.id || "" : "",
              },
              note,
            );
          }}
          className="mt-2 w-full border-b border-edge bg-transparent py-1 text-[11.5px] outline-none placeholder:text-faint"
        />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <select
          value={asking ? asking.status : task.status}
          disabled={busy}
          aria-label={`status for ${task.text}`}
          onChange={(event) => {
            setWhy("");
            setPending({ task, status: event.target.value as TaskStatus });
          }}
          className={`cursor-pointer bg-transparent text-[10.5px] outline-none ${STATE_COLOR[task.status]}`}
        >
          {STATES.map((state) => (
            <option key={state.value} value={state.value} disabled={state.value === "blocked" && blockers.length === 0}>
              {state.label}
            </option>
          ))}
        </select>
        {task.status === "blocked" && (
          <select
            value={task.blockedByTaskId}
            disabled={busy}
            aria-label={`blocking task for ${task.text}`}
            onChange={(event) => onUpdate({ ...task, blockedByTaskId: event.target.value })}
            className="max-w-full cursor-pointer bg-transparent text-[10.5px] text-[#a6493d] outline-none"
          >
            {blockers.map((blocker) => <option key={blocker.id} value={blocker.id}>blocked by {blocker.text}</option>)}
          </select>
        )}
        <select
          value={task.agentId}
          disabled={busy}
          aria-label={`assign ${task.text}`}
          onChange={(event) => {
            const to = event.target.value;
            if (to === NEW_AGENT || to === FORK_AGENT) return onHandOff(task, to === FORK_AGENT);
            onUpdate({ ...task, agentId: to });
          }}
          className="max-w-full cursor-pointer bg-transparent text-[10.5px] text-faint outline-none"
        >
          <option value="">Unassigned</option>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          {/* A task outlives the session that had it, and a value with no
              option would read as unassigned and be lost on the next edit. */}
          {task.agentId && !agents.some((agent) => agent.id === task.agentId) && (
            <option value={task.agentId}>{names.get(task.agentId) ?? "a past session"} (archived)</option>
          )}
          {/* An agent that does not exist yet, made by choosing it. */}
          <option value={NEW_AGENT}>Start a new agent on this</option>
          {task.agentId && <option value={FORK_AGENT}>Fork {names.get(task.agentId) ?? "it"}</option>}
        </select>
      </div>
    </div>
    <button type="button" onClick={() => onDelete(task.id)} disabled={busy} aria-label={`delete ${task.text}`} title="Delete task" className="flex h-7 w-7 cursor-pointer items-center justify-center text-faint opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-30">
      <Icon name="discard" size={14} />
    </button>
  </Row>;
  };

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
        <span className="text-[11px] text-faint">{tasks.filter((task) => task.status !== "complete").length} open</span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} aria-label="close tasks" title="Close tasks" className="flex h-8 w-8 cursor-pointer items-center justify-center text-faint hover:text-ink">
          <Icon name="collapse" />
        </button>
      </header>

      <div className="flex shrink-0 gap-2 border-b border-rule p-4">
        <input
          data-task-input
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
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-[12.5px] text-faint">No tasks yet.</p>
        ) : <>
          {linked && <div className="border-b border-rule bg-paper p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/task-diagram.svg?v=${encodeURIComponent(graphVersion)}`}
              alt="Task dependency flowchart"
              className="max-h-[270px] w-full object-contain"
            />
          </div>}
          {rows.map((entry, at) =>
            entry.kind === "band" ? (
              <button
                key="done"
                type="button"
                onClick={onShowDone}
                className={`w-full cursor-pointer border-b border-rule bg-band px-5 py-2 text-left text-[11px] text-faint hover:text-ink ${
                  active && at === cursor ? "border-l-[3px] border-l-ink pl-[17px]" : ""
                }`}
              >
                Done · {entry.count}
              </button>
            ) : (
              row(entry.task, at)
            ),
          )}
        </>}
      </div>
    </aside>
  );
}
