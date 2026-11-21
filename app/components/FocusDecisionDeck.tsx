"use client";
import {useContext} from "react";
import type {FocusDecision} from "../lib/tasks";
import {ConversationCards} from "./FocusContext";
import {ConversationCard} from "./FocusCards";
import {FocusReview} from "./FocusReview";
import {Icon} from "./Icon";

export function FocusDecisionDeck({items,selected,onSelect}:{items:FocusDecision[];selected:string;onSelect:(id:string|null)=>void}) {
  const context=useContext(ConversationCards);
  const at=Math.max(0,items.findIndex(item=>item.id===selected)),item=items[at];
  if(!item||!context)return null;
  const owner=[...context.state.agents,...context.state.archived].find(agent=>agent.id===item.agentId);
  return <section data-focus-decisions data-pane-active="true" aria-label="Decision cards" className="flex min-h-0 min-w-0 flex-1 flex-col max-sm:absolute max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-[var(--cell)] max-sm:z-40 max-sm:bg-card">
    <header className="flex h-[var(--bar)] shrink-0 items-center justify-end gap-3 border-b border-rule px-4 text-[12px] text-mid">
      <span className="mr-auto truncate">{item.title}</span><span role="status">{at+1} / {items.length}</span>
      <button type="button" aria-label="Previous decision" title="Previous decision" disabled={items.length<2} onClick={()=>onSelect(items[(at+items.length-1)%items.length].id)} className="cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
      <button type="button" aria-label="Next decision" title="Next decision" disabled={items.length<2} onClick={()=>onSelect(items[(at+1)%items.length].id)} className="rotate-180 cursor-pointer disabled:opacity-30"><Icon name="back"/></button>
      <button type="button" aria-label="Close decision" title="Close decision" onClick={()=>onSelect(null)} className="cursor-pointer"><Icon name="stop"/></button>
    </header>
    <div data-transcript className="quiet-scroll min-h-0 min-w-0 flex-1 overflow-auto px-[var(--pane-x)] py-3">
      {item.reviewId?<FocusReview key={item.reviewId} id={item.reviewId}/>:owner?<ConversationCard key={item.id} agent={owner} decision={item}/>:<p role="status">Conversation unavailable.</p>}
    </div>
  </section>;
}
