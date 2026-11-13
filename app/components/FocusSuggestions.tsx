"use client";
import {memo, useRef, useState} from "react";
import {api} from "../lib/api";
import {useRecommendationExposure} from "../lib/recommendation-exposure";
import type {FocusData} from "../lib/types";
import {Icon} from "./Icon";
import {Markdown} from "./Markdown";
import {since} from "../lib/format";

export const FocusSuggestions = memo(function FocusSuggestions({item, preview, onOpen, onSent}: {
  item: FocusData["suggestions"][number]; preview: string; onOpen: (id:string) => void; onSent: () => void;
}) {
  const {agent,nextActions} = item;
  const element=useRef<HTMLLIElement>(null), request=useRef<{text:string;id:string} | null>(null);
  const [pending,setPending]=useState(false), [sent,setSent]=useState(false), [error,setError]=useState("");
  useRecommendationExposure(nextActions.recommendationId,element);
  const send=async(text:string)=>{
    if(pending||sent)return;
    if(request.current?.text!==text)request.current={text,id:crypto.randomUUID()};
    setPending(true);setError("");
    try{await api.say(agent.id,text,[],false,[],request.current.id);setSent(true);onSent();}
    catch(error){setError(error instanceof Error?error.message:String(error));}
    finally{setPending(false);}
  };
  return <li ref={element} data-focus-suggestions={agent.id} className="border-t border-hair py-4" style={{contentVisibility:"auto",containIntrinsicSize:"auto 220px"}}>
    <div className="flex items-center gap-3 text-[11.5px] text-faint"><span>Suggested next steps</span><span>{since(agent.updatedAt)}</span>
      <button type="button" onClick={()=>onOpen(agent.id)} className="ml-auto cursor-pointer hover:text-ink" aria-label={`Open ${agent.name}`} title="Open conversation"><Icon name="external" size={14}/></button></div>
    <p className="mt-1 text-[15px] font-medium">{agent.name}</p>
    {preview&&<div className="mt-2 line-clamp-4 text-[13px] text-mid"><Markdown>{preview}</Markdown></div>}
    {sent?<p role="status" className="mt-3 text-[12px] text-faint">Sent to conversation</p>:<section role="group" aria-label={`Suggested next steps for ${agent.name}`} className="next-choices">
      <div>{nextActions.actions.map(action=><button key={action.message} type="button" className="cursor-pointer text-left hover:bg-wash focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-40" disabled={pending} aria-label={action.label} title={action.message} onClick={()=>void send(action.message)}><span>{action.label}</span><span>{action.message}</span></button>)}</div>
    </section>}
    {error&&<p role="alert" className="mt-2 text-[12px] text-hold">{error}</p>}
  </li>;
});
