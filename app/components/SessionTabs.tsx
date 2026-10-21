"use client";

import { useEffect, useRef, useState } from "react";

export function SessionTabs({ sessions, active, onSelect }: {
  sessions: { id: string; name: string }[];
  active: string | null;
  onSelect: (id: string | null) => void;
}) {
  const selected = useRef<HTMLButtonElement>(null);
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem("oxroute.sessionTabs") ?? "[]");
      return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === "string"))] : [];
    } catch { return []; }
  });
  if (active && !ids.includes(active)) setIds([...ids, active]);
  useEffect(() => { sessionStorage.setItem("oxroute.sessionTabs", JSON.stringify(ids)); }, [ids]);
  useEffect(() => { selected.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active, ids]);
  const tabs = ids.flatMap(id => sessions.find(session => session.id === id) ?? []);
  if (!tabs.length) return null;
  return <nav aria-label="Session tabs" className="flex h-[var(--cell)] shrink-0 overflow-x-auto border-b border-rule bg-card text-[12px]">
    <div role="tablist" aria-label="Sessions" className="flex min-w-0 items-stretch">
      {tabs.map((session, index) => <div key={session.id} className={`flex shrink-0 items-stretch border-b ${active === session.id ? "border-ink bg-wash text-ink" : "border-transparent text-faint hover:text-ink"}`}>
        <button type="button" role="tab" ref={active === session.id ? selected : null} aria-selected={active === session.id} title={session.name}
          tabIndex={active === session.id || (!active && index === 0) ? 0 : -1}
          className="max-w-48 cursor-pointer truncate pl-3 pr-2 text-left" onClick={() => onSelect(session.id)}
          onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); event.stopPropagation();
            onSelect(tabs[next].id);
            event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus();
          }}>{session.name}</button>
        <button type="button" aria-label={`Close tab ${session.name}`} title="Close tab" className="cursor-pointer px-2 text-faint hover:text-ink"
          onClick={() => {
            setIds(current => current.filter(id => id !== session.id));
            if (active === session.id) onSelect(tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null);
          }}>×</button>
      </div>)}
    </div>
  </nav>;
}
