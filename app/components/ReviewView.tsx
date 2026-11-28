"use client";
import {useEffect,useState,type ComponentProps} from "react";
import {FileReviewEntry} from "./FileReview";
import {GitReview} from "./GitReview";
import {cachedReview,loadReview,reviewEndpoint} from "../lib/reviews";

/** Every review slot renders through here; the kind picks the renderer. */
export function ReviewView(props:ComponentProps<typeof GitReview>) {
  const endpoint=reviewEndpoint(props.agentId,props.reviewId);
  const [kind,setKind]=useState(()=>cachedReview(endpoint)?.kind),[error,setError]=useState("");
  useEffect(()=>{if(!kind)loadReview(endpoint).then(review=>setKind(review.kind),reason=>setError(String(reason)));},[kind,endpoint]);
  if(error)return <p role="alert" className="p-5 text-hold">{error}</p>;
  return kind==="file"?<FileReviewEntry agentId={props.agentId} reviewId={props.reviewId}/>:kind?<GitReview {...props}/>:null;
}
