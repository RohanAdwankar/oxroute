"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, follow } from "../lib/api";
import { draftFor, keepDraft } from "../lib/drafts";
import type { AgentView, QuoteThread } from "../lib/types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

export function QuoteDiscussion({ thread, rect, onClose, onChanged, onOpen, siblings, onSwitch, canMerge }: {
  thread: QuoteThread; rect: DOMRect; onClose: () => void; onChanged: () => void; onOpen: () => void;
  siblings: QuoteThread[]; onSwitch: (thread: QuoteThread) => void; canMerge: boolean;
}) {
  const [view, setView] = useState<AgentView | null>(null);
  const [draft, setDraft] = useState(() => draftFor(thread.agentId));
  const [busy, setBusy] = useState(false);
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => keepDraft(thread.agentId, draft), [thread.agentId, draft]);
  useEffect(() => {
    let live = true;
    const load = () => api.agent(thread.agentId).then(view => { if (live) setView(view); }).catch(error => { if (live) setError(String(error)); });
    void load();
    const unfollow = follow(event => {
      if (event.type === "timeline" && event.entry.agentId === thread.agentId) setView(view => view ? { ...view, timeline: view.timeline.some(entry => entry.id === event.entry.id) ? view.timeline.map(entry => entry.id === event.entry.id ? event.entry : entry) : [...view.timeline, event.entry] } : view);
      if (event.type === "agentChanged" && event.agent.id === thread.agentId) setView(view => view ? { ...view, agent: event.agent } : view);
      if (event.type === "sync" || (event.type === "turnFinished" && event.agentId === thread.agentId)) void load();
    });
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => { live = false; unfollow(); document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape, true); };
  }, [thread.agentId, onClose]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [view?.timeline.length]);
  const replies = view?.timeline.filter(entry => entry.kind === "said" || entry.kind === "notice").length ?? 0;
  useEffect(() => { if (awaiting !== null && (view?.agent.status === "working" || replies > awaiting)) setAwaiting(null); }, [awaiting, replies, view?.agent.status]);
  const run = async (action: () => Promise<unknown>, close = false) => {
    setBusy(true); setError("");
    try { await action(); onChanged(); if (close) onClose(); else setView(await api.agent(thread.agentId)); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const fork = view?.timeline.findLastIndex(entry => entry.kind === "forkedFrom") ?? -1;
  const entries = view?.timeline.slice(fork + 1).filter(entry => ["you", "received", "said", "notice"].includes(entry.kind)) ?? [];
  const working = view?.agent.status === "working" || awaiting !== null;
  return createPortal(<div ref={panel} role="dialog" aria-label="Quoted thread"
    style={{ left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 408)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 428)) }}
    className="fixed z-50 flex max-h-[min(420px,calc(100vh-16px))] w-[400px] max-w-[calc(100vw-16px)] flex-col border border-rule bg-paper text-ink shadow-lg">
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-rule px-3 text-[12px]">
      <span className="min-w-0 flex-1 truncate">Quoted thread{working ? " · working" : ""}</span>
      {siblings.length > 1 && <button aria-label="Next quoted discussion" title="Next discussion on this passage" className="cursor-pointer text-faint" onClick={() => onSwitch(siblings[(siblings.findIndex(other => other.agentId === thread.agentId) + 1) % siblings.length])}>{siblings.findIndex(other => other.agentId === thread.agentId) + 1}/{siblings.length}</button>}
      <button aria-label="Open full thread" title="Open full thread" onClick={onOpen} className="cursor-pointer"><Icon name="open" size={13} /></button>
      {working && <button aria-label="Stop thread" title="Stop thread" onClick={() => void run(() => api.interrupt(thread.agentId))}><Icon name="stop" size={13} /></button>}
      <button aria-label="Merge thread into parent" title="Merge into parent" disabled={busy || working || !canMerge} onClick={() => void run(() => api.merge(thread.agentId), true)} className="cursor-pointer disabled:opacity-30"><Icon name="merge" size={13} /></button>
      <button aria-label="Archive thread" title={working ? "Stop the active turn first" : "Archive thread"} disabled={busy || working} onClick={() => void run(() => api.archive(thread.agentId, true), true)} className="cursor-pointer disabled:opacity-30"><Icon name="archive" size={13} /></button>
      <button aria-label="Close thread" title="Close thread" onClick={onClose} className="cursor-pointer"><span aria-hidden="true">×</span></button>
    </header>
    <div ref={scroll} className="quiet-scroll min-h-0 max-h-[320px] flex-1 overflow-auto px-3 text-[13px]">
      <blockquote className="my-3 border-l-2 border-rule pl-2 text-mid whitespace-pre-wrap">{thread.text}</blockquote>
      {entries.map(entry => <div key={entry.id} data-thread-entry={entry.id} className={`border-t border-hair py-2 ${entry.kind === "you" ? "bg-mine" : ""}`}><Markdown>{entry.text}</Markdown></div>)}
      {!entries.length && <p className="text-faint">Start a discussion about this passage.</p>}
    </div>
    {error && <p role="alert" className="px-3 text-[12px] text-remove">{error}</p>}
    <form className="flex shrink-0 border-t border-rule" onSubmit={event => {
      event.preventDefault();
      if (!draft.trim() || busy) return;
      void run(async () => {
        await api.say(thread.agentId, draft.trim(), [], false, [], crypto.randomUUID());
        setAwaiting(replies);
        setDraft("");
      });
    }}>
      <input autoFocus aria-label="Reply to quoted thread" placeholder="Discuss this passage…" value={draft} onChange={event => setDraft(event.target.value)} className="min-w-0 flex-1 bg-transparent p-3 text-[13px] outline-none" />
      <button aria-label="Send thread reply" disabled={busy || !draft.trim()} className="px-3 text-faint disabled:opacity-30"><Icon name="send" size={14} /></button>
    </form>
  </div>, document.body);
}
