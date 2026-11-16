"use client";
import {useState} from "react";
import type {Agent,FocusData,TaskItem} from "../lib/types";
import {ConversationChoices} from "./ConversationChoices";
import {FocusReply} from "./FocusReply";
import {TaskApproval} from "./TaskApproval";

export function HomeActions({agent,nextActions,tasks,busy,onSent,onTask,onApprove,onCorrect}:{
  agent:Agent;nextActions?:FocusData["suggestions"][number]["nextActions"];tasks:TaskItem[];busy:(id:string)=>boolean;
  onSent:()=>void;onTask:(id:string)=>void;onApprove:(task:TaskItem)=>void;onCorrect:(task:TaskItem)=>void;
}) {
  const [expanded,setExpanded]=useState(false);
  return <div data-home-actions={agent.id} className="cursor-auto">
    {agent.status==="complete"&&nextActions&&<ConversationChoices key={nextActions.entryId} agent={agent} nextActions={nextActions} onSent={onSent}/>}
    {tasks.filter(task=>task.status==="done"||task.status==="waiting_for_human").map(task=><div key={task.id} className="mt-3 flex items-start justify-between gap-3 text-[12px]">
      <button type="button" onClick={()=>onTask(task.id)} className="cursor-pointer text-left hover:underline">{task.text}</button>
      {task.status==="done"&&<TaskApproval task={task} busy={busy(task.id)} approve={()=>onApprove(task)} correct={()=>onCorrect(task)}/>}
    </div>)}
    <FocusReply agent={agent} expanded={expanded} onExpanded={setExpanded} onSent={onSent}/>
  </div>;
}
