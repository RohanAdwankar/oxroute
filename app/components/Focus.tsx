"use client";

import {memo, useCallback, useEffect, useMemo, useState} from "react";
import {focusOrder, focusTasks, type FocusSort} from "../lib/focus";
import {api} from "../lib/api";
import {since} from "../lib/format";
import type {Agent, FocusData, Snapshot, TaskItem} from "../lib/types";
import {TaskApproval} from "./TaskApproval";
import {FocusReply} from "./FocusReply";
import {FocusSuggestions} from "./FocusSuggestions";
import {Icon} from "./Icon";

type TaskRow = ReturnType<typeof focusTasks>["items"][number];
type Actions = {onOpenTask:(id:string)=>void; onOpenAgent:(id:string)=>void; onApprove:(task:TaskItem)=>void; onCorrect:(task:TaskItem)=>void};
const TaskCard=memo(function TaskCard({item,agent,archived,pending,onFollow,...actions}: Actions & {item:TaskRow;agent?:Agent;archived:boolean;pending:boolean;onFollow:(id:string)=>void}) {
  const {task,note,priority,unblocks}=item;
  return <li data-focus-task={task.id} className="flex gap-4 border-t border-hair py-4" style={{contentVisibility:"auto",containIntrinsicSize:"auto 240px"}}>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11.5px] text-faint">
        <span className="text-mid">{task.status==="done"?"Review result":task.status==="waiting_for_human"?"Decision or access needed":"Following up"}</span>
        {priority<4&&<span>priority p{priority}</span>}{unblocks>0&&<span>unblocks {unblocks} {unblocks===1?"task":"tasks"}</span>}
        <span>active {since(item.at)}</span><span>{agent?.name??(task.agentId?"Session unavailable":"Unassigned")}{archived?" · archived":""}</span>
      </div>
      <button type="button" title={task.text} onClick={()=>actions.onOpenTask(task.id)} className="mt-1 line-clamp-2 cursor-pointer text-left text-[15px] font-medium text-ink hover:underline">{task.text}</button>
      <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-mid">{note?.text||(task.status==="done"?"Review the result, then approve it or send a correction.":"Reply below to continue working with the agent.")}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {task.status==="done"&&<TaskApproval task={task} busy={pending} approve={()=>actions.onApprove(task)} correct={()=>actions.onCorrect(task)}/>}
        {agent&&<button type="button" title="Open conversation" aria-label="Open conversation" className="cursor-pointer text-mid hover:text-ink" onClick={()=>actions.onOpenAgent(task.agentId)}><Icon name="external"/></button>}
      </div>
      {agent&&<FocusReply task={task} agent={agent} onSent={()=>onFollow(task.id)}/>}
    </div>
  </li>;
});

