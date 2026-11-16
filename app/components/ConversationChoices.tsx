"use client";
import {useRef,useState} from "react";
import {api} from "../lib/api";
import {useRecommendationExposure} from "../lib/recommendation-exposure";
import type {Agent,FocusData} from "../lib/types";

export function ConversationChoices({agent,nextActions,onSent}:{agent:Agent;nextActions:FocusData["suggestions"][number]["nextActions"];onSent:()=>void}) {
  const element=useRef<HTMLDivElement>(null),request=useRef<{text:string;id:string}|null>(null);
  const [pending,setPending]=useState(false),[sent,setSent]=useState(false),[error,setError]=useState("");
  useRecommendationExposure(nextActions.recommendationId,element);
  const send=async(text:string)=>{
    if(pending||sent)return;
    if(request.current?.text!==text)request.current={text,id:crypto.randomUUID()};
    setPending(true);setError("");
    try{await api.say(agent.id,text,[],false,[],request.current.id);setSent(true);onSent();}
    catch(error){setError(error instanceof Error?error.message:String(error));}
    finally{setPending(false);}
  };
  return <div ref={element}>
    {sent?<p role="status" className="mt-3 text-[12px] text-faint">Sent to conversation</p>:<section role="group" aria-label={`Suggested next steps for ${agent.name}`} className="next-choices">
      <div>{nextActions.actions.map(action=><button key={action.message} type="button" className="cursor-pointer text-left hover:bg-wash focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-40" disabled={pending} aria-label={action.label} title={action.message} onClick={()=>void send(action.message)}><span>{action.label}</span><span>{action.message}</span></button>)}</div>
    </section>}
    {error&&<p role="alert" className="mt-2 text-[12px] text-hold">{error}</p>}
  </div>;
}
