"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Agent } from "../lib/types";
import { Icon } from "./Icon";

export interface TerminalInfo { id: string; name: string; pending: string[]; granted: string[] }
export async function terminalApi<T>(path: string, body?: object, method = "POST", signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/terminals${path}`, { signal, ...(body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
export function TerminalPane({ id, agents, handle, onEnd }: { id: string; agents: Agent[]; handle: ReactNode; onEnd: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<TerminalInfo>({ id, name: "Terminal", pending: [], granted: [] });
  const [error, setError] = useState("");
  const token = useCallback(() => localStorage.getItem(`oxroute.terminal.${id}`) ?? "", [id]);
  const decide = (agentId: string, allow: boolean) => terminalApi<TerminalInfo>(`/${id}/consent`, { controller: token(), agentId, allow }).then(setInfo).catch(error => setError(String(error)));
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    let dispose = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (!live || !host.current) return;
      const style = getComputedStyle(host.current);
      const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "monospace", theme: { background: style.backgroundColor, foreground: style.color }, scrollback: 1000 });
      const palette = () => {
        const style = getComputedStyle(host.current!);
        terminal.options.theme = { background: style.backgroundColor, foreground: style.color, cursor: style.color, cursorAccent: style.backgroundColor,
          selectionBackground: getComputedStyle(document.documentElement).getPropertyValue("--color-band").trim() };
      };
      palette();
      const theme = new MutationObserver(palette);
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host.current);
      const send = (data: string) => token() && terminalApi(`/${id}/input`, { controller: token(), data }).catch(error => setError(String(error)));
      let writing = Promise.resolve<unknown>(undefined);
      let replaying = true;
      let userInput = false;
      const markInput = () => { userInput = true; setTimeout(() => { userInput = false; }, 0); };
      const inputEvents = ["keydown", "keypress", "input", "paste"];
      const element = host.current;
      for (const event of inputEvents) element.addEventListener(event, markInput, true);
      const input = terminal.onData(data => { if (!replaying || userInput) writing = writing.then(() => send(data)); });
      const observer = new ResizeObserver(() => {
        fit.fit();
        if (token()) void terminalApi(`/${id}/resize`, { controller: token(), rows: terminal.rows, cols: terminal.cols }).catch(error => setError(String(error)));
      });
      observer.observe(host.current);
      let after = 0;
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const result = await terminalApi<{ terminal: TerminalInfo; bytes: number[]; end: number; reset: boolean }>(`/${id}?after=${after}&wait=true`, undefined, "GET", controller.signal);
          if (!live) return;
          setInfo(current => JSON.stringify(current) === JSON.stringify(result.terminal) ? current : result.terminal);
          if (result.reset) { replaying = true; terminal.reset(); }
          if (result.bytes.length) await new Promise<void>(resolve => terminal.write(new Uint8Array(result.bytes), resolve));
          replaying = false;
          after = result.end;
          if (live) timer = setTimeout(poll, 0);
        } catch (error) { if (live) { setError(String(error)); timer = setTimeout(poll, 200); } }
      };
      void poll();
      dispose = () => { clearTimeout(timer); theme.disconnect(); observer.disconnect(); input.dispose(); terminal.dispose(); for (const event of inputEvents) element.removeEventListener(event, markInput, true); };
    })().catch(error => setError(String(error)));
    return () => { live = false; controller.abort(); dispose(); };
  }, [id, token]);
  const name = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
  return <section data-terminal-pane={id} className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper text-ink">
    <header data-pane-header className="flex h-[var(--bar)] shrink-0 items-center gap-2 border-b border-rule px-2">
      {handle}<Icon name="terminal" size={14} /><span data-pane-title className="min-w-0 flex-1 truncate text-[13px]">{info.name}</span>
      <button title="End terminal session" aria-label="End terminal session" className="cursor-pointer text-faint hover:text-ink" onClick={() => {
        if (confirm("End this terminal session and its running shell?")) void terminalApi(`/${id}`, { controller: token() }, "DELETE").then(onEnd).catch(error => setError(String(error)));
      }}><Icon name="stop" size={13} /></button>
    </header>
    {info.pending.map(agent => <div key={agent} role="alertdialog" aria-label="Terminal access request" className="flex flex-wrap items-center gap-2 bg-card px-3 py-2 text-[12px]">
      <span>{name(agent)} would like to write to this terminal.</span>
      <button className="cursor-pointer font-semibold" onClick={() => void decide(agent, true)}>Allow</button>
      <button className="cursor-pointer" onClick={() => void decide(agent, false)}>Deny</button>
    </div>)}
    {info.granted.map(agent => <div key={agent} className="flex items-center gap-2 px-2 text-[11px] text-faint"><span>{name(agent)} can write</span><button className="cursor-pointer" onClick={() => void decide(agent, false)}>Revoke</button></div>)}
    {error && <p role="alert" className="px-2 text-[12px] text-hold">{error}</p>}
    <div ref={host} aria-label="Interactive terminal" className="min-h-0 flex-1 overflow-hidden bg-paper p-1 text-ink" />
  </section>;
}
