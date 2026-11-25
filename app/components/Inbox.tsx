"use client";

import { Fragment, useEffect, useRef, useState } from "react";

import { clip, clock } from "../lib/format";
import {attention, type InboxRow} from "../lib/inbox";
import type { Agent, InboxItem } from "../lib/types";
import { Icon } from "./Icon";

/**
 * The sidebar, and the whole point of the interface.
 *
 * Two groups: what is waiting on a decision, and what has already been
 * settled. An item is one decision, so the list never grows a second kind of
 * control -- you open it, and the main column asks where it goes.
 */
export function Inbox({
  items,
  connectors,
  rows,
  onShowDone,
  agents,
  selected,
  onSelect,
  onAction,
  onClear,
  busy,
  waitingCount,
  cursor,
  active,
  onCollapse,
}: {
  items: InboxItem[];
  connectors?: {source: string; configured: boolean; lastSync: number | null; error: string | null;partial?:boolean}[];
  /// The column as it is drawn; the cursor counts these.
  rows: InboxRow[];
  onShowDone: () => void;
  agents: Agent[];
  selected: string | null;
  onSelect: (item: InboxItem) => void;
  onAction:(item:InboxItem,action:string,draft?:string)=>Promise<NonNullable<InboxItem["review"]>>;
  onClear: () => void;
  waitingCount?: number;
  busy: boolean;
  /// Which row the keyboard is on, as an index into `rows`.
  cursor: number;
  /// True when the keyboard is driving this column.
  active: boolean;
  onCollapse: () => void;
}) {
  const waiting = waitingCount ?? items.filter(item=>attention(item)==="response_needed").length;
  const unreviewed=items.filter(item=>attention(item)==="unreviewed").length;
  const name = (id: string) => agents.find((a) => a.id === id)?.name || "Existing conversation";

  return (
    <aside className="flex h-full w-full flex-col bg-card">
      <div className="flex min-w-0 h-[var(--bar)] shrink-0 items-center border-b border-rule px-[18px]">
        <span className="text-[14px] font-semibold">Inbox</span>
        <span className="min-w-1 flex-1" />
        <span className="text-[11.5px] text-faint">
          {waiting ? `${waiting} waiting` : unreviewed ? `${unreviewed} to review` : "all clear"}
        </span>
        <button type="button" onClick={onClear} disabled={busy || !items.some(item=>item.state==="waiting")} aria-label="Clear all inbox arrivals" title="Clear all" className="ml-3 cursor-pointer text-faint hover:text-ink disabled:cursor-default disabled:opacity-30"><Icon name="discard" size={14} /></button>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="collapse inbox"
          title="collapse inbox"
          className="ml-3 cursor-pointer text-[18px] leading-none text-faint hover:text-ink"
        >
          <Icon name="collapse" size={18} />
        </button>
      </div>

      <div className="quiet-scroll min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        {items.length === 0 && (
          <p className="px-[18px] py-6 text-[11.5px] text-faint">
            New incoming messages and direct mentions appear here.
          </p>
        )}

        {rows.map((row, index) =>
          row.kind === "band" ? (
            <Band
              key="done"
              label={`Handled · ${row.count}`}
              focused={active && index === cursor}
              onClick={onShowDone}
            />
          ) : (
            <Fragment key={row.item.signal.id}>
              {(index===0||rows[index-1].kind!=="item"||attention((rows[index-1] as {kind:"item";item:InboxItem}).item)!==attention(row.item))&&<Band label={attention(row.item)==="response_needed"?"Waiting on you":attention(row.item)==="unreviewed"?"To review":"Handled"} strong/>}
              <Row
                item={row.item}
                selected={selected === row.item.signal.id}
                focused={active && index === cursor}
                onSelect={onSelect}
                onAction={onAction}
                busy={busy}
                targetAvailable={Boolean(row.item.suggested&&agents.some(agent=>agent.id===row.item.suggested))}
                name={name}
              />
            </Fragment>
          ),
        )}
      </div>
      {connectors?.filter(source => source.configured).map(source => <div key={source.source} className="px-[18px] py-1 text-[11px] text-faint" title={source.error ?? "Read-only; waiting for your routing decision"}>
        {source.source === "outlook-inbox" ? "Outlook" : "Slack"} · {source.error ? ((source as {partial?:boolean}).partial ? "partial sync" : "sync interrupted") : source.lastSync ? "synced" : "loading"}
      </div>)}
    </aside>
  );
}

