// Real disposable daemon and SQLite recovery, using a credential-free local harness.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
const {WebSocketServer}=createRequire(import.meta.url)('next/dist/compiled/ws');
assert.ok(process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'),{recursive:true});const root=await mkdtemp(resolve('.tmp/focus-events-'));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(check,label)=>{for(let n=0;n<200;n++){if(await check())return;await pause(50);}assert.fail(label);};
const transport=createServer(),rpc=new WebSocketServer({server:transport}),rpcPort=await listen(transport);
const opened=[];
let serial=0,focusThread='',rejectFocus=false,rejected=0,interrupts=0;
const turns=[],sessions=new Map();
const send=(socket,method,params)=>{if(socket.readyState===1)socket.send(JSON.stringify({method,params}));};
const finish=(threadId,status='completed',notify=true,text='Local investigation result.')=>{
 const current=sessions.get(threadId);current.turn.status=status;
 current.turn.items=[{id:`answer-${current.turn.id}`,type:'agentMessage',text,phase:'final_answer'}];
 if(notify){for(const item of current.turn.items)send(current.socket,'item/completed',{threadId,item});send(current.socket,'turn/completed',{threadId,turn:current.turn});}
};
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);if(id===undefined)return;
 let result={};
 if(method==='thread/start'){result={thread:{id:`session-${++serial}`}};opened.push({thread:result.thread.id,...params});}
 if(method==='thread/resume'){
  const saved=sessions.get(params.threadId);if(saved)saved.socket=socket;
  result={thread:{id:params.threadId,turns:saved?[saved.turn]:[]}};
 }
 if(method==='turn/interrupt'){interrupts++;finish(params.threadId,'interrupted');}
 if(method==='turn/start'){
  if(params.threadId===focusThread&&rejectFocus){rejected++;socket.send(JSON.stringify({id,error:{code:-32000,message:'Temporary transport rejection'}}));return;}
  const turn={id:`turn-${++serial}`,status:'inProgress',items:[]};result={turn};
  sessions.set(params.threadId,{turn,socket});turns.push({...params,turn});
  setTimeout(()=>send(socket,'turn/started',{threadId:params.threadId,turn}),5);
 }
 socket.send(JSON.stringify({id,result}));
}));
const reserve=createServer(),port=await listen(reserve);await new Promise(done=>reserve.close(done));
const base=`http://127.0.0.1:${port}`,config=join(root,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(root,'state.sqlite3'))}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const env={PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',RUST_LOG:'warn',CODEX_HOME:join(root,'codex'),OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:`ws://127.0.0.1:${rpcPort}`,OXROUTE_CODEX_CLI:'/bin/false'};
const start=()=>spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env});let daemon=start();
const stop=async()=>{daemon.kill('SIGKILL');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));};
const api=async(path,body,method='POST')=>{const r=await fetch(base+path,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${r.status} ${await r.clone().text()}`);return r.json();};
const healthy=()=>until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}},'Daemon did not start');
const focusTurns=()=>turns.filter(turn=>turn.threadId===focusThread);
const worker=async()=>{
 const agent=await api('/api/agents',{}),count=turns.length;
 await api('/api/say',{agent:agent.id,text:'Inspect authorized local evidence'});
 await until(()=>turns.length>count,'Worker did not start');
 return {agent,thread:turns.at(-1).threadId};
};
try {
 await healthy();for(const name of ['automatic-titles','automatic-tags','recommendation-learning','next-action-suggestions'])await api(`/api/${name}`,{enabled:false});
 const first=await worker();await writeFile(join(root,'inspection-result.txt'),'Representative inspection evidence.\n');finish(first.thread,'completed',true,'The inspection result and its supporting evidence are available.');await until(async()=>(await api(`/api/agents/${first.agent.id}`)).agent.status==='complete','Initial result did not settle');
 const focus=await api('/api/focus/agent',{});await until(()=>turns.length===2,'Focus did not open');focusThread=turns.at(-1).threadId;
 const second=await worker();await writeFile(join(root,'prepared-result.txt'),'Representative prepared artifact.\n');finish(second.thread,'completed',true,'The requested artifact is prepared with inspected evidence; review remains outstanding.');await until(async()=>(await api(`/api/agents/${second.agent.id}`)).agent.status==='complete','Second result did not settle');
 const detail=id=>api(`/api/agents/${id}`);
 const evidence=async id=>{const data=await detail(id);return {request:data.timeline.filter(e=>e.kind==='you').at(-1).id,result:data.timeline.filter(e=>e.kind==='said').at(-1).id};};
 const firstEvidence=await evidence(first.agent.id),secondEvidence=await evidence(second.agent.id);
 const connection=opened.find(value=>value.thread===focusThread).config['mcp_servers.oxroute_internal'];
 const call=async args=>{
  const response=await fetch(connection.url,{method:'POST',headers:{'content-type':'application/json',authorization:connection.http_headers.Authorization},body:JSON.stringify({jsonrpc:'2.0',id:++serial,method:'tools/call',params:{name:'publish_focus_update',arguments:args}})});
  assert.ok(response.ok);return(await response.json()).result;
 };
 const update=(kind,owner,ref,outcomeId)=>({requestId:crypto.randomUUID(),kind,outcomeId,sourceAgentId:owner.id,sourceRequestEntryId:ref.request,sourceContextEntryId:ref.request,revisionEntryId:ref.request,focusCycle:0,text:kind==='decision'?'Choose a validation environment.':'Source inspection is complete; preparation continues.'});
 const informational=update('progress',first.agent,firstEvidence,'progress-0'),firstProgress=(await call(informational)).structuredContent;assert.ok(firstProgress);
 assert.deepEqual((await call({...informational,requestId:crypto.randomUUID()})).structuredContent,firstProgress,'Unchanged progress is not repeated with fresh request IDs');
 assert.equal((await call({...update('progress',first.agent,firstEvidence,'progress-1'),text:'Validation evidence is being collected.'})).isError,false);
 for(let i=0;i<2;i++)assert.equal((await call({...update('decision',first.agent,firstEvidence,`decision-${i}`),text:i===0?'Choose a validation environment.':'Choose a release window.'})).isError,false);
 const task=await api('/api/tasks',{text:'Validate generated result'});
 await api(`/api/tasks/${task.id}`,{...task,agentId:second.agent.id,status:'done',note:'Prepared result, approval remains outstanding'},'PUT');
 const completed={...update('completion',second.agent,secondEvidence,'requested-result'),text:'The requested artifact is prepared. Review is still outstanding.',qualification:'prepared',evidenceEntryIds:[secondEvidence.result],taskId:task.id};
 const delivered=await call(completed);assert.equal(delivered.isError,false);const receipt=delivered.structuredContent;
 const visible=async()=>(await detail(focus.id)).timeline.filter(entry=>entry.id===receipt.entryId);
 assert.equal((await visible()).length,1);assert.ok((await visible())[0].text.startsWith('Prepared:'));
 assert.equal((await api('/api/tasks')).find(t=>t.id===task.id).status,'done','Completion does not approve tracked work');
 const duplicate={...completed,requestId:crypto.randomUUID()};assert.deepEqual((await call(duplicate)).structuredContent,receipt);
 finish(focusThread,'completed',true,'');await until(()=>focusTurns().length===2,'Queued event check did not run');
 const context=focusTurns().at(-1).input.map(i=>i.text??'').join('\n');
 assert.ok(context.includes('"unansweredDecisions":2')&&context.includes('"kind":"progress"')&&context.includes('"kind":"completion"'),'Only explicit decisions count; completed publication remains in context');
 assert.ok(context.includes('independently of unrelated unanswered')&&context.includes('This reminder limit does not suppress a new relevant completion notification')&&context.includes('user opt-outs')&&context.includes('not a delivered user-facing completion'),'Publication policy and wake/publication distinction reach the runtime');
 await api('/api/say',{agent:first.agent.id,text:'Investigate a separate independent outcome.'});await until(async()=>(await detail(first.agent.id)).agent.status==='working','Separate work did not start');
 const unrelated=(await detail(first.agent.id)).timeline.filter(e=>e.kind==='you').at(-1).id;
 const retained={...update('completion',first.agent,firstEvidence,'earlier-inspection'),sourceContextEntryId:unrelated,qualification:'prepared',evidenceEntryIds:[firstEvidence.result],text:'The earlier inspection result remains available; the separate request did not invalidate it.'};
 assert.equal((await call(retained)).isError,false,'Fresh inspection allows a still-valid result that predates an unrelated later message');
 await api('/api/interrupt',{agent:first.agent.id});
 const taskBody=(await api('/api/tasks')).find(t=>t.id===task.id);
 await api(`/api/tasks/${task.id}`,{...taskBody,status:'incomplete',note:'A newer revision requires preparation'},'PUT');
 assert.equal((await call({...completed,requestId:crypto.randomUUID()})).isError,true,'A reopened task rejects old result evidence');
 assert.deepEqual((await call(duplicate)).structuredContent,receipt,'An accepted duplicate request retains its receipt after reopening');
 await until(()=>turns.some(t=>t.threadId===second.thread&&t.turn.status==='inProgress'),'Reopened work did not start');
 await writeFile(join(root,'revised-result.txt'),'Representative revised artifact.\n');finish(second.thread,'completed',true,'The revised artifact and its supporting evidence are prepared; review remains outstanding.');await until(async()=>(await detail(second.agent.id)).agent.status==='complete','Reopened result did not settle');
 const refreshed=await evidence(second.agent.id),newCompletion={...completed,requestId:crypto.randomUUID(),evidenceEntryIds:[refreshed.result],text:'The revised artifact is prepared from the new requirements. Review remains outstanding.'};
 const freshReceipt=(await call(newCompletion)).structuredContent;assert.ok(freshReceipt&&freshReceipt.entryId!==receipt.entryId,'Fresh result evidence permits a new revision');
 assert.equal((await api('/api/tasks')).find(t=>t.id===task.id).status,'incomplete','Publishing never closes a reopened task');
 await api('/api/say',{agent:second.agent.id,text:'Use the corrected source requirements.'});await until(async()=>(await detail(second.agent.id)).agent.status==='working','New source correction did not start');
 assert.equal((await call({...newCompletion,requestId:crypto.randomUUID()})).isError,true,'A newer source request supersedes the old completion');
 const correction=(await detail(second.agent.id)).timeline.filter(e=>e.kind==='you').at(-1).id;
 assert.equal((await call({...newCompletion,requestId:crypto.randomUUID(),sourceContextEntryId:correction,revisionEntryId:correction})).isError,true,'Evidence must follow a relevant correction even after refreshing the inspection context');
 assert.deepEqual((await call(completed)).structuredContent,receipt);
 await api('/api/interrupt',{agent:second.agent.id});await api('/api/interrupt',{agent:focus.id});
 assert.deepEqual((await call(completed)).structuredContent,receipt);
 assert.equal((await call({...completed,requestId:crypto.randomUUID(),outcomeId:'another-outcome'})).isError,true,'Stopped Focus cannot publish new autonomous updates');
 if(process.env.TEST_URL){
  const {chromium}=await import('playwright'),browser=await chromium.launch();
  try{const page=await browser.newPage({viewport:{width:1280,height:1000}});await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());if(url.pathname==='/api/version')return route.continue();if(request.method()!=='GET')return route.fulfill({json:[]});return route.fulfill({response:await page.request.get(base+url.pathname+url.search,{headers:request.headers()})});});await page.goto(`${process.env.TEST_URL}/?agent=${focus.id}`);await page.locator(`[data-entry="${freshReceipt.entryId}"]`).waitFor();assert.equal(await page.locator(`[data-entry="${receipt.entryId}"]`).count(),1);if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});}finally{await browser.close();}
 }
 await stop();daemon=start();await healthy();assert.deepEqual((await call(duplicate)).structuredContent,receipt,'Visible publication receipts survive restart');
 assert.equal((await visible()).length,1);
 const before=focusTurns().length;await api('/api/say',{agent:focus.id,text:'Answer this new direct request.'});await until(()=>focusTurns().length>before,'Direct replies must remain available after stop');
 await api('/api/interrupt',{agent:focus.id});
 console.log('Authenticated native publication delivered one relevant completion despite two unrelated progress updates and two pending decisions; duplicate/restart receipts, new revisions, task reopen evidence, stop, direct replies and unchanged approval state pass.');
}finally{await stop();for(const socket of rpc.clients)socket.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>transport.close(done));await rm(root,{recursive:true,force:true});}
