"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface BrowserInfo { id: string; name: string; agentId: string; human: boolean; target?: string; tabs?: { id: string; title: string; url: string }[] }
export async function browserApi<T>(path: string, body?: object, method = "POST", signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/browsers${path}`, { signal, ...(body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" }) });
  if (!response.ok) throw new Error((await response.json()).error ?? "Browser request failed");
  return response.json();
}

export function BrowserPane({ id, handle, onEnd }: { id: string; handle: ReactNode; onEnd: () => void }) {
  const [info, setInfo] = useState<BrowserInfo>();
  const [url, setUrl] = useState("");
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef("");
  const address = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const sending = useRef(Promise.resolve());
  const lastMove = useRef(0);
  const human = info?.human ?? false;

  useEffect(() => {
    const abort = new AbortController();
    let active = true, timer: ReturnType<typeof setTimeout>, objectUrl = "";
    const poll = async () => {
      try {
        const [next, frame] = await Promise.all([
          browserApi<BrowserInfo>(`/${id}`, undefined, "GET", abort.signal),
          fetch(`/api/browsers/${id}/frame`, { cache: "no-store", signal: abort.signal }),
        ]);
        if (!active) return;
        setInfo(next);
        if (!frame.ok) throw new Error((await frame.json()).error ?? "Browser disconnected");
        const blob = await frame.blob();
        if (!active) return;
        const nextUrl = URL.createObjectURL(blob);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = nextUrl;
        setImage(nextUrl); setError("");
        if (document.activeElement !== address.current) setUrl(next.tabs?.find(tab => tab.id === next.target)?.url ?? "");
      } catch (error) { if (active) setError(String(error)); }
      if (active) timer = setTimeout(poll, document.hidden ? 2000 : 500);
    };
    void browserApi<{ controller: string }>(`/${id}/claim`, {}).then(result => {
      if (active) { controller.current = result.controller; void poll(); }
    }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; clearTimeout(timer); abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);

  const send = useCallback((input: object) => {
    sending.current = sending.current.then(async () => {
      await browserApi(`/${id}/action`, { controller: controller.current, ...input });
    }).catch(error => setError(String(error)));
  }, [id]);
  const toggle = async () => {
    setBusy(true);
    try {
      const next = await browserApi<BrowserInfo>(`/${id}/control`, { controller: controller.current, human: !human });
      setInfo(current => ({ ...current, ...next })); setError("");
      if (next.human) viewport.current?.focus();
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  return <section data-browser-pane={id} className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
    <header data-pane-header className="flex h-[var(--cell)] shrink-0 items-center gap-2 border-b border-rule px-2 text-[12px]">
      {handle}<span data-pane-title>Browser</span>
      <span role="status" className="ml-auto text-faint">{human ? "You have control" : "Agent has control"}</span>
      <button disabled={busy || !info} onClick={() => void toggle()} className="cursor-pointer bg-band px-2 py-1 disabled:opacity-50">{human ? "Resume agent" : "Take control"}</button>
      <button aria-label="End browser" title="End browser" className="cursor-pointer px-1 text-faint hover:text-ink" onClick={() => void browserApi(`/${id}`, { controller: controller.current }, "DELETE").then(onEnd).catch(error => setError(String(error)))}>×</button>
    </header>
    {info?.tabs && info.tabs.length > 1 && <div aria-label="Browser tabs" className="flex shrink-0 gap-1 overflow-x-auto p-1 text-[12px]">{info.tabs.map(tab => <button key={tab.id} disabled={!human} aria-pressed={tab.id === info.target} className={`max-w-48 truncate px-2 py-1 disabled:opacity-50 ${tab.id === info.target ? "bg-band" : "text-faint"}`} onClick={() => send({ action: "selectTab", target: tab.id })}>{tab.title || tab.url || "New tab"}</button>)}</div>}
    <form aria-label="Browser navigation" className="flex shrink-0 items-center gap-1 border-b border-rule p-1 text-[12px]" onSubmit={event => { event.preventDefault(); if (human && url.trim()) send({ action: "navigate", url: url.includes(":") ? url.trim() : `https://${url.trim()}` }); }}>
      <button type="button" aria-label="Browser back" disabled={!human} className="px-2 disabled:opacity-30" onClick={() => send({ action: "back" })}>←</button>
      <button type="button" aria-label="Browser forward" disabled={!human} className="px-2 disabled:opacity-30" onClick={() => send({ action: "forward" })}>→</button>
      <button type="button" aria-label="Browser reload" disabled={!human} className="px-2 disabled:opacity-30" onClick={() => send({ action: "reload" })}>↻</button>
      <button type="button" aria-label="New browser tab" disabled={!human} className="px-2 disabled:opacity-30" onClick={() => send({ action: "newTab" })}>+</button>
      <input ref={address} aria-label="Browser address" placeholder="Enter a URL" disabled={!human} value={url} onChange={event => setUrl(event.target.value)} className="min-w-0 flex-1 bg-band px-2 py-1 outline-none disabled:opacity-50" />
      <button disabled={!human} className="px-2 disabled:opacity-30">Go</button>
      {(info?.tabs?.length ?? 0) > 1 && <button type="button" aria-label="Close browser tab" disabled={!human} className="px-2 disabled:opacity-30" onClick={() => send({ action: "closeTab", target: info!.target })}>×</button>}
    </form>
    {error && <p role="alert" className="px-2 py-1 text-[12px] text-faint">{error}</p>}
    <div className="min-h-0 flex-1 overflow-auto bg-band">
      <div ref={viewport} role="application" aria-label="Browser viewport" tabIndex={human ? 0 : -1} className="relative w-full outline-none" style={{ aspectRatio: "1280 / 800" }}
        onKeyDown={event => {
          if (!human) return;
          event.stopPropagation(); event.preventDefault();
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") { address.current?.focus(); address.current?.select(); return; }
          if (event.key === "v" && (event.ctrlKey || event.metaKey)) { void navigator.clipboard.readText().then(text => send({ action: "type", text })).catch(error => setError(String(error))); return; }
          if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
          send(event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? { action: "type", text: event.key } : { action: "key", key: event.key, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
        }} onPaste={event => { if (human) { event.preventDefault(); send({ action: "type", text: event.clipboardData.getData("text/plain") }); } }}
        onClick={event => {
          if (!human) return;
          viewport.current?.focus();
          const box = event.currentTarget.getBoundingClientRect();
          send({ action: "click", x: (event.clientX - box.left) * 1280 / box.width, y: (event.clientY - box.top) * 800 / box.height });
        }} onPointerMove={event => {
          if (!human || Date.now() - lastMove.current < 100) return;
          lastMove.current = Date.now();
          const box = event.currentTarget.getBoundingClientRect();
          send({ action: "move", x: (event.clientX - box.left) * 1280 / box.width, y: (event.clientY - box.top) * 800 / box.height });
        }} onWheel={event => {
          if (!human) return;
          event.stopPropagation();
          const box = event.currentTarget.getBoundingClientRect();
          send({ action: "scroll", x: (event.clientX - box.left) * 1280 / box.width, y: (event.clientY - box.top) * 800 / box.height, deltaX: event.deltaX, deltaY: event.deltaY });
        }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {image ? <img src={image} alt="Shared browser screen" draggable={false} className="block h-full w-full select-none" /> : <p className="p-4 text-[12px] text-faint">Opening browser…</p>}
      </div>
    </div>
  </section>;
}