function Band({
  label,
  strong,
  focused,
  onClick,
}: {
  label: string;
  strong?: boolean;
  focused?: boolean;
  onClick?: () => void;
}) {
  const skin = `w-full border-y border-rule bg-band px-[18px] py-2 text-left first:border-t-0 ${
    focused ? "border-l-[3px] border-l-ink pl-[15px]" : ""
  }`;
  const text = `text-[11px] ${strong ? "text-ink" : "text-faint"}`;
  if (!onClick) {
    return (
      <div className={skin}>
        <span className={text}>{label}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title="Show or hide what is settled"
      className={`${skin} cursor-pointer hover:text-ink`}
    >
      <span className={text}>{label}</span>
    </button>
  );
}

function Row({item,selected,focused,onSelect,onAction,busy,targetAvailable,name}: {
  item:InboxItem;selected:boolean;focused:boolean;busy:boolean;targetAvailable:boolean;
  onSelect:(item:InboxItem)=>void;
  onAction:(item:InboxItem,action:string,draft?:string)=>Promise<NonNullable<InboxItem["review"]>>;
  name:(id:string)=>string;
}) {
  const waiting=item.state==="waiting",status=attention(item),{signal}=item;
  const row=useRef<HTMLDivElement>(null),dirty=useRef(false);
  const [pending,setPending]=useState(false),[error,setError]=useState("");
  const [draft,setDraft]=useState(item.review?.draft??""),[draftOpen,setDraftOpen]=useState(Boolean(item.review?.draft));
  useEffect(()=>{if(focused)row.current?.scrollIntoView({block:"nearest"});},[focused]);
  useEffect(()=>{
    const local=localStorage.getItem(`oxroute.inboxDraft:${signal.id}`);
    if(local!==null){setDraft(local);setDraftOpen(true);dirty.current=local!==(item.review?.draft??"");}
  },[signal.id]);
  useEffect(()=>{if(!dirty.current&&item.review?.draft!=null){setDraft(item.review.draft);setDraftOpen(true);localStorage.setItem(`oxroute.inboxDraft:${signal.id}`,item.review.draft);}},[item.review?.draft,signal.id]);
  const act=async(action:string,text?:string)=>{
    setPending(true);setError("");
    try{const result=await onAction(item,action,text);if(action==="draft"||action==="save_draft"){dirty.current=false;if(result.draft!=null){setDraft(result.draft);localStorage.setItem(`oxroute.inboxDraft:${signal.id}`,result.draft);}}}
    catch(error){setError(error instanceof Error?error.message:"Could not update Inbox item");}
    finally{setPending(false);}
  };
  const footer=status==="resolved"?"Resolved":status==="answered"?"Answered in source":status==="no_response_needed"?"No response needed":waiting?item.suggested?`→ ${name(item.suggested)}`:item.recommendation?.action==="spawn"?"→ New agent":item.recommendation?.action==="discard"?"→ Dismiss":"not routed yet":item.outcome||"done";
  const canRoute=waiting&&targetAvailable;
  const disabled=busy||pending;
  const actionClass="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-faint hover:text-ink disabled:cursor-default disabled:opacity-30";
  return <div ref={row} data-inbox-item aria-current={selected||focused} className={["group min-w-0 w-full border-b border-hair border-l-[3px] py-[13px] pr-[18px] pl-[15px]",selected?"border-l-ink bg-wash":focused?"border-l-edge bg-wash/60":"border-l-transparent hover:bg-paper"].join(" ")}>
    <button type="button" onClick={()=>onSelect(item)} aria-label="Open Inbox item" className="flex min-w-0 w-full cursor-pointer flex-col gap-[5px] text-left">
      <span className="flex min-w-0 max-w-full items-center gap-[7px]">
        <time dateTime={new Date(signal.at*1000).toISOString()} title={new Date(signal.at*1000).toLocaleString()} className="shrink-0 tnum text-[9.5px] text-faint">{new Date(signal.at*1000).toDateString()===new Date().toDateString()?clock(signal.at):new Date(signal.at*1000).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</time>
        <span className="shrink-0 tnum border border-rule px-[5px] text-[9.5px] text-mid">{signal.source==="outlook-inbox"?"Outlook":signal.source==="slack-inbox"?"Slack":signal.source}</span>
        {(item.display?.label??signal.label)&&<span title={item.display?.label??signal.label} className="min-w-0 truncate tnum text-[9.5px] text-faint">{item.display?.label??signal.label}</span>}
      </span>
      <span className={`min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-[11.5px] leading-[1.4] ${waiting?"text-ink":"text-faint"}`}>{signal.text?clip(item.display?.preview??signal.text,130):`${signal.attachments.length} attachment(s)`}</span>
    </button>
    <div className="mt-1 flex min-w-0 items-center gap-1">
      <button type="button" onClick={()=>onSelect(item)} title={item.suggested?`Suggested destination: ${name(item.suggested)}. Open routing options.`:item.review?.reason||item.recommendation?.reason||"Open routing options"} className={`min-w-0 flex-1 cursor-pointer truncate text-left tnum text-[10px] ${waiting&&["response_needed","unreviewed"].includes(status)?"text-hold":"text-faint"}`}>{footer}</button>
      <div className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <button type="button" disabled={disabled||!canRoute} onClick={()=>void act("route")} aria-label={canRoute?`Route to ${name(item.suggested!)}`:"Route to suggested conversation"} title={canRoute?`Route to ${name(item.suggested!)}`:"Choose an existing conversation"} className={actionClass}><Icon name="send" size={13}/></button>
        <button type="button" disabled={disabled} onClick={()=>{setDraftOpen(true);void act("draft");}} aria-label={draft?"Regenerate inline response":"Generate inline response"} title="Draft a response here" className={actionClass}><Icon name="refresh" size={13}/></button>
        <button type="button" disabled={disabled} onClick={()=>void act(status==="resolved"?"reopen":"resolve")} aria-label={status==="resolved"?"Review again":"Mark resolved"} title={status==="resolved"?"Review again":"Mark resolved"} className={actionClass}><Icon name={status==="resolved"?"restore":"tick"} size={13}/></button>
      </div>
    </div>
    {draftOpen&&item.review?.draftContextRevision!=null&&item.review.draftContextRevision!==item.contextRevision&&<p className="mt-1 text-[10px] text-faint">Draft from earlier context</p>}
    {draftOpen&&<textarea readOnly={pending} aria-label="Local Inbox response" placeholder={pending?"Generating response…":"Local draft"} value={draft} onChange={event=>{dirty.current=true;setDraft(event.target.value);localStorage.setItem(`oxroute.inboxDraft:${signal.id}`,event.target.value);}} onBlur={()=>{if(dirty.current&&!pending)void act("save_draft",draft);}} className="mt-2 block min-h-20 max-h-48 w-full min-w-0 resize-y bg-transparent text-[12px] leading-relaxed outline-none [overflow-wrap:anywhere]"/>}
    {error&&<p role="alert" className="mt-1 break-words text-[11px] text-mid">{error}</p>}
  </div>;
}
