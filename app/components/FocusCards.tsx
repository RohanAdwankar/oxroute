"use client";
import {useContext,useEffect,useRef,useState} from "react";
import {api} from "../lib/api";
import type {Agent,AgentView} from "../lib/types";
import type {FocusDecision} from "../lib/tasks";
import {ConversationCards,ConversationReferences,ConversationPublication} from "./FocusContext";
import {ConversationChoices} from "./ConversationChoices";
import {FocusReview} from "./FocusReview";
import {Icon} from "./Icon";
import {InlineReply} from "./InlineReply";
import {Markdown} from "./Markdown";
import {ConversationLink} from "./ConversationLink";
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
  const key=JSON.stringify(available);
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
  return <section data-focus-deck aria-label="Recommended conversations" className="my-2 min-w-0">
    <div className="mb-1 flex items-center justify-end gap-3 text-[12px] text-mid">
      <span role="status">{at+1} / {available.length}</span>
      <button type="button" aria-label="Previous card" title="Previous card" disabled={available.length<2} onClick={()=>setSelected(available[(at+available.length-1)%available.length])} className="cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
      <button type="button" aria-label="Next card" title="Next card" disabled={pending} aria-busy={pending} onClick={event=>void next(event.currentTarget)} className="rotate-180 cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
    </div>
    {error&&<p role="alert" className="mb-2 text-[12px] text-mid">{error}</p>}
    <div className={`relative ${available.length > 2 ? "mb-4 mr-4" : available.length > 1 ? "mb-2 mr-2" : ""}`}>
      {available.length>2&&<span aria-hidden className="pointer-events-none absolute inset-0 translate-x-4 translate-y-4 bg-band ring-1 ring-hair"/>}
      {available.length>1&&<span aria-hidden className="pointer-events-none absolute inset-0 translate-x-2 translate-y-2 bg-paper ring-1 ring-hair"/>}
      <ConversationCard key={agent.id} agent={agent}/>
    </div>
  </section>;
}

export function ConversationCard({agent,decision}:{agent:Agent;decision?:FocusDecision}) {
  const context=useContext(ConversationCards)!;
  const publication=useContext(ConversationPublication),before=publication? (publication.results?.[agent.id]??publication.before-1)+1:undefined;
  const evidence=decision?.state.recommendation?.evidenceEntryIds.join(',');
  const sourceRevision=publication||decision?0:agent.updatedAt;
  const sourceKey=`${agent.id}:${evidence??''}:${before??''}`;
  const [loaded,setLoaded]=useState<{source:string;view:Pick<AgentView,"timeline"|"nextActions">}|null>(null),[error,setError]=useState("");
  const view=loaded?.source===sourceKey?loaded.view:null;
  const [expanded,setExpanded]=useState(false),[revision,setRevision]=useState(0),[taskPage,setTaskPage]=useState(0);
  useEffect(()=>{let live=true;setError("");
    const load=evidence===undefined?api.agent(agent.id,before):api.citedEntries(evidence.split(',').map(Number)).then(async timeline=>({timeline,nextActions:(await api.agent(agent.id,0)).nextActions}));
    load.then(view=>{if(live)setLoaded({source:sourceKey,view});}).catch(error=>{if(live)setError(String(error));});return()=>{live=false;};},[agent.id,before,evidence,sourceKey,sourceRevision,revision]);
  const narrative=view?.timeline.findLast(entry=>entry.kind==="said");
  const text=narrative?.text??(publication||decision?"":context.state.messages[agent.id]??"");
  const review=view?.timeline.findLast(entry=>entry.kind==="review");
  const task=context.state.tasks.find(task=>task.id===decision?.taskId);
  const tasks=decision?(task?[task]:[]):context.state.tasks.filter(task=>task.agentId===agent.id&&(task.status==="done"||task.status==="waiting_for_human"));
  const nextActions=view?.nextActions;
  const page=Math.min(taskPage,Math.max(0,Math.ceil(tasks.length/3)-1)),start=page*3;
  const sent=()=>{setRevision(value=>value+1);context.onSent();};
  return <article data-focus-conversation={agent.id} aria-label={`Conversation ${agent.name}`} className="quiet-scroll relative max-h-[min(70vh,42rem)] min-w-0 overflow-y-auto bg-paper p-3 ring-1 ring-hair">
    <header className="mb-2 flex items-baseline justify-between gap-3"><h3 className="font-semibold"><ConversationLink id={agent.id} title="Open source conversation">{agent.name}</ConversationLink></h3><span className="text-[11px] text-mid">{decision?"Decision evidence":publication?"Published result":agent.status}</span></header>
    <div><ConversationCards.Provider value={null}><ConversationReferences.Provider value={null}>
      {decision?view?.timeline.map(entry=><div key={entry.id} data-decision-evidence={entry.id}><ConversationLink id={entry.agentId} entry={entry.id} title="Open decision evidence" className="text-[11px] text-mid">Source · {entry.kind==="you"?"You":entry.kind==="said"?"Reply":"Evidence"}</ConversationLink><Markdown>{[entry.text,entry.output].filter(Boolean).join('\n\n')}</Markdown></div>):text?<Markdown>{text}</Markdown>:<p className="text-[12px] text-mid">{publication?"No narrative result at publication.":agent.activity||"No reply yet."}</p>}
      {review&&!text.includes(review.detail)&&<FocusReview id={review.detail} initiallyExpanded={false}/>}
    </ConversationReferences.Provider></ConversationCards.Provider></div>
    {error&&<p role="alert" className="mt-2 flex items-center gap-2 text-[12px]">{error}<button type="button" aria-label="Retry card" title="Retry card" onClick={()=>setRevision(value=>value+1)}><Icon name="refresh"/></button></p>}
    {agent.status==="complete"&&context.state.nextActionSuggestions&&nextActions&&(!(decision||publication)||view?.timeline.some(entry=>entry.id===nextActions.entryId&&(decision||entry.id===narrative?.id)))&&<ConversationChoices key={nextActions.entryId} agent={agent} nextActions={nextActions} onSent={sent}/>}
    {!!tasks.length&&<section aria-label={`Tasks for ${agent.name}`}>
      {tasks.length>3&&<div className="mt-3 flex items-center justify-end gap-3 text-[12px] text-mid">
        <span role="status">Tasks {start+1}–{Math.min(start+3,tasks.length)} / {tasks.length}</span>
        <button type="button" aria-label="Previous tasks" title="Previous tasks" disabled={page===0} onClick={()=>setTaskPage(page-1)} className="cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
        <button type="button" aria-label="Next tasks" title="Next tasks" disabled={start+3>=tasks.length} onClick={()=>setTaskPage(page+1)} className="rotate-180 cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
      </div>}
      {tasks.slice(start,start+3).map(task=><TaskReference key={task.id} id={task.id} open={()=>context.onTask(task.id)}/>)}
    </section>}
    {(!(decision||publication)||view)&&<InlineReply key={evidence??before??agent.id} compact agent={agent} task={task} contextEntries={decision?view?.timeline:publication?(narrative?[narrative]:[]):undefined} expanded={expanded} onExpanded={setExpanded} onSent={sent}/>}
  </article>;
}
