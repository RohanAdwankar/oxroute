"use client";
import {useContext,useEffect,useRef,useState} from "react";
import {api} from "../lib/api";
import type {Agent,AgentView} from "../lib/types";
import {ConversationCards} from "./FocusContext";
import {ConversationChoices} from "./ConversationChoices";
import {FocusReview} from "./FocusReview";
import {Icon} from "./Icon";
import {InlineReply} from "./InlineReply";
import {Markdown} from "./Markdown";
import {TaskReference} from "./TaskReference";

export function FocusCards({ids}:{ids:string[]}) {
  const context=useContext(ConversationCards);
  const [selected,setSelected]=useState(ids[0]);
  const [pending,setPending]=useState(false),[error,setError]=useState("");
  const visited=useRef({key:"",ids:new Set<string>()});
  if(!context)return null;
  const agents=[...context.state.agents,...context.state.archived];
  const available=[...new Set(ids)].filter(id=>agents.some(agent=>agent.id===id));
  const at=Math.max(0,available.indexOf(selected)),agent=agents.find(agent=>agent.id===available[at]);
  if(!agent)return null;
  const key=available.join(",");
  if(visited.current.key!==key)visited.current={key,ids:new Set()};
  visited.current.ids.add(agent.id);
  const next=async(button:HTMLButtonElement)=>{
    const entry=Number(button.closest("[data-entry]")?.getAttribute("data-entry"));
    setSelected(available[(at+1)%available.length]);
    if(at!==available.length-1||!available.every(id=>visited.current.ids.has(id))||entry!==context.batchEntry||pending)return;
    setPending(true);setError("");
    try{await api.finishFocusBatch(entry,available);context.onSent();}
    catch(error){setError(error instanceof Error?error.message:String(error));}
    finally{setPending(false);}
  };
  return <section data-focus-deck aria-label="Recommended conversations" className="my-4 min-w-0">
    <div className="mb-2 flex items-center justify-end gap-3 text-[12px] text-mid">
      <span role="status">{at+1} / {available.length}</span>
      <button type="button" aria-label="Previous card" title="Previous card" disabled={available.length<2} onClick={()=>setSelected(available[(at+available.length-1)%available.length])} className="cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
      <button type="button" aria-label="Next card" title="Next card" disabled={pending} aria-busy={pending} onClick={event=>void next(event.currentTarget)} className="rotate-180 cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
    </div>
    {error&&<p role="alert" className="mb-2 text-[12px] text-mid">{error}</p>}
    <div className="relative mb-5 mr-4">
      {available.length>2&&<span aria-hidden className="pointer-events-none absolute inset-0 translate-x-4 translate-y-4 bg-band ring-1 ring-hair"/>}
      {available.length>1&&<span aria-hidden className="pointer-events-none absolute inset-0 translate-x-2 translate-y-2 bg-paper ring-1 ring-hair"/>}
      <ConversationCard key={agent.id} agent={agent}/>
    </div>
  </section>;
}

function ConversationCard({agent}:{agent:Agent}) {
  const context=useContext(ConversationCards)!;
  const [view,setView]=useState<AgentView|null>(null),[error,setError]=useState("");
  const [expanded,setExpanded]=useState(false),[revision,setRevision]=useState(0),[taskPage,setTaskPage]=useState(0);
  useEffect(()=>{let live=true;setError("");api.agent(agent.id).then(view=>{if(live)setView(view);}).catch(error=>{if(live)setError(String(error));});return()=>{live=false;};},[agent.id,agent.updatedAt,revision]);
  const text=view?.timeline.findLast(entry=>entry.kind==="said")?.text??context.state.messages[agent.id]??"";
  const review=view?.timeline.findLast(entry=>entry.kind==="review");
  const tasks=context.state.tasks.filter(task=>task.agentId===agent.id&&(task.status==="done"||task.status==="waiting_for_human"));
  const page=Math.min(taskPage,Math.max(0,Math.ceil(tasks.length/3)-1)),start=page*3;
  const sent=()=>{setRevision(value=>value+1);context.onSent();};
  return <article data-focus-conversation={agent.id} aria-label={`Conversation ${agent.name}`} className="quiet-scroll relative max-h-[min(70vh,42rem)] min-w-0 overflow-y-auto bg-paper p-4 ring-1 ring-hair">
    <header className="mb-3 flex items-baseline justify-between gap-3"><h3 className="font-semibold">{agent.name}</h3><span className="text-[11px] text-mid">{agent.status}</span></header>
    <div><ConversationCards.Provider value={null}>
      {text?<Markdown>{text}</Markdown>:<p className="text-[12px] text-mid">{agent.activity||"No reply yet."}</p>}
      {review&&!text.includes(review.detail)&&<FocusReview id={review.detail} initiallyExpanded={false}/>}
    </ConversationCards.Provider></div>
    {error&&<p role="alert" className="mt-2 flex items-center gap-2 text-[12px]">{error}<button type="button" aria-label="Retry card" title="Retry card" onClick={()=>setRevision(value=>value+1)}><Icon name="refresh"/></button></p>}
    {agent.status==="complete"&&context.state.nextActionSuggestions&&view?.nextActions&&<ConversationChoices key={view.nextActions.entryId} agent={agent} nextActions={view.nextActions} onSent={sent}/>}
    {!!tasks.length&&<section aria-label={`Tasks for ${agent.name}`}>
      {tasks.length>3&&<div className="mt-3 flex items-center justify-end gap-3 text-[12px] text-mid">
        <span role="status">Tasks {start+1}–{Math.min(start+3,tasks.length)} / {tasks.length}</span>
        <button type="button" aria-label="Previous tasks" title="Previous tasks" disabled={page===0} onClick={()=>setTaskPage(page-1)} className="cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
        <button type="button" aria-label="Next tasks" title="Next tasks" disabled={start+3>=tasks.length} onClick={()=>setTaskPage(page+1)} className="rotate-180 cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
      </div>}
      {tasks.slice(start,start+3).map(task=><TaskReference key={task.id} id={task.id} open={()=>context.onTask(task.id)}/>)}
    </section>}
    <InlineReply agent={agent} expanded={expanded} onExpanded={setExpanded} onSent={sent}/>
  </article>;
}
