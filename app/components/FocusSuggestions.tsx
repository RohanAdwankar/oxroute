"use client";
import {memo} from "react";
import {ConversationChoices} from "./ConversationChoices";
import type {Agent,FocusData} from "../lib/types";
import {Icon} from "./Icon";
import {Markdown} from "./Markdown";
import {since} from "../lib/format";

export const FocusSuggestions = memo(function FocusSuggestions({item, preview, onOpen, onArchive, onSent}: {
  item: FocusData["suggestions"][number]; preview: string; onOpen: (id:string) => void; onArchive: (agent:Agent) => void; onSent: () => void;
}) {
  const {agent,nextActions} = item;
  return <li data-focus-suggestions={agent.id} onClick={event=>{if(!(event.target as Element).closest("a,button,input,textarea,select,[data-quote-thread]")&&!window.getSelection()?.toString())onOpen(agent.id);}} className="cursor-pointer border-t border-hair py-4" style={{contentVisibility:"auto",containIntrinsicSize:"auto 220px"}}>
    <div className="flex items-center gap-3 text-[11.5px] text-faint"><span>Suggested next steps</span><span>{since(agent.updatedAt)}</span>
      <div className="ml-auto flex items-center gap-3"><button type="button" onClick={()=>onArchive(agent)} className="cursor-pointer hover:text-ink" aria-label={`Archive ${agent.name}`} title="Archive conversation"><Icon name="archive" size={14}/></button>
      <button type="button" onClick={()=>onOpen(agent.id)} className="cursor-pointer hover:text-ink" aria-label={`Open ${agent.name}`} title="Open conversation"><Icon name="external" size={14}/></button></div></div>
    <button type="button" onClick={()=>onOpen(agent.id)} className="mt-1 cursor-pointer text-left text-[15px] font-medium">{agent.name}</button>
    {preview&&<div className="mt-2 line-clamp-4 text-[13px] text-mid"><Markdown>{preview}</Markdown></div>}
    <ConversationChoices agent={agent} nextActions={nextActions} onSent={onSent}/>
  </li>;
});
