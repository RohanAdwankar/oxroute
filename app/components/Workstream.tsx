"use client";

import { useState } from "react";
import type { Agent, Workstream } from "../lib/types";
import { Icon } from "./Icon";

const empty: Workstream = { outcome: "", owner: "", blocker: "", nextAction: "", target: "", estimateDays: null, stageStartedAt: null, followUpAt: null, sources: [] };
const date = (at: number) => new Date(at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const localTime = (at: number | null) => at ? new Date(at * 1000 - new Date(at * 1000).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";

export function WorkstreamContext({ brief, now }: { brief: Workstream; now: number }) {
  const due = brief.followUpAt && brief.followUpAt <= now;
  const late = brief.estimateDays && brief.stageStartedAt && brief.stageStartedAt + brief.estimateDays * 86400 <= now;
  return <div className="mt-2 space-y-1 text-[12px] leading-relaxed">
    {brief.outcome && <p>{brief.outcome}</p>}
    {brief.owner && <p className="text-mid">Owner · {brief.owner}</p>}
    {brief.blocker && <p><span className="text-faint">Waiting · </span>{brief.blocker}</p>}
    {brief.nextAction && <p><span className="text-faint">You · </span>{brief.nextAction}</p>}
    {brief.target && <p className="text-mid">Target · {brief.target}</p>}
    {brief.estimateDays && <p className={late ? "font-semibold text-ink" : "text-faint"}>Stage estimate · {brief.estimateDays} days{brief.stageStartedAt ? ` from ${date(brief.stageStartedAt)}` : ""}{late ? " · overdue" : ""}</p>}
    {brief.followUpAt && <p className={due ? "font-semibold text-ink" : "text-faint"}>{due ? "⚑ Follow-up due" : "Follow up"} · {date(brief.followUpAt)}</p>}
    {!!brief.sources.length && <div className="flex flex-wrap gap-2 text-faint">{brief.sources.map((source, i) => <a key={source} href={source} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()} className="underline underline-offset-2">Source {i + 1}</a>)}</div>}
  </div>;
}

export function WorkstreamEditor({ agent, brief, onSave, onClose }: { agent: Agent; brief?: Workstream; onSave: (brief: Workstream) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState({ ...empty, ...brief });
  const [sources, setSources] = useState(brief?.sources.join("\n") ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const text = (key: "outcome" | "owner" | "blocker" | "nextAction" | "target", label: string) => <label className="block text-[12px] text-faint">{label}<textarea aria-label={label} autoFocus={key === "outcome"} value={draft[key]} rows={key === "outcome" || key === "blocker" || key === "nextAction" ? 2 : 1} onChange={event => setDraft({ ...draft, [key]: event.target.value })} className="mt-1 block w-full resize-y border-b border-rule bg-transparent py-1 text-[13px] text-ink outline-none focus:border-edge" /></label>;
  const time = (key: "stageStartedAt" | "followUpAt", label: string) => <label className="block text-[12px] text-faint">{label}<input aria-label={label} type="datetime-local" value={localTime(draft[key])} onChange={event => setDraft({ ...draft, [key]: event.target.value ? new Date(event.target.value).getTime() / 1000 : null })} className="mt-1 block w-full border-b border-rule bg-transparent py-1 text-[13px] text-ink outline-none" /></label>;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
    <form role="dialog" aria-modal="true" aria-label={`Workstream · ${agent.name}`} className="max-h-[90vh] w-full max-w-lg space-y-3 overflow-auto bg-paper p-5 shadow-xl" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") onClose(); }} onSubmit={async event => {
      event.preventDefault(); setSaving(true); setError("");
      try { await onSave({ ...draft, sources: sources.split("\n").map(value => value.trim()).filter(Boolean) }); }
      catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { setSaving(false); }
    }}>
      <div className="flex items-center gap-2"><h2 className="flex-1 text-[14px] font-semibold">{agent.name}</h2><button type="button" title="Cancel" aria-label="Cancel" onClick={onClose} className="p-1"><Icon name="stop" /></button><button type="submit" disabled={saving} title="Save" aria-label="Save" className="p-1 disabled:opacity-40"><Icon name="tick" /></button></div>
      {text("outcome", "Outcome")}{text("owner", "Owner")}{text("blocker", "Waiting on")}{text("nextAction", "Your next action")}{text("target", "Target / milestone")}
      <div className="grid grid-cols-2 gap-3"><label className="text-[12px] text-faint">Stage estimate (days)<input aria-label="Stage estimate (days)" type="number" min="0.01" step="any" value={draft.estimateDays ?? ""} onChange={event => setDraft({ ...draft, estimateDays: event.target.value ? Number(event.target.value) : null })} className="mt-1 block w-full border-b border-rule bg-transparent py-1 text-[13px] text-ink outline-none" /></label>{time("stageStartedAt", "Stage started")}</div>
      {time("followUpAt", "Follow-up checkpoint")}
      <label className="block text-[12px] text-faint">Sources (one link per line)<textarea aria-label="Sources (one link per line)" value={sources} rows={2} onChange={event => setSources(event.target.value)} className="mt-1 block w-full border-b border-rule bg-transparent py-1 text-[13px] text-ink outline-none" /></label>
      {error && <p role="alert" className="text-[12px] text-bad">{error}</p>}
    </form>
  </div>;
}
