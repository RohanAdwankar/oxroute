// Production UI/daemon with a credential-free local harness and a persistent disposable store.
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {chromium,webkit} from 'playwright';
const {WebSocketServer}=createRequire(import.meta.url)('next/dist/compiled/ws');
assert.ok(process.env.TEST_DAEMON);assert.ok(process.env.TEST_URL);
await mkdir(resolve('.tmp'),{recursive:true});const root=await mkdtemp(resolve('.tmp/focus-continuation-'));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const until=async check=>{for(let i=0;i<180;i++){if(await check())return;await pause(75);}assert.fail('Runtime condition did not arrive');};
const transport=createServer(),ws=new WebSocketServer({server:transport}),rpcPort=await listen(transport);
let serial=0,focusThread='',focusMode=false,focusTurns=0,interrupts=0,releaseNext;
const nextGate=new Promise(done=>{releaseNext=done;}),never=new Promise(()=>{}),ids=[],inputs=[];
ws.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);if(id===undefined)return;
 let result={};
 if(method==='thread/start')result={thread:{id:`session-${++serial}`}};
 if(method==='thread/resume')result={thread:{id:params.threadId}};
 if(method==='turn/interrupt')interrupts++;
 if(method==='turn/start'){
  const turn={id:`turn-${++serial}`,status:'completed'};result={turn};
  if(focusMode&&!focusThread&&!params.outputSchema)focusThread=params.threadId;
  const isFocus=params.threadId===focusThread&&!params.outputSchema,n=isFocus?++focusTurns:0;
  if(isFocus)inputs.push(params.input);
  const chosen=n===2?ids.slice(3):ids.slice(0,3);
  const text=params.outputSchema?JSON.stringify({actions:[],title:'Focus',tags:[]}):isFocus?chosen.map((id,i)=>`[Recommended conversation ${i+1}](#agent/${id})`).join('\n'):'Current evidence and options are ready.';
  void(async()=>{
   if(n===2)await nextGate;if(n===3)await never;
   await pause(20);
   for(const [method,extra]of[['turn/started',{turn}],['item/completed',{item:{id:`message-${turn.id}`,type:'agentMessage',text,phase:'final_answer'}}],['turn/completed',{turn}]])if(socket.readyState===1)socket.send(JSON.stringify({method,params:{threadId:params.threadId,...extra}}));
  })();
 }
 socket.send(JSON.stringify({id,result}));
}));
const reserve=createServer(),port=await listen(reserve);await new Promise(done=>reserve.close(done));
const native=`http://127.0.0.1:${port}`,config=join(root,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(root,'db.sqlite3'))}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const env={PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',RUST_LOG:'warn',CODEX_HOME:join(root,'codex'),OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:`ws://127.0.0.1:${rpcPort}`,OXROUTE_CODEX_CLI:'/bin/false'};
const start=()=>spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env});let daemon=start();
const proxy=createServer((req,res)=>{
 if(req.url==='/paused'){res.end('<!doctype html><title>Paused</title>');return;}
 const upstream=new URL(req.url,req.url.startsWith('/api/')&&!req.url.startsWith('/api/version')?native:process.env.TEST_URL);
 const call=request(upstream,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});call.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(call);res.on('close',()=>call.destroy());
});const ui=`http://127.0.0.1:${await listen(proxy)}`;
const api=async(path,body,method='POST')=>{const r=await fetch(native+path,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${r.status} ${await r.clone().text()}`);return r.json();};
const healthy=()=>until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
let browser;
try{
 await healthy();for(const name of ['automatic-titles','automatic-tags','recommendation-learning','next-action-suggestions'])await api(`/api/${name}`,{enabled:false});
 for(let i=0;i<6;i++){
  const agent=await api('/api/agents',{});ids.push(agent.id);await api('/api/rename',{agent:agent.id,name:`Workstream ${i+1}`});
  await api('/api/say',{agent:agent.id,text:'Summarize current evidence'});
  await until(async()=>(await api(`/api/agents/${agent.id}`)).timeline.some(entry=>entry.kind==='said'));
 }
 const task=await api('/api/tasks',{text:'Review independent evidence'});
 await api(`/api/tasks/${task.id}`,{...task,agentId:ids[0],status:'done',note:'Ready for human review'},'PUT');
 const historical=await api('/api/tasks',{text:'Historical approved work'});
 await api(`/api/tasks/${historical.id}`,{...historical,agentId:ids[0],status:'complete',approved:true,note:'Explicit fixture human sign-off'},'PUT');
 const diagram=await fetch(native+'/api/task-diagram.svg').then(r=>r.text());assert.ok(!diagram.includes(historical.text)&&diagram.includes(task.text),'Real diagram hides completed records and retains work awaiting review');
 const before=await api('/api/tasks');focusMode=true;
 browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(ui);await page.getByRole('tab',{name:'Focus',exact:true}).click();
 const decks=page.locator('[data-focus-deck]'),first=decks.first();await first.waitFor();
 const focusId=(await api('/api/state')).focusAgentId;
 const detail=()=>api(`/api/agents/${focusId}`);
 const source=()=>detail().then(view=>view.timeline.findLast(entry=>entry.kind==='said'&&entry.text.includes('#agent/')).id);
 const firstEntry=await source(),firstBatch={entryId:firstEntry,agentIds:ids.slice(0,3)};
 const composer=page.locator('[data-composer]');await composer.fill('Keep the Focus draft.');
 const inline=first.getByRole('textbox',{name:'Reply to Workstream 1',exact:true});await inline.fill('Keep this inline draft.');
 await first.getByRole('button',{name:'Next card',exact:true}).click();await first.locator(`[data-focus-conversation="${ids[1]}"]`).waitFor();
 await first.getByRole('button',{name:'Next card',exact:true}).click();await first.locator(`[data-focus-conversation="${ids[2]}"]`).waitFor();
 assert.equal(focusTurns,1,'Viewing the last card alone does not manufacture a completed review');
 await first.getByRole('button',{name:'Next card',exact:true}).click();await until(async()=>focusTurns===2);
 assert.equal(await inline.inputValue(),'Keep this inline draft.');assert.equal(await composer.inputValue(),'Keep the Focus draft.');
 await Promise.all(Array.from({length:8},()=>api('/api/focus/batches',firstBatch)));
 assert.equal(focusTurns,2,'Concurrent retries cannot wake Focus twice');
 assert.deepEqual(await api('/api/tasks'),before,'Traversal never approves or completes tasks');
 releaseNext();await until(async()=>decks.count().then(n=>n===2));
 const second=decks.nth(1);await second.locator(`[data-focus-conversation="${ids[3]}"]`).waitFor();
 assert.ok(JSON.stringify(inputs[1]).includes(ids[0])&&JSON.stringify(inputs[1]).includes('reviewedConversations'),'Continuation carries the reviewed batch and current evidence');
 for(let i=0;i<3;i++)await second.getByRole('button',{name:'Next card',exact:true}).click();
 await page.waitForFunction(()=>![...document.querySelectorAll('[data-focus-deck] button')].some(button=>button.getAttribute('aria-busy')==='true'));
 assert.equal(focusTurns,2,'Exhausting all conversations stops without a model wake');
 const secondEntry=await source();await api('/api/focus/batches',{entryId:secondEntry,agentIds:ids.slice(3)});assert.equal(focusTurns,2);
 assert.equal((await api('/api/focus/batches',firstBatch)).queued,false,'Old stacks cannot keep a continuation loop alive');
 // A new explicit user message starts a new review cycle. Its active turn must not be interrupted.
 await api('/api/say',{agent:focusId,text:'Review the current conversations again.'});await until(async()=>focusTurns===3&&(await detail()).agent.status==='working');
 const queued={entryId:secondEntry,agentIds:ids.slice(3)};assert.equal((await api('/api/focus/batches',queued)).queued,true);
 await pause(100);assert.equal(focusTurns,3,'Continuation waits for an active Focus turn');assert.equal(interrupts,0);
 await page.goto(ui+'/paused');daemon.kill('SIGKILL');await new Promise(done=>daemon.exitCode!==null?done():daemon.once('exit',done));daemon=start();await healthy();
 await api('/api/focus/batches',queued);await until(async()=>focusTurns===4&&(await detail()).agent.status==='complete');
 await api('/api/focus/batches',queued);assert.equal(focusTurns,4,'The pending receipt survives restart and is delivered once');
 assert.deepEqual(await api('/api/tasks'),before);assert.deepEqual(errors,[]);
 await page.goto(ui+'/?view=focus');await decks.first().waitFor();assert.equal(await composer.inputValue(),'Keep the Focus draft.');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 console.log('Focus continues completed batches once, carries reviewed context, preserves drafts and approval state, stops exhausted/stale stacks, queues behind active turns and recovers pending continuation across restart.');
}finally{
 releaseNext();await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));daemon.kill('SIGKILL');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));for(const client of ws.clients)client.terminate();await new Promise(done=>ws.close(done));await new Promise(done=>transport.close(done));await rm(root,{recursive:true,force:true});
}
