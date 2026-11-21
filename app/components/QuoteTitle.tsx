"use client";
import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {Icon} from "./Icon";

/** Keep title selections intact when a context menu changes browser selection. */
export function QuoteTitle({text,onQuote}:{text:string;onQuote:(text:string)=>void}) {
  const title=useRef<HTMLSpanElement>(null),selected=useRef(""),touch=useRef(false);
  const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
  useEffect(()=>{
    const remember=()=>{
      const selection=window.getSelection();
      if(!selection?.rangeCount||selection.isCollapsed)return;
      const range=selection.getRangeAt(0);
      selected.current=title.current?.contains(range.commonAncestorContainer)?selection.toString():"";
      if(touch.current&&selected.current){const box=range.getBoundingClientRect();setMenu({x:Math.min(box.left,window.innerWidth-48),y:Math.min(box.bottom,window.innerHeight-48)});}
    };
    const dismiss=(event:PointerEvent)=>{if(event.button===0&&!(event.target as Element).closest('[data-title-actions]')){selected.current="";setMenu(null);}};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setMenu(null);};
    document.addEventListener('selectionchange',remember);document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('selectionchange',remember);document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);};
  },[]);
  return <>
    <span ref={title} data-quote-title className="inline-block max-w-full" onPointerDown={event=>{touch.current=event.pointerType==='touch';
      const selection=window.getSelection();if(selection?.rangeCount&&!selection.isCollapsed&&title.current?.contains(selection.getRangeAt(0).commonAncestorContainer))selected.current=selection.toString();
    }} onContextMenu={event=>{
      const selection=window.getSelection();if(!selected.current&&selection?.rangeCount&&!selection.isCollapsed&&title.current?.contains(selection.getRangeAt(0).commonAncestorContainer))selected.current=selection.toString();
      if(!selected.current)return;event.preventDefault();event.stopPropagation();setMenu({x:Math.min(event.clientX,window.innerWidth-48),y:Math.min(event.clientY,window.innerHeight-48)});
    }}>{text}</span>
    {menu&&createPortal(<span data-title-actions role="group" aria-label="Title actions" className="fixed z-50 bg-card p-2 shadow-md" style={{left:menu.x,top:menu.y}} onPointerDown={event=>event.preventDefault()}>
      <button type="button" aria-label="Quote title into chat" title="Quote title into chat" className="cursor-pointer" onClick={event=>{event.stopPropagation();onQuote(selected.current);setMenu(null);window.getSelection()?.removeAllRanges();}}><Icon name="quote"/></button>
    </span>,document.body)}
  </>;
}
