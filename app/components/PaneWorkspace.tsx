"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { movePane, paneIds, readPanes, syncPanes, type PaneEdge, type PaneLayout } from "../lib/panes";
import { isTyping } from "../lib/keys";
import type { Agent } from "../lib/types";
import { Icon } from "./Icon";

type Split = { path: string; axis: "row" | "column"; side: "first" | "second" };

export function AgentPicker({ agents, selected, onSelect, onTerminal }: { agents: Pick<Agent, "id" | "name">[]; selected: string[]; onSelect: (ids: string[]) => void; onTerminal?: () => void }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node)) picker.current!.open = false; };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return <details ref={picker} className="relative z-40" onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => { if (event.key === "Escape") event.currentTarget.open = false; }}>
    <summary aria-label="Choose visible agents" title="Choose visible agents" className="flex h-[var(--cell)] w-[var(--cell)] cursor-pointer list-none items-center justify-center border-r border-rule text-faint hover:text-ink"><Icon name="split" size={14} /></summary>
    {open && <div role="group" aria-label="Visible agents" className="absolute left-0 top-full w-64 bg-card p-2 shadow-md">
      <input aria-label="Filter agents" placeholder="Filter agents" value={filter} onChange={event => setFilter(event.target.value)} className="mb-1 w-full bg-band px-2 py-1 text-[12px] outline-none" />
      <div className="max-h-72 overflow-y-auto">{agents.filter(agent => agent.name.toLowerCase().includes(filter.toLowerCase())).map(agent => <label key={agent.id} className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px] hover:bg-band">
        <input type="checkbox" checked={selected.includes(agent.id)} onChange={event => onSelect(event.target.checked ? [...selected, agent.id] : selected.filter(id => id !== agent.id))} />
        <span className="truncate">{agent.name}</span>
      </label>)}</div>
      {onTerminal && <button className="flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-[12px] hover:bg-band" onClick={() => { picker.current!.open = false; onTerminal(); }}><Icon name="terminal" size={13} />New terminal</button>}
    </div>}
  </details>;
}

