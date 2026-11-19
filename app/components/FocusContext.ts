import {createContext} from "react";
import type {DiffQuote} from "../lib/drafts";
import type {Snapshot} from "../lib/types";

export const EmbeddedReviews=createContext<null|{owners:Map<string,{id:string;name:string}>;quote:(quote:DiffQuote)=>void}>(null);
export const ConversationCards=createContext<null|{state:Snapshot;batchEntry?:number;onTask:(id:string)=>void;onSent:()=>void}>(null);

// Parsing only depends on roster membership, not live fleet activity.
export const ConversationReferences=createContext<string|null>(null);

// Titles update independently of live activity; IDs remain navigation keys.
export const CoordinationTitles=createContext<ReadonlyMap<string,string>>(new Map());
