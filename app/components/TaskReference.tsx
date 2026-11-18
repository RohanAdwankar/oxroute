import { createContext, useContext, useState } from "react";
import { api } from "../lib/api";
import { draftFor, keepDraft } from "../lib/drafts";
import type { TaskItem } from "../lib/types";
import { Icon } from "./Icon";
import { TaskApproval } from "./TaskApproval";

export const TaskActions = createContext<{
  tasks: TaskItem[]; embedded?: boolean; busy: (id: string) => boolean;
  approve: (task: TaskItem) => void; approveAll: (task: TaskItem) => void; correct: (task: TaskItem) => void;
} | null>(null);

export function TaskReference({ id, open }: { id: string; open: () => void }) {
  const actions = useContext(TaskActions);
  const task = actions?.tasks.find(task => task.id === id);
  const key=`task-correction:${id}`;
  const [draft,setDraft]=useState(()=>draftFor(key));
  const [editing,setEditing]=useState(!!draft);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  if (!task || !actions || task.status === "complete") return null;
  const change=(text:string)=>{setDraft(text);keepDraft(key,text);};
  const revise=async()=>{
    if(!draft.trim()||pending)return;
    setPending(true);setError("");
    try {await api.correctTask(id,draft.trim(),[],true);change("");setEditing(false);}
    catch(error){setError(error instanceof Error?error.message:String(error));}
    finally{setPending(false);}
  };
  return <span onKeyDown={event => { if (["Enter", " ", "Tab"].includes(event.key)) event.stopPropagation(); }} data-task-reference={id} data-task-card={actions.embedded?id:undefined} className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 bg-band px-1.5 py-0.5 align-baseline text-[0.9em]">
    <button type="button" aria-label={`Task ${task.text}`} title="Open task" onClick={event => { event.stopPropagation(); open(); }}
      className="inline-flex min-w-0 cursor-pointer items-center gap-1 text-left text-ink hover:text-mid">
      <Icon name="tasks" size={12} />{task.text}
    </button>
    <span className="text-[11px] text-mid">{task.status === "done" ? "For review" : task.status.replaceAll("_", " ")}</span>
    <TaskApproval task={task} busy={actions.busy(id)||pending} approve={() => actions.approve(task)} approveAll={actions.tasks.some(child => child.parentTaskId === id) ? () => actions.approveAll(task) : undefined} correct={() => actions.embedded?setEditing(value=>!value):actions.correct(task)} />
    {actions.embedded&&editing&&<span className="flex w-full flex-wrap items-end gap-2">
      <textarea aria-label={`Revision for ${task.text}`} placeholder="What should change?" value={draft} disabled={pending} rows={2} onChange={event=>change(event.target.value)} className="min-w-0 flex-1 resize-y border-b border-hair bg-transparent py-1 text-[13px] text-ink outline-none focus:border-mid"/>
      <button type="button" aria-label="Send revision" title="Send revision" disabled={pending||!draft.trim()} onClick={()=>void revise()} className="cursor-pointer p-2 text-mid hover:text-ink disabled:opacity-40"><Icon name="send"/></button>
      {error&&<span role="alert" className="w-full text-[12px]">{error}</span>}
    </span>}
  </span>;
}
