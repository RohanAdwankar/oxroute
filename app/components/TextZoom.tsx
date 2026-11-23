"use client";
import {useEffect} from "react";
import {textScale} from "../lib/keys";

export function TextZoom(){
  useEffect(()=>{
    textScale.get();
    const unsubscribe=textScale.subscribe(()=>{textScale.get();});
    const key=(event:KeyboardEvent)=>{
      if(!(event.metaKey||event.ctrlKey)||event.altKey)return;
      const step=['+','='].includes(event.key)?10:event.key==='-'?-10:event.key==='0'?0:null;
      if(step===null)return;
      event.preventDefault();event.stopPropagation();
      textScale.set(String(step?Math.max(25,Math.min(500,Number(textScale.get())+step)):100));
    };
    document.addEventListener('keydown',key,true);
    return()=>{document.removeEventListener('keydown',key,true);unsubscribe();};
  },[]);
  return null;
}
