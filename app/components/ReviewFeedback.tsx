"use client";
import {useRef,useState} from "react";
import type {Review} from "../lib/reviews";
import {Icon} from "./Icon";

export function ReviewFeedback({review,endpoint,open,onClose,onSaved}:{review:Review;endpoint:string;open:boolean;onClose:()=>void;onSaved:(review:Review)=>void}) {
  const key=`oxroute.reviewFeedback.${review.id}.${review.snapshot.headCommit}`;
  const [text,setText]=useState(()=>{try{return localStorage.getItem(key)??'';}catch{return '';}});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef<{text:string;id:string}|null>(null);
  const change=(value:string)=>{setText(value);try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key);}catch{/* Keep editing in memory. */}};
  const send=async()=>{
    const reason=text.trim();if(!reason||busy)return;
    if(!request.current){try{request.current=JSON.parse(localStorage.getItem(key+'.request')??'null');}catch{/* Start a new request. */}}
    if(request.current?.text!==reason)request.current={text:reason,id:crypto.randomUUID()};
    try{localStorage.setItem(key+'.request',JSON.stringify(request.current));}catch{/* Retain the retry identity in memory. */}
    setBusy(true);setError('');
    try{
      const response=await fetch(endpoint+'/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:request.current.id,headCommit:review.snapshot.headCommit,reason})});
      const body=await response.json();if(!response.ok)throw new Error(body.error??'Could not save feedback');
      onSaved(body);change('');request.current=null;try{localStorage.removeItem(key+'.request');}catch{/* The saved feedback remains authoritative. */}onClose();
    }catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}
  };
  if(!open&&!review.feedback?.length)return null;
  return <section aria-label="Review feedback" className="shrink-0 border-b border-rule px-4 py-2 text-[12px]">
    {!!review.feedback?.length&&<div className="quiet-scroll max-h-32 overflow-auto">{review.feedback.map(item=><div key={item.requestId} data-review-feedback={item.requestId} className="mb-2"><span className="text-faint">Changes requested</span><p className="whitespace-pre-wrap">{item.reason}</p></div>)}</div>}
    {open&&<form aria-label="Request changes" onSubmit={event=>{event.preventDefault();void send();}}>
      <textarea autoFocus aria-label="Requested changes" placeholder="Describe the requested changes…" rows={2} value={text} disabled={busy} onChange={event=>change(event.target.value)} onContextMenu={event=>event.stopPropagation()}
        onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();void send();}}} className="w-full resize-y bg-transparent py-1 outline-none disabled:opacity-50"/>
      <div className="flex items-center justify-end gap-3">
        <button type="button" aria-label="Cancel feedback" title="Cancel feedback" disabled={busy} onClick={onClose} className="cursor-pointer disabled:opacity-40">×</button>
        <button type="submit" aria-label="Send feedback" title="Send feedback" disabled={busy||!text.trim()} className="cursor-pointer disabled:opacity-40"><Icon name="send"/></button>
      </div>
      {error&&<p role="alert" className="mt-1 text-mid">{error}</p>}
    </form>}
  </section>;
}
