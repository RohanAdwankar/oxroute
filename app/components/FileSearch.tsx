"use client";
import {useEffect, useState} from "react";

type Hit = {path: string; line: number; text: string};
type Context = {path: string; root: string; lines: {line: number; text: string}[]};
async function read<T>(url: string, signal: AbortSignal): Promise<T> {const result=await fetch(url,{signal});if(!result.ok)throw new Error(await result.text());return result.json();}
export function FileSearch({agent, query, mode}: {agent: string; query: string; mode: "names" | "contents"}) {
 const [hits,setHits]=useState<Hit[]>([]),[selected,setSelected]=useState(0),[context,setContext]=useState<Context|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(false),[line,setLine]=useState(1);
 const hit=hits[selected];
 useEffect(()=>{
  setHits([]);setContext(null);setError("");setSelected(0);setLoading(Boolean(agent&&query.trim()));
  if(!agent||!query.trim())return;
  const controller=new AbortController();
  const timer=setTimeout(()=>void read<Hit[]>(`/api/agents/${encodeURIComponent(agent)}/files/search?${new URLSearchParams({q:query,mode})}`,controller.signal).then(value=>{setHits(value);setLine(value[0]?.line??1);setLoading(false);}).catch(reason=>{if(!controller.signal.aborted){setError(String(reason));setLoading(false);}}),150);
  return()=>{clearTimeout(timer);controller.abort();};
 },[agent,query,mode]);
 useEffect(()=>{
  setContext(null);if(!hit)return;
  const controller=new AbortController();
  void read<Context>(`/api/agents/${encodeURIComponent(agent)}/files/context?${new URLSearchParams({path:hit.path,line:String(line)})}`,controller.signal).then(setContext).catch(reason=>{if(!controller.signal.aborted)setError(String(reason));});
  return()=>controller.abort();
 },[agent,hit,line]);
 return <div className="flex h-[min(72vh,720px)] min-h-0 border-t border-rule" onKeyDown={event=>{if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();const next=Math.max(0,Math.min(hits.length-1,selected+(event.key==="ArrowDown"?1:-1)));setSelected(next);setLine(hits[next]?.line??1);}}}>
  <div className="w-[42%] overflow-y-auto border-r border-rule" role="listbox" aria-label="File search results">
   {!agent?<p className="p-4 text-xs text-faint">Open a conversation to search its working folder.</p>:!hits.length?<p role="status" className="p-4 text-xs text-faint">{error|| (loading?"Searching files…":query.trim()?"No matching files.":"Type to search project files. Project ignore rules apply.")}</p>:hits.map((item,index)=><button type="button" role="option" aria-selected={selected===index} key={`${item.path}:${item.line}`} className={`block w-full cursor-pointer px-4 py-3 text-left text-xs ${selected===index?"bg-band":"hover:bg-paper"}`} onClick={()=>{setSelected(index);setLine(item.line);}}><span className="block break-all">{item.path}{mode==="contents"?`:${item.line}`:""}</span>{item.text&&<span className="mt-1 block truncate text-faint">{item.text}</span>}</button>)}
   {hits.length===200&&<p className="p-4 text-xs text-faint">Showing the first 200 matches. Narrow your search for more specific results.</p>}
  </div>
  <div className="flex min-w-0 flex-1 flex-col bg-paper">
   <div className="flex shrink-0 items-center gap-3 bg-band px-4 py-3 text-xs"><span className="min-w-0 flex-1 truncate" title={context?.root}>{context?`${context.root}/${context.path}`:"File preview"}</span>{context&&<button onClick={()=>void navigator.clipboard.writeText(`${context.root}/${context.path}`)}>Copy path</button>}</div>
   {error&&hits.length>0&&<p role="alert" className="p-4 text-xs text-hold">{error}</p>}
   <pre className="min-h-0 flex-1 overflow-auto p-4 text-xs">{context?.lines.map(item=><div key={item.line} className={item.line===hit?.line?"bg-mine":""}><span className="mr-4 select-none text-faint">{item.line}</span>{item.text}</div>)}</pre>
   {context&&<div className="flex gap-4 px-4 py-2 text-xs"><button disabled={context.lines[0]?.line===1} onClick={()=>setLine(Math.max(1,(context.lines[0]?.line??1)-60))}>Earlier lines</button><button disabled={context.lines.length<100} onClick={()=>setLine((context.lines.at(-1)?.line??0)+1)}>More lines</button></div>}
  </div>
 </div>;
}
