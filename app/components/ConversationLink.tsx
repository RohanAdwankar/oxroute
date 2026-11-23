"use client";
import {useContext,type ComponentProps} from "react";
import {ConversationNavigation} from "./FocusContext";

/** Internal conversation links activate session tabs; modified clicks stay native. */
export function ConversationLink({id,entry,children,...props}:{id:string;entry?:number}&Omit<ComponentProps<"a">,"href"|"id">){
  const open=useContext(ConversationNavigation);
  const query=new URLSearchParams({agent:id,...(entry===undefined?{}:{entry:String(entry)})});
  return <a {...props} href={`?${query}`} onClick={event=>{
    props.onClick?.(event);
    if(!open||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||(props.target&&props.target!=="_self"))return;
    event.preventDefault();open(id,entry);
  }}>{children}</a>;
}
