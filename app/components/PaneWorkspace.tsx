"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { movePane, readPanes, syncPanes, type PaneEdge, type PaneLayout } from "../lib/panes";
import type { Agent } from "../lib/types";
import { Icon } from "./Icon";

export function AgentPicker({ agents, selected, onSelect }: { agents: Agent[]; selected: string[]; onSelect: (ids: string[]) => void }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  return <details className="relative z-40" onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => { if (event.key === "Escape") event.currentTarget.open = false; }}>
    <summary aria-label="Choose visible agents" title="Choose visible agents" className="flex h-[var(--cell)] w-[var(--cell)] cursor-pointer list-none items-center justify-center border-r border-rule text-faint hover:text-ink"><Icon name="split" size={14} /></summary>
    {open && <div role="group" aria-label="Visible agents" className="absolute left-0 top-full w-64 bg-card p-2 shadow-md">
      <input aria-label="Filter agents" placeholder="Filter agents" value={filter} onChange={event => setFilter(event.target.value)} className="mb-1 w-full bg-band px-2 py-1 text-[12px] outline-none" />
      <div className="max-h-72 overflow-y-auto">{agents.filter(agent => agent.name.toLowerCase().includes(filter.toLowerCase())).map(agent => <label key={agent.id} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px] hover:bg-band">
        <input type="checkbox" checked={selected.includes(agent.id)} onChange={event => onSelect(event.target.checked ? [...selected, agent.id] : selected.filter(id => id !== agent.id))} />
        <span className="truncate">{agent.name}</span>
      </label>)}</div>
    </div>}
  </details>;
}

export function PaneWorkspace({ workspace, ids, onCustomize, onClose, children }: {
  workspace: string; ids: string[]; onCustomize: () => void; onClose: (id: string) => void; children: (id: string, index: number, handle: ReactNode) => ReactNode;
}) {
  const [layout, setTree] = useState<PaneLayout | null>(() => readPanes(workspace));
  const tree = useMemo(() => syncPanes(layout, ids), [layout, ids]);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; edge: PaneEdge } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(null); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape, true); };
  }, [menu]);
  useEffect(() => { if (tree && readPanes(workspace)) localStorage.setItem(`oxroute.panes.${workspace}`, JSON.stringify(tree)); }, [tree, workspace]);
  const save = (next: PaneLayout) => { setTree(next); localStorage.setItem(`oxroute.panes.${workspace}`, JSON.stringify(next)); onCustomize(); };
  const resize = (current: PaneLayout, path: string, ratio: number): PaneLayout => {
    if (typeof current === "string") return current;
    if (!path) return { ...current, ratio };
    return path[0] === "0" ? { ...current, first: resize(current.first, path.slice(1), ratio) } : { ...current, second: resize(current.second, path.slice(1), ratio) };
  };
  const render = (node: PaneLayout, path = ""): ReactNode => {
    if (typeof node === "string") return <div key={node} data-agent-pane={node} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      onDragOver={event => {
        if (!drag || drag === node) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move";
        const box = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
        const edge: PaneEdge = Math.min(x, 1 - x) < Math.min(y, 1 - y) ? (x < 0.5 ? "left" : "right") : (y < 0.5 ? "top" : "bottom");
        setOver({ id: node, edge });
      }} onDrop={event => {
        if (!drag || !over || over.id !== node || !tree) return;
        event.preventDefault(); event.stopPropagation(); save(movePane(tree, drag, node, over.edge)); setDrag(null); setOver(null);
      }}>
      {children(node, ids.indexOf(node), <button draggable aria-label={`Move pane ${node}`} title="Drag to an edge of another pane" className="cursor-grab text-faint"
        onContextMenu={event => { event.preventDefault(); setMenu({ id: node, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 120)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 36)) }); }}
        onDragStart={event => { event.dataTransfer.setData("application/x-oxroute-pane", node); event.dataTransfer.effectAllowed = "move"; setDrag(node); }}
        onDragEnd={() => { setDrag(null); setOver(null); }}>⋮</button>)}
      {over?.id === node && <div aria-label={`Place pane ${over.edge}`} className="pointer-events-none absolute z-40 bg-edge/20" style={over.edge === "left" || over.edge === "right" ? { top: 0, bottom: 0, width: "50%", [over.edge]: 0 } : { left: 0, right: 0, height: "50%", [over.edge]: 0 }} />}
    </div>;
    return <div data-pane-split={node.axis} className={`flex min-h-0 min-w-0 flex-1 ${node.axis === "column" ? "flex-col" : ""}`}>
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `${node.ratio} 1 0` }}>{render(node.first, path + "0")}</div>
      <div role="separator" aria-label="resize chat panes" aria-orientation={node.axis === "row" ? "vertical" : "horizontal"} tabIndex={0}
        className={node.axis === "row" ? "w-[5px] shrink-0 cursor-col-resize border-l border-rule hover:bg-band" : "h-[5px] shrink-0 cursor-row-resize border-t border-rule hover:bg-band"}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId) || !tree) return;
          const box = event.currentTarget.parentElement!.getBoundingClientRect();
          const ratio = node.axis === "row" ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
          save(resize(tree, path, Math.min(0.9, Math.max(0.1, ratio))));
        }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
        onKeyDown={event => {
          const negative = node.axis === "row" ? "ArrowLeft" : "ArrowUp", positive = node.axis === "row" ? "ArrowRight" : "ArrowDown";
          if (tree && (event.key === negative || event.key === positive)) { event.preventDefault(); event.stopPropagation(); save(resize(tree, path, Math.min(0.9, Math.max(0.1, node.ratio + (event.key === positive ? 0.05 : -0.05))))); }
        }} />
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `${1 - node.ratio} 1 0` }}>{render(node.second, path + "1")}</div>
    </div>;
  };
  return <div className="flex min-h-0 min-w-0 flex-1" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); }}>
    {tree && render(tree)}
    {menu && <div ref={menuRef} role="menu" aria-label="Pane actions" style={{ left: menu.x, top: menu.y }} className="fixed z-50 bg-card p-1 shadow-md">
      <button role="menuitem" className="cursor-pointer px-2 py-1 text-[12px] hover:bg-band" onClick={() => { onClose(menu.id); setMenu(null); }}>Close pane</button>
    </div>}
  </div>;
}
