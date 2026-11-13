"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Agent, Entry, TaskItem } from "../lib/types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

/** Task replies have their own durable draft, independent of the conversation composer. */
export function FocusReply({ task, agent, expanded, onExpanded, onSent }: { task: TaskItem; agent: Agent; expanded: boolean; onExpanded: (expanded: boolean) => void; onSent: () => void }) {
  const key = `oxroute.taskReply.${task.id}`;
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [contextError, setContextError] = useState("");
  const [sent, setSent] = useState("");
  const [revision, setRevision] = useState(0);
  const request = useRef<{ text: string; id: string }>(null);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    api.recentMessages(agent.id, controller.signal).then(messages => {
      if (current) { setEntries(messages); setContextError(""); }
    }).catch(error => { if (current) setContextError(String(error instanceof Error ? error.message : error)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [agent.id, agent.updatedAt, expanded, revision]);
  const change = (text: string) => {
    setDraft(text);
    try { if (text) localStorage.setItem(key, text); else localStorage.removeItem(key); } catch { /* Keep the in-memory draft when storage is unavailable. */ }
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    if (!request.current) { try { request.current = JSON.parse(localStorage.getItem(`${key}.request`) ?? "null"); } catch { /* Use a fresh request. */ } }
    if (request.current?.text !== text) request.current = { text, id: crypto.randomUUID() };
    try { localStorage.setItem(`${key}.request`, JSON.stringify(request.current)); } catch { /* The current request remains retryable in memory. */ }
    setPending(true); setError("");
    try {
      await api.say(agent.id, `Regarding task ${task.id} (${task.text}):\n\n${text}`, [], true, [], request.current.id);
      change(""); setSent(text); request.current = null;
      try { localStorage.removeItem(`${key}.request`); } catch { /* The sent draft is already cleared in memory. */ }
      setRevision(value => value + 1); onSent();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };
  return <div className="mt-3 cursor-auto" data-focus-reply={task.id}>
    <div className="flex items-center gap-3 text-[11.5px] text-mid">
      <button type="button" aria-label="Conversation context" aria-expanded={expanded} onClick={() => onExpanded(!expanded)} className="sr-only focus:not-sr-only">Conversation context</button>
      <span role="status">{pending ? "Sending…" : agent.status === "working" ? agent.activity || "Agent working…" : sent ? "Reply sent" : ""}</span>
      {expanded && <button type="button" title="Refresh context" aria-label="Refresh context" onClick={() => setRevision(value => value + 1)} className="cursor-pointer hover:text-ink"><Icon name="refresh" /></button>}
    </div>
    {expanded && <div className="quiet-scroll my-3 max-h-96 overflow-auto text-[13px] leading-relaxed" aria-label="Conversation context">
      {loading && <p className="text-faint">Loading…</p>}
      {!loading && !entries.length && <p className="text-faint">No conversation messages yet.</p>}
      {entries.map(entry => <div key={entry.id} className="mb-3"><p className="mb-1 text-[11px] text-faint">{entry.kind === "said" ? agent.name : "You"}</p><Markdown>{entry.text}</Markdown></div>)}
    </div>}
    {sent && <p className="my-2 whitespace-pre-wrap text-[12px] text-mid">You: {sent}</p>}
    <form className="mt-2 flex items-end gap-2" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label={`Reply about ${task.text}`} placeholder="Reply…" value={draft} disabled={pending} rows={2}
        onChange={event => change(event.target.value)} onFocus={() => onExpanded(true)}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
        className="min-w-0 flex-1 resize-y border-b border-hair bg-transparent py-1 text-[13px] text-ink outline-none focus:border-mid disabled:opacity-50" />
      <button type="submit" aria-label="Send reply" title="Send reply" disabled={pending || !draft.trim()} className="cursor-pointer p-2 text-mid hover:text-ink disabled:cursor-default disabled:opacity-30"><Icon name="send" /></button>
    </form>
    {(error || contextError) && <p role="alert" className="mt-2 text-[12px] text-mid">{error || contextError}</p>}
  </div>;
}
