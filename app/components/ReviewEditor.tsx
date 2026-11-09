"use client";
import {useEffect, useState} from "react";
import {Icon} from "./Icon";
import type {Review} from "../lib/reviews";

export function ReviewEditor({endpoint, path, head, onSaved, onClose}: {endpoint: string; path: string; head: string; onSaved: (review: Review) => void; onClose: () => void}) {
  const [text, setText] = useState<string | null>(null), [original, setOriginal] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${endpoint}/edit?${new URLSearchParams({path})}`, {signal: controller.signal}).then(async result => {
      const body = await result.json();
      if (!result.ok) throw new Error(body.error ?? "Could not read file");
      setText(body.text); setOriginal(body.text);
    }).catch(reason => {if (!controller.signal.aborted) setError(String(reason));});
    return () => controller.abort();
  }, [endpoint, path]);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const result = await fetch(`${endpoint}/edit`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({path, text, headCommit: head})});
      const body = await result.json();
      if (!result.ok) throw new Error(body.error ?? "Could not save revision");
      onSaved(body);
    } catch (reason) {setError(String(reason));}
    finally {setBusy(false);}
  };
  return <div role="dialog" aria-label={`Edit ${path}`} className="fixed inset-0 z-50 flex flex-col bg-paper text-ink">
    <div className="flex items-center gap-3 bg-band px-4 py-2 text-sm"><span className="min-w-0 flex-1 truncate">{path}</span>
      <button aria-label="Save revision" title="Save revision" disabled={busy || text === null || text === original} onClick={() => void save()} className="cursor-pointer p-2 disabled:opacity-40"><Icon name="tick" /></button>
      <button aria-label="Cancel edit" title="Cancel edit" disabled={busy} onClick={() => {if (text === null || text === original || confirm("Discard unsaved edits?")) onClose();}} className="cursor-pointer p-2 disabled:opacity-40">×</button>
    </div>
    <p className="px-4 py-2 text-xs text-faint">Save creates a new local review revision. Approval applies to that revision.</p>
    {error && <p role="alert" className="px-4 py-2 text-sm">{error}</p>}
    {text === null ? <p className="px-4 text-sm">{error ? "" : "Reading file…"}</p> : <textarea autoFocus aria-label={`File contents ${path}`} spellCheck={false} value={text} onChange={event => setText(event.target.value)} disabled={busy} className="min-h-0 flex-1 resize-none bg-paper p-4 font-mono text-sm leading-relaxed outline-none" />}
  </div>;
}
