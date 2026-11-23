"use client";
import {useEffect,useRef,useState} from 'react';
import {loadReviewImage} from '../lib/reviews';
import {Icon} from './Icon';

export function GifComparison({endpoint,path,full}:{endpoint:string;path:string;full:boolean}){
  const canvases=useRef<(HTMLCanvasElement|null)[]>([]),replay=useRef(()=>{});
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const urls=['before','after'].map(side=>`${endpoint}/image?${new URLSearchParams({path,side,...(full?{full:'true'}:{})})}`);
  const key=urls.join('\n');
  useEffect(()=>{
    let live=true,animation=0,origin=0,next=0,busy=true,started=false,token=0;
    setReady(false);setError('');
    const worker=new Worker(new URL('../lib/gif-worker.ts',import.meta.url));
    const fail=(message:string)=>{if(live){setError(message);setReady(false);cancelAnimationFrame(animation);}};
    const tick=(now:number)=>{
      if(!busy&&now-origin>=next){busy=true;worker.postMessage({time:now-origin,token});}
      animation=requestAnimationFrame(tick);
    };
    worker.onerror=()=>fail('Could not decode comparison');
    worker.onmessage=(event:MessageEvent<{error?:string;token:number;replay?:boolean;next:number;sides:{side:number;width:number;height:number;pixels:ArrayBuffer}[]}>)=>{
      if(!live||event.data.token!==token)return;
      if(event.data.error){fail(event.data.error);return;}
      for(const side of event.data.sides){
        const canvas=canvases.current[side.side]!;
        if(canvas.width!==side.width||canvas.height!==side.height){canvas.width=side.width;canvas.height=side.height;}
        canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(side.pixels),side.width,side.height),0,0);
      }
      busy=false;next=event.data.next;if(event.data.replay)origin=performance.now();
      if(!started){started=true;origin=performance.now();setReady(true);animation=requestAnimationFrame(tick);}
    };
    replay.current=()=>{if(!started)return;busy=true;worker.postMessage({time:0,replay:true,token:++token});};
    Promise.all(key.split('\n').map(url=>loadReviewImage(url,"high",attempt>0).then(blob=>blob.arrayBuffer()))).then(buffers=>{
      if(live)worker.postMessage({buffers},{transfer:buffers});
    }).catch(()=>fail('Could not load comparison'));
    return()=>{live=false;cancelAnimationFrame(animation);worker.terminate();replay.current=()=>{};};
  },[key,attempt]);
  return <>{urls.map((url,side)=><figure key={url} className="min-w-0 flex-1">
    <figcaption className="mb-2 flex items-center gap-2 text-[11px] text-faint">{side===0?'Before':'After'}{side===0&&<button type="button" aria-label={error?"Retry comparison":"Replay comparison"} title={error?"Retry comparison":"Replay comparison"} disabled={!ready&&!error} onClick={()=>error?setAttempt(value=>value+1):replay.current()} className="cursor-pointer disabled:opacity-40"><Icon name="refresh" size={12}/></button>}</figcaption>
    <a href={url} target="_blank" rel="noreferrer" title={`Open ${side===0?'before':'after'} image`}><canvas ref={node=>{canvases.current[side]=node;}} role="img" aria-label={`${side===0?'Before':'After'} ${path}`} hidden={!ready} className="mx-auto h-auto max-h-96 max-w-full" style={{backgroundImage:'repeating-conic-gradient(#8882 0% 25%, transparent 0% 50%)',backgroundSize:'16px 16px'}}/></a>
    {side===0&&!ready&&<span role={error?'alert':'status'} className="text-[12px] text-mid">{error||'Loading comparison…'}</span>}
  </figure>)}</>;
}
