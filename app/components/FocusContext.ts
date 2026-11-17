import {createContext} from "react";
import type {DiffQuote} from "../lib/drafts";
import type {Snapshot} from "../lib/types";

export const EmbeddedReviews=createContext<null|{owners:Map<string,{id:string;name:string}>;quote:(quote:DiffQuote)=>void}>(null);
export const ConversationCards=createContext<null|{state:Snapshot;onTask:(id:string)=>void;onSent:()=>void}>(null);