export function Focus({snapshot,busy,...actions}: Actions & {snapshot:Snapshot;busy:(id:string)=>boolean}) {
  const [sort,setSort]=useState<FocusSort>(()=>{try{const value=localStorage.getItem("oxroute.focusSort");if(["recent","oldest","priority","unblocks"].includes(value??""))return value as FocusSort;}catch{}return "recent";});
  const {items:ranked,total}=useMemo(()=>focusTasks(snapshot,sort),[snapshot.tasks,snapshot.tags,snapshot.taskNotes,sort]);
  const [following,setFollowing]=useState<string[]>(()=>{try{return JSON.parse(sessionStorage.getItem("oxroute.focusFollowing")??"[]");}catch{return [];}});
  const follow=useCallback((id:string)=>setFollowing(current=>{const next=[...current.filter(task=>task!==id),id];try{sessionStorage.setItem("oxroute.focusFollowing",JSON.stringify(next));}catch{}return next;}),[]);
  const [data,setData]=useState<FocusData>({suggestions:[],feedback:{}}),[error,setError]=useState(""),[revision,setRevision]=useState(0);
  const refresh=useCallback(()=>setRevision(value=>value+1),[]);
  const requestKey=JSON.stringify([snapshot.agents.map(agent=>[agent.id,agent.status,agent.updatedAt]),snapshot.nextActionSuggestions,snapshot.tasks.map(task=>[task.id,task.updatedAt])]);
  useEffect(()=>{const controller=new AbortController();api.focus(controller.signal).then(value=>{setData(value);setError("");}).catch(error=>{if(!controller.signal.aborted)setError(String(error));});return()=>controller.abort();},[requestKey,revision]);
  const agents=useMemo(()=>new Map([...snapshot.agents,...snapshot.archived].map(agent=>[agent.id,agent])),[snapshot.agents,snapshot.archived]);
  const queue=useMemo(()=>[
    ...ranked.map(task=>({...task,task,suggestion:null})),
    ...data.suggestions.filter(item=>snapshot.agents.some(agent=>agent.id===item.agent.id&&agent.status==="complete"&&agent.updatedAt===item.agent.updatedAt)).map(suggestion=>{const priority=["p0","p1","p2","p3"].findIndex(p=>(snapshot.tags[suggestion.agent.id]??[]).includes(`priority:${p}`));return {key:`suggestion:${suggestion.agent.id}:${suggestion.nextActions.entryId}`,at:suggestion.agent.updatedAt,priority:priority<0?4:priority,unblocks:0,human:false,task:null,suggestion};}),
  ].sort((a,b)=>focusOrder(a,b,sort)),[ranked,data.suggestions,snapshot.agents,snapshot.tags,sort]);
  const card=(item:TaskRow)=><TaskCard key={item.key} item={item} agent={agents.get(item.task.agentId)} archived={snapshot.archived.some(agent=>agent.id===item.task.agentId)} pending={busy(item.task.id)} onFollow={follow} {...actions}/>;
  const ongoing=snapshot.tasks.filter(task=>following.includes(task.id)&&task.status!=="complete"&&!ranked.some(item=>item.task.id===task.id)).map(task=>({task,note:snapshot.taskNotes.filter(note=>note.taskId===task.id).at(-1),key:task.id,at:task.updatedAt,priority:4,unblocks:0,human:false}));
  return <section aria-label="Focus" className="quiet-scroll min-h-0 min-w-0 flex-1 overflow-auto">
    <div className="mx-auto max-w-5xl px-[var(--pane-x)] py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-mid">
        <p>{total||queue.length?`${total} tasks needing your action${data.suggestions.length?` · ${data.suggestions.length} conversations with suggestions`:""}`:"Nothing needs your action right now."}</p>
        <select aria-label="Sort attention queue" value={sort} onChange={event=>{const value=event.target.value as FocusSort;setSort(value);try{localStorage.setItem("oxroute.focusSort",value);}catch{}}} className="cursor-pointer bg-transparent text-[12px] outline-none">
          <option value="recent">Recently active</option><option value="oldest">Waiting longest</option><option value="priority">Priority</option><option value="unblocks">Work unblocked</option>
        </select>
      </div>
      {Object.values(data.feedback).some(item=>item.decisions>0)&&<p aria-label="Recommendation feedback" title="Matches among recorded choices after recommendations were shown; untouched suggestions are excluded." className="mt-2 text-[11.5px] text-faint">{[["next-actions","Next actions"],["input-routing","Routing"]].flatMap(([key,label])=>{const item=data.feedback[key];return item?.decisions?[`${label}: ${item.matched}/${item.decisions} choices matched`]:[];}).join(" · ")}</p>}
      {snapshot.taskNotesDeferred&&<p role="status" className="mt-2 text-[11.5px] text-faint">Loading task history…</p>}
      {error&&<button type="button" onClick={refresh} aria-label="Retry suggestions" className="mt-2 cursor-pointer text-hold" title={error}><Icon name="refresh" size={14}/></button>}
      <ol className="mt-5">{queue.map(item=>item.task?card(item.task):<FocusSuggestions key={item.key} item={item.suggestion!} preview={snapshot.messages[item.suggestion!.agent.id]??""} onOpen={actions.onOpenAgent} onSent={refresh}/>)}</ol>
      {ongoing.length>0&&<section aria-label="Following up" className="mt-6"><h2 className="mb-3 text-[13px] text-mid">Following up</h2><ol>{ongoing.map(card)}</ol></section>}
    </div>
  </section>;
}
