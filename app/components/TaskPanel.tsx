"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { canParent } from "../lib/tasks";
import type { TaskRow, FocusDecision } from "../lib/tasks";
import type { Agent, TaskItem, TaskNote, TaskStatus, Snapshot } from "../lib/types";
import { clock } from "../lib/format";
import { Icon } from "./Icon";
import { TaskApproval } from "./TaskApproval";

const STATES: { value: TaskStatus; label: string }[] = [
  { value: "incomplete", label: "Incomplete" },
  { value: "done", label: "Done, for review" },
  { value: "complete", label: "Complete" },
  { value: "waiting_for_human", label: "Waiting for human" },
  { value: "blocked", label: "Blocked" },
];

/// Choosing one of these makes the agent rather than naming one.
const NEW_AGENT = "new-agent";
const FORK_AGENT = "fork-agent";

const STATE_COLOR: Record<TaskStatus, string> = {
  incomplete: "text-mid",
  done: "text-merge",
  complete: "text-ok",
  waiting_for_human: "text-hold",
  blocked: "text-[#a6493d]",
};

/** Native selection, with the full option tree present before its popup opens. */
function TaskSelect({ label, children, ...props }: Omit<ComponentProps<"select">, "children"> & { label: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <select {...props} onFocus={() => setOpen(true)}
    onPointerDown={() => flushSync(() => setOpen(true))} onBlur={() => setOpen(false)}>
    {open ? children() : <option value={props.value}>{label}</option>}
  </select>;
}

/** One task, and whether the keyboard is on it. */
function Row({
  focused,
  shown,
  children,
  depth,
  onContextMenu,
}: {
  depth: number;
  onContextMenu: (event: React.MouseEvent) => void;
  focused: boolean;
  /// Just filed, somewhere down a long list: bring it where it can be seen.
  shown: boolean;
  children: React.ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused || shown) row.current?.scrollIntoView({ block: "nearest" });
  }, [focused, shown]);
  return (
    <div
      ref={row}
      data-task-row
      onContextMenu={onContextMenu}
      style={{ paddingLeft: 17 + depth * 18 }}
      aria-current={focused ? "true" : undefined}
      className={`group flex items-start gap-3 border-b border-hair border-l-[3px] py-4 pr-5 pl-[17px] ${
        focused ? "border-l-ink bg-wash" : "border-l-transparent"
      }`}
    >
      {children}
    </div>
  );
}

/** Keep history and actions on the same line; expand notes only when asked. */
function TaskDetails({ notes, children }: { notes: TaskNote[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="mt-2 -mr-10 grid grid-cols-[minmax(0,1fr)_28px] items-start gap-x-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{children}</div>
      {notes.length > 0 && <button type="button" aria-label="Task history" aria-expanded={open} title={`Task history · ${notes.length}`} onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }} className={`flex h-7 w-7 cursor-pointer items-center justify-center text-faint hover:text-ink ${open ? "rotate-180" : ""}`}>
        <Icon name="chevronDown" size={14} />
      </button>}
    {open && <ul className="col-span-2 mt-2 flex flex-col gap-1 pr-10">
      {[...notes].reverse().map(note => <li key={note.id} className="break-words text-[11px] leading-[1.45] text-faint">
        <span className="tnum mr-2 text-[10px]">{clock(note.at)}</span>
        {note.text}
      </li>)}
    </ul>}
    </div>
  </>;
}

/** Keep drafts local so a keystroke never redraws the task list. */
function TaskEditor({ text, save }: { text: string; save: (text: string) => void }) {
  const resize = useCallback((node: HTMLTextAreaElement | null) => {
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
  }, []);
  return <textarea autoFocus rows={1} defaultValue={text} ref={resize}
    onChange={event => resize(event.currentTarget)}
    onBlur={event => save(event.currentTarget.value.trim())}
    onKeyDown={event => {
      if (event.key === "Escape") event.currentTarget.value = text;
      else if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      event.currentTarget.blur();
    }}
    className="w-full resize-none border-b border-edge bg-transparent text-[13px] leading-[1.45] outline-none" />;
}

