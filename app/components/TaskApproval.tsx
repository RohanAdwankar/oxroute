import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import type { TaskItem } from "../lib/types";

export function TaskApproval({ task, busy, approve, approveAll, correct }: {
  task: TaskItem;
  busy: boolean;
  approve: () => void;
  approveAll?: () => void;
  correct: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setMenu(null); buttonRef.current?.focus(); }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key);
    menuRef.current?.querySelector("button")?.focus();
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", key); };
  }, [menu]);
  if (task.status !== "done") return null;
  return <span className="inline-flex items-center gap-2">
    <button ref={buttonRef} type="button" disabled={busy} onClick={approve}
      onContextMenu={event => {
        if (!approveAll || busy) return;
        event.preventDefault(); event.stopPropagation();
        setMenu({ x: Math.max(0, Math.min(event.clientX, window.innerWidth - 200)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 48)) });
      }}
      aria-haspopup={approveAll ? "menu" : undefined} aria-expanded={approveAll ? !!menu : undefined}
      aria-label="Approve" title={approveAll ? "Approve · right-click for subtasks" : "Approve"}
      className="cursor-pointer bg-ink px-2 py-1 text-[11.5px] text-paper disabled:opacity-40"><Icon name="tick" size={14} /></button>
    <button type="button" disabled={busy} onClick={correct} aria-label="Not yet" title="Request revision"
      className="cursor-pointer px-1 py-1 text-[11.5px] text-mid hover:text-ink disabled:opacity-40"><Icon name="pen" size={14} /></button>
    {menu && approveAll && createPortal(<div ref={menuRef} role="menu" aria-label="Task approval" className="fixed z-50 min-w-48 bg-paper p-1 text-ink shadow-lg ring-1 ring-rule" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenu(null); approveAll(); }}
        className="block w-full cursor-pointer px-3 py-2 text-left text-[12px] hover:bg-band focus:bg-band focus:outline-none disabled:opacity-40">Approve all subtasks</button>
    </div>, document.body)}
  </span>;
}