export function PaneWorkspace({ workspace, ids, keyboard, onActivate, onCustomize, onClose, children }: {
  workspace: string; ids: string[]; keyboard: boolean; onActivate: () => void; onCustomize: () => void; onClose: (id: string) => void; children: (id: string, index: number, handle: ReactNode) => ReactNode;
}) {
  const [layout, setTree] = useState<PaneLayout | null>(() => readPanes(workspace));
  const tree = useMemo(() => syncPanes(layout, ids), [layout, ids]);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; edge: PaneEdge } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(ids[0]);
  const active = ids.includes(focused) ? focused : ids[0];
  const [reading, setReading] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const splits = useRef(new Map<string, HTMLDivElement>());
  const corner = useRef<{ path: string; axis: "row" | "column"; box: DOMRect }[]>([]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!keyboard || menu || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const stop = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.key === "z") { stop(); setZoomed(value => !value); return; }
      if (event.key === "i") { stop(); setReading(true); return; }
      if (event.key === "Escape" && (reading || zoomed)) { stop(); setReading(false); setZoomed(false); return; }
      const direction = { h: [-1, 0], j: [0, 1], k: [0, -1], l: [1, 0] }[event.key];
      if (!direction || reading || zoomed) return;
      stop();
      const panes = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-agent-pane]") ?? []);
      const from = panes.find(pane => pane.dataset.agentPane === active)?.getBoundingClientRect();
      if (!from) return;
      const [dx, dy] = direction;
      const candidates = panes.filter(pane => pane.dataset.agentPane !== active).map(pane => {
        const box = pane.getBoundingClientRect();
        const x = box.x + box.width / 2 - from.x - from.width / 2, y = box.y + box.height / 2 - from.y - from.height / 2;
        return { id: pane.dataset.agentPane!, forward: x * dx + y * dy, sideways: Math.abs(x * dy + y * dx) };
      }).filter(pane => pane.forward > 1).sort((a, b) => a.sideways - b.sideways || a.forward - b.forward);
      if (candidates[0]) setFocused(candidates[0].id);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [keyboard, menu, active, reading, zoomed]);
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
  const render = (node: PaneLayout, path = "", ancestors: Split[] = []): ReactNode => {
    if (typeof node === "string") return <div key={node} data-agent-pane={node} data-pane-active={node === active} data-pane-mode={node === active && reading ? "reading" : "navigation"}
      className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ring-1 ring-inset ${node === active ? "ring-edge [&_[data-pane-title]]:font-bold" : "ring-rule"}`}
      onPointerDownCapture={() => { setFocused(node); onActivate(); }} onFocusCapture={() => { setFocused(node); onActivate(); }}
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
    const junctions = ancestors.filter((ancestor, index) => ancestor.axis !== node.axis && ancestors.slice(index + 1).every(next => next.axis !== ancestor.axis || next.side !== ancestor.side))
      .filter((ancestor, index, all) => !all.slice(index + 1).some(next => next.side === ancestor.side));
    return <div ref={element => { if (element) splits.current.set(path, element); else splits.current.delete(path); }} data-pane-split={node.axis} className={`relative flex min-h-0 min-w-0 flex-1 ${node.axis === "column" ? "flex-col" : ""}`}>
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `${zoomed ? 1 : node.ratio} 1 0`, display: zoomed && !paneIds(node.first).includes(active) ? "none" : undefined }}>{render(node.first, path + "0", [...ancestors, { path, axis: node.axis, side: "first" }])}</div>
      <div role="separator" aria-label="resize chat panes" aria-orientation={node.axis === "row" ? "vertical" : "horizontal"} tabIndex={0}
        hidden={zoomed} className={`relative z-20 shrink-0 before:absolute before:content-[''] ${node.axis === "row" ? "w-0 cursor-col-resize before:inset-y-0 before:-left-[3px] before:w-[6px]" : "h-0 cursor-row-resize before:inset-x-0 before:-top-[3px] before:h-[6px]"}`}
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
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `${zoomed ? 1 : 1 - node.ratio} 1 0`, display: zoomed && !paneIds(node.second).includes(active) ? "none" : undefined }}>{render(node.second, path + "1", [...ancestors, { path, axis: node.axis, side: "second" }])}</div>
      {!zoomed && junctions.map(ancestor => <div key={ancestor.path} role="separator" aria-label="Resize pane intersection" title="Drag to resize both directions"
        className="absolute z-30 h-3 w-3 cursor-move"
        style={node.axis === "column" ? { top: `calc(${node.ratio * 100}% - 6px)`, [ancestor.side === "first" ? "right" : "left"]: 0 } : { left: `calc(${node.ratio * 100}% - 6px)`, [ancestor.side === "first" ? "bottom" : "top"]: 0 }}
        onPointerDown={event => {
          event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
          corner.current = [{ path, axis: node.axis }, ancestor].map(split => ({ ...split, box: splits.current.get(split.path)!.getBoundingClientRect() }));
        }} onPointerMove={event => {
          if (!tree || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          let next = tree;
          for (const split of corner.current) {
            const ratio = split.axis === "row" ? (event.clientX - split.box.x) / split.box.width : (event.clientY - split.box.y) / split.box.height;
            next = resize(next, split.path, Math.min(0.9, Math.max(0.1, ratio)));
          }
          save(next);
        }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />)}
    </div>;
  };
  return <div ref={root} data-pane-zoomed={zoomed} className="flex min-h-0 min-w-0 flex-1" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); }}>
    {tree && render(tree)}
    {menu && <div ref={menuRef} role="menu" aria-label="Pane actions" style={{ left: menu.x, top: menu.y }} className="fixed z-50 bg-card p-1 shadow-md">
      <button role="menuitem" className="cursor-pointer px-2 py-1 text-[12px] hover:bg-band" onClick={() => { onClose(menu.id); setMenu(null); }}>Close pane</button>
    </div>}
  </div>;
}
