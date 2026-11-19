"use client";
import type {CSSProperties} from "react";
import {Icon, type IconName} from "./Icon";

export type MarkupTool = "pen" | "box" | "arrow" | "text";
export const MARKUP_INK = "#d23c2e";
export type MarkupStyle = {color: string; width: number};
export const MARKUP_DEFAULT: MarkupStyle = {color: MARKUP_INK, width: 1};
export function MarkupTools({marker, onMarker, tool, onTool, onUndo, onClear, empty, select = false, undoDisabled = empty}: {
  marker: MarkupStyle; onMarker: (style: MarkupStyle) => void;
  tool: MarkupTool | "select"; onTool: (tool: MarkupTool | "select") => void;
  onUndo: () => void; onClear: () => void; empty: boolean; select?: boolean; undoDisabled?: boolean;
}) {
  const tools: {id: MarkupTool | "select"; label: string; icon: IconName}[] = [
    ...(select ? [{id: "select" as const, label: "Select area", icon: "scope" as const}] : []),
    {id: "pen", label: "Pen", icon: "pen"}, {id: "box", label: "Box", icon: "stop"},
    {id: "arrow", label: "Arrow", icon: "external"}, {id: "text", label: "Text", icon: "text"},
  ];
  return <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Image markup">
    {tools.map(item => <button key={item.id} type="button" aria-label={item.label} title={item.label} aria-pressed={tool === item.id} onClick={() => onTool(item.id)} className={`flex h-8 w-8 cursor-pointer items-center justify-center ${tool === item.id ? "bg-wash text-ink" : "text-mid"}`}><Icon name={item.icon} /></button>)}
    <input type="color" aria-label="Marker color" title="Marker color" value={marker.color} onChange={event => onMarker({...marker,color:event.target.value})} className="h-8 w-8 cursor-pointer border-0 bg-transparent p-1" />
    <select aria-label="Marker thickness" title="Marker thickness" value={marker.width} onChange={event => onMarker({...marker,width:Number(event.target.value)})} className="h-8 cursor-pointer bg-transparent text-xs text-mid">
      {[.5,1,2,4].map(width => <option key={width} value={width}>{width}×</option>)}
    </select>
    <button type="button" aria-label="Undo" title="Undo" disabled={undoDisabled} onClick={onUndo} className="flex h-8 w-8 items-center justify-center disabled:opacity-30"><Icon name="back" /></button>
    <button type="button" aria-label="Clear" title="Clear" disabled={empty} onClick={onClear} className="flex h-8 w-8 items-center justify-center disabled:opacity-30"><Icon name="discard" /></button>
  </div>;
}
export function MarkupInput({value, onChange, onCommit, onCancel, style}: {
  value: string; onChange: (text: string) => void; onCommit: () => void; onCancel: () => void; style: CSSProperties;
}) {
  return <input autoFocus aria-label="note on the picture" placeholder="Note" value={value} onChange={event => onChange(event.target.value)}
    onBlur={onCommit} onKeyDown={event => {if (event.key === "Enter") {event.preventDefault(); onCommit();} if (event.key === "Escape") {event.preventDefault(); onCancel();}}}
    className="absolute min-w-36 -translate-y-full border-b-2 border-[#d23c2e] bg-card/90 px-1 text-[14px] font-semibold text-[#d23c2e] outline-none" style={style} />;
}
