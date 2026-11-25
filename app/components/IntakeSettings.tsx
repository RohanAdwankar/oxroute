"use client";
import {useEffect,useState} from 'react';
import {Icon} from './Icon';

type Policy={source:string;account:string;sender:string;label:string;mode:'immediate'|'standard'|'excluded';delegationEntryId:number;effectiveAt:number};
type Status={policies:Policy[];connectors:{source:string;configured:boolean;lastSync:number|null;error:string|null}[]};
const initial={source:'slack-inbox',account:'',sender:'',label:'',mode:'immediate' as Policy['mode'],allSenders:false};
export function IntakeSettings(){
 const [state,setState]=useState<Status>(),[adding,setAdding]=useState(false),[draft,setDraft]=useState(initial),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const load=async()=>{const response=await fetch('/api/intake/policies');if(!response.ok)throw new Error('Could not load inbox policy');setState(await response.json());};
 useEffect(()=>{void load().catch(error=>setError(String(error)));},[]);
 const save=async(value:typeof initial)=>{
  setBusy(true);setError('');
  try{const response=await fetch('/api/intake/policies',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({source:value.source,account:value.account,sender:value.sender,label:value.label,mode:value.mode,allSenders:value.allSenders})});if(!response.ok)throw new Error((await response.json()).error??'Could not save inbox policy');await load();setAdding(false);setDraft(initial);}catch(error){setError(String(error));}finally{setBusy(false);}
 };
 return <section aria-label="Inbox routing" className="mb-4 text-[12px]">
  <div className="mb-2 flex items-center justify-between"><span className="font-semibold">Inbox routing</span><button type="button" aria-label="Add intake policy" title="Add intake policy" onClick={()=>setAdding(value=>!value)} className="cursor-pointer"><Icon name="plus" size={14}/></button></div>
  <p className="mb-2 text-[11px] text-faint">Immediate routes scoped requests to Focus. Standard joins the 20-minute review. Excluded stays out of Inbox while retaining history. Source messages never grant additional permissions.</p>
  {state?.connectors.map(connector=><div key={connector.source} className="flex justify-between gap-2 text-[11px] text-faint" title={connector.error??undefined}><span>{connector.source==='slack-inbox'?'Slack':'Outlook'}</span><span>{!connector.configured?'Not configured':connector.error?'Collection interrupted':connector.lastSync?'Collector running':'Awaiting collection'}</span></div>)}
  {state?.policies.map(policy=><div key={[policy.source,policy.account,policy.sender].join(':')} className="mt-2 flex items-center justify-between gap-2"><span className="min-w-0 truncate" title={`${policy.source} · ${policy.account} · ${policy.sender||'All senders'}`}>{policy.label||policy.sender||'Source account'}</span><select aria-label={`Routing for ${policy.label||policy.sender||policy.account}`} disabled={busy} value={policy.mode} onChange={event=>void save({...policy,mode:event.target.value as Policy['mode'],allSenders:!policy.sender})} className="bg-transparent"><option value="immediate">Immediate</option><option value="standard">Standard</option><option value="excluded">Excluded</option></select></div>)}
  {adding&&<form aria-label="New intake policy" onSubmit={event=>{event.preventDefault();void save(draft);}} className="mt-2 grid grid-cols-2 gap-2">
   <select aria-label="Intake source" value={draft.source} onChange={event=>setDraft({...draft,source:event.target.value})} className="bg-transparent"><option value="slack-inbox">Slack</option><option value="outlook-inbox">Outlook</option></select>
   <input aria-label="Source account" placeholder="Provider account ID" required value={draft.account} onChange={event=>setDraft({...draft,account:event.target.value})} className="min-w-0 bg-transparent outline-none"/>
   <select aria-label="Policy scope" value={draft.allSenders?'source':'sender'} onChange={event=>setDraft({...draft,allSenders:event.target.value==='source',sender:''})} className="bg-transparent"><option value="sender">One sender</option><option value="source">Entire source account</option></select>
   {!draft.allSenders&&<input aria-label="Sender identity" placeholder="Provider sender ID" required value={draft.sender} onChange={event=>setDraft({...draft,sender:event.target.value})} className="min-w-0 bg-transparent outline-none"/>}
   <input aria-label="Policy label" placeholder="Label" required value={draft.label} onChange={event=>setDraft({...draft,label:event.target.value})} className="min-w-0 bg-transparent outline-none"/>
   <select aria-label="Intake mode" value={draft.mode} onChange={event=>setDraft({...draft,mode:event.target.value as Policy['mode']})} className="bg-transparent"><option value="immediate">Immediate</option><option value="standard">Standard</option><option value="excluded">Excluded</option></select>
   <button type="submit" aria-label="Save intake policy" title="Save intake policy" disabled={busy} className="col-span-2 justify-self-end cursor-pointer disabled:opacity-40"><Icon name="tick" size={14}/></button>
  </form>}
  {error&&<p role="alert" className="mt-2 text-mid">{error}</p>}
 </section>;
}
