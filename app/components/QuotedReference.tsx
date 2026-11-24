"use client";
import {useEffect,useState,type MouseEvent} from 'react';
import {api} from '../lib/api';
import type {QuoteReference} from '../lib/drafts';
import {ConversationLink} from './ConversationLink';
import {Icon} from './Icon';

export function QuotedReference({reference,owner}:{reference:QuoteReference;owner?:{agentId:string;entryId:number}}){
  const [source,setSource]=useState<{agentId:string;entryId:number}|null>(null),[unavailable,setUnavailable]=useState(false);
  const key=JSON.stringify([reference,owner]);
  useEffect(()=>{
    let live=true;setSource(null);setUnavailable(false);
    if(!reference.evidenceEntryIds?.length){setUnavailable(true);return;}
    void api.citedEntries(reference.evidenceEntryIds??[]).then(entries=>{
      const context=reference.contextAgentId??owner?.agentId;
      const decisions=entries.filter(entry=>entry.agentId===context&&entry.publicationKind==='decision');
      const narratives=entries.filter(entry=>entry.agentId===reference.agentId&&entry.kind==='said');
      const entry=decisions.length===1?decisions[0]:decisions.length?undefined:narratives.length===1?narratives[0]:undefined;
      if(live){if(entry)setSource({agentId:entry.agentId,entryId:entry.id});else setUnavailable(true);}
    }).catch(()=>{if(live)setUnavailable(true);});
    return()=>{live=false;};
  },[key]);
  const remember=(event:MouseEvent)=>{
    if(!owner||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const url=new URL(window.location.href);url.searchParams.set('agent',owner.agentId);url.searchParams.set('entry',String(owner.entryId));window.history.replaceState(null,'',url);
  };
  const label='Quoted decision';
  const content=<><span className="flex items-center gap-2 text-[11px] text-mid">{label}<span className="rotate-180"><Icon name="back" size={12}/></span></span><span className="mt-1 block whitespace-normal break-words text-[12px] leading-snug [overflow-wrap:anywhere]">{reference.title}</span></>;
  const style='block min-w-0 max-w-[44rem] border-l-2 border-rule bg-band px-3 py-2 text-ink hover:bg-wash focus-visible:outline';
  return source?<ConversationLink id={source.agentId} entry={source.entryId} onClick={remember} aria-label={`Open quoted decision: ${reference.title}`} className={style}>{content}</ConversationLink>:<div className={style}>{content}<span role="status" className="text-[11px] text-mid">{unavailable?'Source context unavailable':'Loading source context…'}</span></div>;
}