function SubtaskEditor({ create }: { create: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  return <form onSubmit={async event => {
    event.preventDefault(); if (!draft.trim() || creating) return;
    setCreating(true);
    try { await create(draft.trim()); }
    finally { setCreating(false); }
  }} className="flex flex-col gap-2">
    <textarea autoFocus aria-label="Subtask" placeholder="What needs doing?" value={draft} onChange={event => setDraft(event.target.value)} className="min-h-16 w-full resize-y bg-transparent text-[12px] outline-none" />
    <button type="submit" disabled={creating || !draft.trim()} className="self-start cursor-pointer bg-ink px-2 py-1 text-[11px] text-paper disabled:opacity-40">Add subtask</button>
  </form>;
}

export const TaskPanel = memo(function TaskPanel({
  tasks,
  rows,
  priorities,
  decisions = false,
  decisionItems = [],
  onDecision,
  onReply,
  reviewingDecisions = false,
  onDecisions,
  query,
  scope,
  onScope,
  onSearch,
  notes,
  cursor,
  active,
  shown,
  graph,
  agents,
  named,
  busy,
  onUpdate,
  onApproveAll,
  onCreate,
  onHandOff,
  onCorrect,
  onOpenAgent,
  onDelete,
}: {
  tasks: TaskItem[];
  /// The rows on screen, in order; the keyboard counts these.
  rows: TaskRow[];
  query: string;
  scope?: string[];
  onScope: () => void;
  priorities?: Snapshot["taskPriorities"];
  decisions?: boolean;
  decisionItems?: FocusDecision[];
  onDecision?: (id:string)=>void;
  onReply?: (item:FocusDecision)=>void;
  reviewingDecisions?: boolean;
  onDecisions?: () => void;
  onSearch: (query: string) => void;
  /// Why each task is where it is, oldest first.
  notes: TaskNote[];
  cursor: number;
  active: boolean;
  /// A task just filed from a composer, to be scrolled to once.
  shown: string | null;
  /// Draw what is waiting on what, above the list.
  graph: boolean;
  /// The agents a task can be given to.
  agents: Pick<Agent, "id" | "name">[];
  /// Every agent, live or archived, for reading a name back.
  named: Pick<Agent, "id" | "name">[];
  busy: (id: string) => boolean;
  /// A status change carries why it changed, and only a person approves.
  onUpdate: (task: TaskItem, note?: string, approved?: boolean) => void;
  onApproveAll: (task: TaskItem) => void;
  onCreate: (text: string, parent: TaskItem) => Promise<boolean>;
  /// Move a task to an agent that does not exist yet.
  onHandOff: (task: TaskItem, fork: boolean) => void;
  /// Saying no to finished work: what is wrong goes to the agent.
  onCorrect: (task: TaskItem) => void;
  /// Reading a task means opening the session doing it.
  onOpenAgent: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", key); };
  }, [menu]);
  const menuTask = tasks.find(task => task.id === menu?.id);
  const [editing, setEditing] = useState<string | null>(null);
  /// A status waiting on its account of itself.
  const [pending, setPending] = useState<{ task: TaskItem; status: TaskStatus } | null>(null);
  // Names cover archived sessions so a task assigned to one still reads,
  // while only live agents can be chosen.
  const names = useMemo(() => new Map(named.map((agent) => [agent.id, agent.name])), [named]);
  const notesByTask = useMemo(() => {
    const grouped = new Map<string, TaskNote[]>();
    for (const note of notes) {
      const mine = grouped.get(note.taskId) ?? [];
      mine.push(note);
      grouped.set(note.taskId, mine);
    }
    return grouped;
  }, [notes]);
  const graphTasks = tasks.filter(task => task.status !== "complete" && (!scope || scope.includes(task.agentId)));
  const graphQuery = new URLSearchParams({ v: graphTasks.map(task => task.updatedAt).join("-"), ...(scope ? { agents: JSON.stringify(scope) } : {}) });
  // A flowchart of things that do not depend on each other is a list with
  // extra steps, so it is drawn only when asked for and only once something
  // is waiting on something.
  const linked = graph && graphTasks.some(
    (task) =>
      task.blockedByTaskId && graphTasks.some((other) => other.id === task.blockedByTaskId),
  );

  const row = (task: TaskItem, at: number, depth: number) => {
    const advice = priorities?.[task.id]?.recommendation;
    const mine = notesByTask.get(task.id) ?? [];
    const asking = pending?.task.id === task.id ? pending : null;
    return <Row key={task.id} depth={depth} onContextMenu={event => {
      if ((event.target as Element).closest("a[href]")) return;
      event.preventDefault(); setAdding(false);
      setMenu({ id: task.id, x: Math.min(event.clientX, window.innerWidth - 300), y: Math.min(event.clientY, window.innerHeight - 180) });
    }} focused={active && at === cursor} shown={task.id === shown}>
    <div className="min-w-0 flex-1">
      {editing === task.id ? (
        <TaskEditor text={task.text} save={text => {
          setEditing(null);
          if (text && text !== task.text) onUpdate({ ...task, text });
        }} />
      ) : (
        <button
          type="button"
          // A task is a piece of work someone is doing, so reading it means
          // reading the conversation it is being done in. Changing the words
          // is the rarer thing, and takes a second click.
          onClick={() => {
            if (task.agentId) onOpenAgent(task.agentId);
            else {
              setEditing(task.id);
            }
          }}
          onDoubleClick={() => {
            setEditing(task.id);
          }}
          data-task-open
          title={task.agentId ? `Open ${names.get(task.agentId) ?? "the session"}` : "Edit"}
          className="block w-full cursor-pointer text-left text-[13px] leading-[1.45] text-ink"
        >
          {task.text}
        </button>
      )}
      {advice && <p data-task-next-action className="mt-1 text-[11px] leading-[1.4] text-mid" title={advice.reason}>
        <span className="text-ink">{advice.nextActor === "human" ? "You: " : advice.nextActor === "other" ? "Waiting: " : "Next: "}{advice.nextAction}</span>{" · "}{advice.reason}
      </p>}
      {task.images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {task.images.map((image) => (
            ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(image.split(".").pop()?.toLowerCase() ?? "") ?
            /* eslint-disable-next-line @next/next/no-img-element */
            <img key={image} src={`/api/attachments/${encodeURIComponent(image)}`} alt="" className="max-h-28 rounded-[2px] border border-rule" /> :
            <a key={image} href={`/api/attachments/${encodeURIComponent(image)}`} target="_blank" rel="noreferrer" className="underline">
              {image}
            </a>
          ))}
        </div>
      )}
      {asking && (
        <input key={asking.status}
          autoFocus
          placeholder={`Why ${STATES.find((s) => s.value === asking.status)?.label.toLowerCase()}? A sentence or a commit`}
          onBlur={() => setPending(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") return setPending(null);
            if (event.key !== "Enter") return;
            const note = event.currentTarget.value.trim();
            if (!note) return;
            const status = asking.status;
            setPending(null);
            onUpdate(
              {
                ...task,
                status,
                blockedByTaskId:
                  status === "blocked" ? task.blockedByTaskId || tasks.find(candidate => candidate.id !== task.id)?.id || "" : "",
              },
              note,
              // Picking complete here is a person saying so, which is the
              // whole of what the rule asks for.
              status === "complete",
            );
          }}
          className="mt-2 w-full border-b border-edge bg-transparent py-1 text-[11.5px] outline-none placeholder:text-faint"
        />
      )}
      <TaskDetails notes={mine}>
        <select
          value={asking ? asking.status : task.status}
          disabled={busy(task.id)}
          aria-label={`status for ${task.text}`}
          onChange={(event) => {
            const status = event.target.value as TaskStatus;
            if (status === "complete") {
              setPending(null);
              onUpdate({ ...task, status, blockedByTaskId: "" }, "approved", true);
              return;
            }
            setPending({ task, status });
          }}
          className={`h-7 cursor-pointer bg-transparent text-[10.5px] outline-none ${STATE_COLOR[task.status]}`}
        >
          {STATES.map((state) => (
            <option key={state.value} value={state.value} disabled={state.value === "blocked" && tasks.length < 2}>
              {state.label}
            </option>
          ))}
        </select>
        {task.status === "blocked" && (
          <TaskSelect
            label={`blocked by ${tasks.find(candidate => candidate.id === task.blockedByTaskId)?.text ?? ""}`}
            value={task.blockedByTaskId}
            disabled={busy(task.id)}
            aria-label={`blocking task for ${task.text}`}
            onChange={(event) => onUpdate({ ...task, blockedByTaskId: event.target.value })}
            className="max-w-full cursor-pointer bg-transparent text-[10.5px] text-[#a6493d] outline-none"
          >
            {() => tasks.filter(candidate => candidate.id !== task.id).map(blocker => <option key={blocker.id} value={blocker.id}>blocked by {blocker.text}</option>)}
          </TaskSelect>
        )}
        <TaskSelect
          label={task.agentId ? `${names.get(task.agentId) ?? "a past session"}${agents.some(agent => agent.id === task.agentId) ? "" : " (archived)"}` : "Unassigned"}
          value={task.agentId}
          disabled={busy(task.id)}
          aria-label={`assign ${task.text}`}
          onChange={(event) => {
            const to = event.target.value;
            if (to === NEW_AGENT || to === FORK_AGENT) return onHandOff(task, to === FORK_AGENT);
            onUpdate({ ...task, agentId: to });
          }}
          className="max-w-full cursor-pointer bg-transparent text-[10.5px] text-faint outline-none"
        >
          {() => <>
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
          </>}
        </TaskSelect>
      {task.status === "done" && <>
        <TaskApproval task={task} busy={busy(task.id)}
          approve={() => onUpdate({ ...task, status: "complete" }, "approved", true)}
          approveAll={tasks.some(child => child.parentTaskId === task.id) ? () => onApproveAll(task) : undefined}
          correct={() => onCorrect(task)} />
      </>}
      </TaskDetails>
    </div>
    <button type="button" onClick={() => onDelete(task.id)} disabled={busy(task.id)} aria-label={`delete ${task.text}`} title="Delete task" className="flex h-7 w-7 cursor-pointer items-center justify-center text-faint opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-30">
      <Icon name="discard" size={14} />
    </button>
  </Row>;
  };

  return (
    <aside data-task-panel data-decisions={decisions || undefined} aria-label={decisions ? "Your decisions" : "Tasks"} className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-rule bg-card">
      {menu && menuTask && <div ref={menuRef} role="dialog" aria-label="Task options" className="fixed z-50 w-72 bg-paper p-3 shadow-lg ring-1 ring-rule" style={{ left: menu.x, top: menu.y }}>
        {adding ? <SubtaskEditor create={async text => {
          const saved = await onCreate(text, menuTask);
          if (saved) setMenu(null);
          return saved;
        }} /> : <>
          <button type="button" onClick={() => setAdding(true)} className="mb-3 block cursor-pointer text-[12px]">Add subtask</button>
          <label className="block text-[11px] text-mid">Parent task
            <select aria-label="Parent task" value={menuTask.parentTaskId ?? ""} disabled={busy(menuTask.id)} className="mt-1 w-full bg-paper text-[12px] text-ink" onChange={event => {
              onUpdate({ ...menuTask, parentTaskId: event.target.value }); setMenu(null);
            }}>
              <option value="">None</option>
              {tasks.filter(task => canParent(tasks, menuTask.id, task.id)).map(task => <option key={task.id} value={task.id}>{task.text}</option>)}
            </select>
          </label>
        </>}
      </div>}
      <div data-task-rail title="Drag the left edge to expand tasks" className="hidden h-[var(--bar)] shrink-0 items-center justify-center border-b border-rule text-faint"><Icon name="tasks" /></div>
      <div className="flex h-[var(--bar)] shrink-0 items-stretch border-b border-rule">
      {onDecisions && <button type="button" aria-label="All tasks" aria-pressed={!decisions} title={decisions ? "All tasks" : "Your decisions"} onClick={onDecisions} className="shrink-0 cursor-pointer px-3 text-faint hover:text-ink"><Icon name={decisions ? "tasks" : "ask"} size={14} /></button>}
      <input type="search" aria-label="Search tasks" placeholder={decisions ? "Your decisions" : "Search tasks"} value={query} onChange={event => onSearch(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); } }} className="min-w-0 flex-1 bg-transparent px-5 text-[12px] outline-none" />
      <button type="button" aria-label="Only open conversations" aria-pressed={scope !== undefined} title={scope ? "All tasks" : "Open conversations"} onClick={onScope}
        className={`shrink-0 cursor-pointer px-3 text-[11px] ${scope ? "bg-band text-ink" : "text-faint hover:text-ink"}`}><Icon name="scope" size={14} /></button>
      </div>
      <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto">
        {(decisions ? decisionItems.length : rows.length) === 0 ? (
          <p className="px-5 py-6 text-[12.5px] text-faint">
            {decisions ? query.trim() ? "No matching decisions." : scope ? "No decisions for open conversations." : reviewingDecisions ? "Checking updated decision evidence. Agents continue their work." : "No verified decision queued. Agents continue their work." : query.trim() ? "No matching tasks." : scope ? scope.length ? "No tasks for open conversations." : "No conversations open in this window." : <>No tasks yet. Type in a conversation and choose &ldquo;add to the task list&rdquo;, or press tab.</>}
          </p>
        ) : <>
          {!decisions && linked && <div className="border-b border-rule bg-paper p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/task-diagram.svg?${graphQuery}`}
              alt="Task dependency flowchart"
              className="max-h-[270px] w-full object-contain"
            />
          </div>}
          {decisions ? decisionItems.map((item,at)=><Row key={item.id} depth={0} focused={active&&at===cursor} shown={false} onContextMenu={()=>{}}>
            <div data-decision={item.id} className="min-w-0 flex-1">
              <button type="button" data-task-open data-decision-open title="Open decision card" onClick={()=>onDecision?.(item.id)} className="block w-full cursor-pointer text-left text-[13px] leading-[1.45] text-ink">{item.title}</button>
              <p data-task-next-action className="mt-1 text-[11px] leading-[1.4] text-mid" title={item.state.recommendation?.reason}>{item.state.recommendation?.humanReason} · Unblocks {item.state.recommendation?.unblocks}{item.state.needsReview&&<> · Checking latest context</>}</p>
              <button type="button" data-decision-reply onClick={()=>onReply?.(item)} className="mt-1 cursor-pointer text-[11px] text-mid hover:text-ink">Reply</button>
            </div>
          </Row>) : rows.map((entry, at) => row(entry.task, at, entry.depth))}
        </>}
      </div>
    </aside>
  );
});
