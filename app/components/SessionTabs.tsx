"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { Icon } from "./Icon";
import { carriesPane } from "../lib/pane-transfer";

export function SessionTabs({ sessions, ids, active, onSelect, onClose, onDragStart, onDragEnd, onDrop, onDetach, onReorder, focusOpen, onFocus }: {
  sessions: { id: string; name: string }[];
  ids: string[];
  active: string | null;
  focusOpen: boolean;
  onFocus: () => void;
  onSelect: (id: string | null) => void;
  onClose: (id: string) => void;
  onDragStart: (event: DragEvent, id: string) => void;
  onDragEnd: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  onDetach: (id: string) => void;
  onReorder: (id: string, target: string | null, after: boolean) => void;
}) {
  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    window.addEventListener("pointerdown", dismiss); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", escape); };
  }, [menu]);
  useEffect(() => { selected.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active, ids, focusOpen]);
  const tabs = [{ id: "focus", name: "Focus" }, ...ids.flatMap(id => sessions.find(session => session.id === id) ?? [])];
  const selectedId = focusOpen ? "focus" : active;
  const select = (id: string) => id === "focus" ? onFocus() : onSelect(id);
  return <nav aria-label="Session tabs" className="flex h-[var(--cell)] min-w-0 flex-1 overflow-x-auto bg-card text-[12px]"
    onDragOver={event => { if (carriesPane(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={event => {
      if (!dragging.current) return onDrop(event);
      event.preventDefault(); event.stopPropagation();
      onReorder(dragging.current, null, true); setDrop(null);
    }}>
    <div role="tablist" aria-label="Sessions" className="flex min-w-0 items-stretch">
      {tabs.map((session, index) => <div key={session.id}
        style={drop?.id === session.id ? { boxShadow: `inset ${drop.after ? "-2px" : "2px"} 0 var(--color-ink)` } : undefined}
        onDragOver={event => {
          if (!dragging.current || session.id === "focus") return;
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
          const box = event.currentTarget.getBoundingClientRect();
          setDrop({ id: session.id, after: event.clientX > box.x + box.width / 2 });
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={event => {
          if (!dragging.current) return;
          event.preventDefault(); event.stopPropagation();
          const box = event.currentTarget.getBoundingClientRect();
          onReorder(dragging.current, session.id === "focus" ? ids[0] ?? null : session.id, session.id !== "focus" && event.clientX > box.x + box.width / 2); setDrop(null);
        }} className={`flex shrink-0 items-stretch border-b ${selectedId === session.id ? "border-ink bg-wash text-ink" : "border-transparent text-faint hover:text-ink"}`}>
        <button type="button" role="tab" draggable={session.id !== "focus"} onDragStart={event => { dragging.current = session.id; onDragStart(event, session.id); }} onDragEnd={event => { dragging.current = null; setDrop(null); onDragEnd(event); }}
          onContextMenu={event => { if (session.id === "focus") return; event.preventDefault(); setMenu({ id: session.id, x: Math.max(0, Math.min(event.clientX, innerWidth - 200)), y: event.clientY }); }}
          ref={selectedId === session.id ? selected : null} aria-selected={selectedId === session.id} aria-label={session.id === "focus" ? "Focus" : undefined} title={session.name}
          tabIndex={selectedId === session.id || (!selectedId && index === 0) ? 0 : -1}
          className="max-w-48 cursor-pointer truncate pl-3 pr-2 text-left" onClick={() => select(session.id)}
          onKeyDown={event => {
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); event.stopPropagation();
            select(tabs[next].id);
            event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus();
          }}>{session.id === "focus" ? <Icon name="auto" size={14} /> : session.name}</button>
        {session.id !== "focus" && <button type="button" aria-label={`Close tab ${session.name}`} title="Close tab" className="cursor-pointer px-2 text-faint hover:text-ink"
          onClick={() => onClose(session.id)}>×</button>}
      </div>)}
    </div>
    {menu && <div ref={menuRef} role="menu" aria-label="Tab actions" className="fixed z-50 bg-card p-1 shadow-md" style={{ left: menu.x, top: menu.y }}>
      <button role="menuitem" className="block cursor-pointer px-2 py-1 text-left hover:bg-band" onClick={() => { onDetach(menu.id); setMenu(null); }}>Move to new window</button>
    </div>}
  </nav>;
}
