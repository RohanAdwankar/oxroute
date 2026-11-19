import {startTransition, useEffect, useMemo, useRef, useState, type ReactNode} from "react";
import type {Line, Token} from "../lib/diff-highlighting";

type Code = Token[][];
let worker: Worker | undefined, serial=0;
const pending=new Map<number,{resolve:(code:Code)=>void;reject:(error:Error)=>void}>();
function highlight(rows:Line[], path:string):Promise<Code> {
  if(!worker) {
    worker=new Worker(new URL("../lib/diff-worker.ts",import.meta.url),{type:"module"});
    worker.onmessage=({data})=>{
      const request=pending.get(data.id);pending.delete(data.id);
      if(data.error)request?.reject(new Error(data.error));else request?.resolve(data.code);
    };
    worker.onerror=event=>{for(const request of pending.values())request.reject(new Error(event.message));pending.clear();worker?.terminate();worker=undefined;};
  }
  const id=++serial;
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker!.postMessage({id,rows,path});});
}

// Keep complete source in the document; style it as the reader approaches.
const waiting=new Map<Element,()=>void>();
let visibility:IntersectionObserver|undefined;
function approaching(element:Element, run:()=>void) {
  visibility??=new IntersectionObserver(entries=>{
    for(const entry of entries) if(entry.isIntersecting) {
      const next=waiting.get(entry.target);waiting.delete(entry.target);
      visibility!.unobserve(entry.target);next?.();
    }
  },{rootMargin:"240px"});
  waiting.set(element,run);visibility.observe(element);
  return()=>{waiting.delete(element);visibility!.unobserve(element);};
}

// Text stays readable and quotable while the worker computes exact highlighting.
export function DiffCode({rows,path,children}:{rows:Line[];path:string;children:(code:ReactNode[],ready:boolean)=>ReactNode}) {
  const [result,setResult]=useState<{rows:Line[];code:Code}|null>(null),[error,setError]=useState("");
  const element=useRef<HTMLDivElement>(null);
  useEffect(()=>{let live=true,ready:Code|undefined;setError("");
    const apply=()=>{
      if(!live||!ready)return;
      const selection=window.getSelection();
      if(element.current&&selection&&!selection.isCollapsed&&selection.rangeCount&&selection.getRangeAt(0).intersectsNode(element.current))return;
      const code=ready;ready=undefined;startTransition(()=>setResult({rows,code}));
    };
    document.addEventListener("selectionchange",apply);
    const target=element.current?.querySelector("pre");
    const stop=target&&approaching(target,()=>{
      highlight(rows,path).then(code=>{ready=code;apply();}).catch(error=>{if(live)setError(String(error));});
    });
    return()=>{live=false;stop?.();document.removeEventListener("selectionchange",apply);};
  },[rows,path]);
  const code=useMemo(()=>result?.rows===rows?result.code.map((tokens,index)=><>{tokens.map((token,at)=>at===0?token.text:<span key={at} className={token.className} data-diff-change={token.changed||undefined} style={token.changed?{backgroundColor:rows[index].next===null?"color-mix(in srgb, var(--color-remove) 24%, transparent)":"color-mix(in srgb, var(--color-ok) 24%, transparent)"}:undefined}>{token.text}</span>)}</>):rows.map(row=>row.text),[result,rows]);
  return <div ref={element} className="contents">{error&&<p role="alert" className="text-[12px] text-faint">{error}</p>}{children(code,result?.rows===rows)}</div>;
}
