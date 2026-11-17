"use client";
import {useContext,useState} from "react";
import {EmbeddedReviews,ConversationCards} from "./FocusContext";
import {GitReview} from "./GitReview";
import {Icon} from "./Icon";

export function FocusReview({id,initiallyExpanded=true}:{id:string;initiallyExpanded?:boolean}) {
  const context=useContext(EmbeddedReviews);
  const [expanded,setExpanded]=useState(initiallyExpanded),[revision,setRevision]=useState(id);
  const owner=context?.owners.get(id);
  if(!owner||!context)return null;
  return <section data-focus-review={id} aria-label={`Review from ${owner.name}`} className="my-3 min-w-0 bg-paper">
    <button type="button" aria-label={`${expanded?"Collapse":"Expand"} review from ${owner.name}`} aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)} className="flex w-full cursor-pointer items-center gap-2 py-2 text-left text-[12px] text-mid"><Icon name="diff"/>Change review · {owner.name}</button>
    {expanded&&<div className="flex h-[65vh] min-h-64 flex-col overflow-hidden"><ConversationCards.Provider value={null}><EmbeddedReviews.Provider value={null}><GitReview key={revision} agentId={owner.id} reviewId={revision} active onRevised={setRevision} onClose={()=>setExpanded(false)} onQuote={quote=>{context.quote(quote);setExpanded(false);}}/></EmbeddedReviews.Provider></ConversationCards.Provider></div>}
  </section>;
}
