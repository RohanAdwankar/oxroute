"use client";
import {useEffect,useState} from "react";
import type {Agent,FocusData,TaskItem} from "../lib/types";
import {ConversationChoices} from "./ConversationChoices";
import {InlineReply} from "./InlineReply";
import {TaskApproval} from "./TaskApproval";

export function HomeActions({agent,nextActions,tasks,busy,onSent,onTask,onApprove,onCorrect}:{
  agent:Agent;nextActions?:FocusData["suggestions"][number]["nextActions"];tasks:TaskItem[];busy:(id:string)=>boolean;
  onSent:()=>void;onTask:(id:string)=>void;onApprove:(task:TaskItem)=>void;onCorrect:(task:TaskItem)=>void;
}) {
  const [expanded,setExpanded]=useState(false);
  const [draftTasks,setDraftTasks]=useState<string[]>([]);
  useEffect(()=>{try{setDraftTasks(tasks.filter(task=>localStorage.getItem(`oxroute.taskReply.${task.id}`)).map(task=>task.id));}catch{}},[tasks]);
  return <div data-home-actions={agent.id} className="min-w-0 cursor-auto">
    {agent.status==="complete"&&nextActions&&<ConversationChoices key={nextActions.entryId} agent={agent} nextActions={nextActions} onSent={onSent}/>}
    {tasks.filter(task=>task.status==="done"||task.status==="waiting_for_human"||draftTasks.includes(task.id)).map(task=><div key={task.id} className="mt-3 text-[12px]"><div className="flex items-start justify-between gap-3">
      <button type="button" onClick={()=>onTask(task.id)} className="min-w-0 cursor-pointer break-words text-left hover:underline">{task.text}</button>
      {task.status==="done"&&<span className="shrink-0"><TaskApproval task={task} busy={busy(task.id)} approve={()=>onApprove(task)} correct={()=>onCorrect(task)}/></span>}
    </div>{draftTasks.includes(task.id)&&<TaskDraft task={task} agent={agent} onSent={()=>{setDraftTasks(current=>current.filter(id=>id!==task.id));onSent();}}/>}</div>)}
    <InlineReply agent={agent} expanded={expanded} onExpanded={setExpanded} onSent={onSent}/>
  </div>;
}

function TaskDraft({task,agent,onSent}:{task:TaskItem;agent:Agent;onSent:()=>void}) {
  const [expanded,setExpanded]=useState(false);
  return <div><p className="mt-2 text-faint">Unsent task reply</p><InlineReply task={task} agent={agent} expanded={expanded} onExpanded={setExpanded} onSent={onSent}/></div>;
}
