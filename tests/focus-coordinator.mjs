// Reviewed daemon and production UI with an isolated local Codex JSON-RPC transport.
// The fixture uses no account credentials, inference endpoint or shared services.
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {chromium,webkit} from 'playwright';
const {WebSocketServer}=createRequire(import.meta.url)('next/dist/compiled/ws');
assert.ok(process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'),{recursive:true});const root=await mkdtemp(resolve('.tmp/focus-coordinator-'));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const until=async check=>{for(let i=0;i<160;i++){if(await check())return;await pause(75);}assert.fail('Expected runtime state did not arrive');};
const rpcHttp=createServer(),rpc=new WebSocketServer({server:rpcHttp}),rpcPort=await listen(rpcHttp);
let serial=0,interrupts=0;const taskIds=[],turns=[];
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);if(id===undefined)return;
 let result={};
 if(method==='thread/start')result={thread:{id:`focus-session-${++serial}`}};
 if(method==='thread/resume')result={thread:{id:params.threadId}};
 if(method==='turn/interrupt')interrupts++;
 if(method==='turn/start'){
  const turn={id:`turn-${++serial}`,status:'completed'};result={turn};
  const text=params.outputSchema?JSON.stringify({actions:[],title:'Focus',tags:[]}):taskIds.map((id,index)=>`[Prepared result ${index+1}](#task/${id})\n\nValidation evidence is ready. Review this result and approve it or request a revision.`).join('\n\n');
  if(!params.outputSchema)turns.push(params);
  setTimeout(()=>{for(const [method,extra]of[['turn/started',{turn}],['item/completed',{item:{id:`message-${turn.id}`,type:'agentMessage',text,phase:'final_answer'}}],['turn/completed',{turn}]])if(socket.readyState===1)socket.send(JSON.stringify({method,params:{threadId:params.threadId,...extra}}));},20);
 }
 socket.send(JSON.stringify({id,result}));
}));
const reserve=createServer(),port=await listen(reserve);await new Promise(done=>reserve.close(done));
const native=`http://127.0.0.1:${port}`,config=join(root,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(root,'test.sqlite3'))}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const env={PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',RUST_LOG:'warn',CODEX_HOME:join(root,'codex'),OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:`ws://127.0.0.1:${rpcPort}`,OXROUTE_CODEX_CLI:'/bin/false'};
const start=()=>spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env});let daemon=start();
let failRevision=true,releaseOpen;const openGate=new Promise(done=>{releaseOpen=done;});
const frontend=process.env.TEST_URL,proxy=createServer((req,res)=>{
 if(req.url==='/api/client-failures'){req.resume();res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
 if(req.url==='/paused'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Paused fixture</title>');return;}
 if(failRevision&&req.method==='POST'&&req.url.includes('/correction')){failRevision=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Revision temporarily unavailable'}));return;}
 const upstream=new URL(req.url,req.url.startsWith('/api/')&&!req.url.startsWith('/api/version')?native:frontend);
 const call=request(upstream,{method:req.method,headers:req.headers},async reply=>{if(req.url==='/api/focus/agent')await openGate;res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
 call.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(call);res.on('close',()=>call.destroy());
});const ui=`http://127.0.0.1:${await listen(proxy)}`;
const api=async(path,body,method='POST')=>{const response=await fetch(native+path,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`${path}: ${response.status} ${await response.clone().text()}`);return response.json();};
let browser;
try{
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 for(const path of ['automatic-titles','automatic-tags','recommendation-learning','next-action-suggestions'])await api(`/api/${path}`,{enabled:false});
 const worker=await api('/api/agents',{});await api('/api/rename',{agent:worker.id,name:'Storage validation'});
 for(const text of ['Review storage validation','Review network rollout','Review startup behavior']){
  const item=await api('/api/tasks',{text});taskIds.push(item.id);
  await api(`/api/tasks/${item.id}`,{...item,agentId:worker.id,status:'done',note:'Representative worker result awaiting human review'},'PUT');
 }
 const task={id:taskIds[0]};
 const existingFocus=await api('/api/focus/agent',{});await until(async()=>turns.length===1&&(await api(`/api/agents/${existingFocus.id}`)).agent.status==='complete');
 browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(ui);await page.getByRole('tab',{name:'Focus',exact:true}).click();
 await until(async()=>!!(await api('/api/state')).focusAgentId);
 const focusId=(await api('/api/state')).focusAgentId,detail=()=>api(`/api/agents/${focusId}`);
 await page.locator(`[data-agent-pane="${focusId}"]`).waitFor();
 await page.locator('[data-composer]').waitFor();assert.equal(await page.getByText('Opening Focus…',{exact:true}).count(),0,'Cached Focus opens before the special endpoint responds');releaseOpen();
 await until(async()=>turns.length===1&&(await detail()).agent.status==='complete');
 assert.ok(JSON.stringify(turns[0].input).includes(task.id),'The coordinator receives the current pending approval');
 assert.equal((await api('/api/tasks')).find(item=>item.id===task.id).status,'done','Briefing does not approve work');
 await page.locator(`[data-task-reference="${task.id}"]`).first().waitFor();
 assert.equal(await page.locator('[data-task-card]').count(),3,'All three recommendations render as embedded actionable cards');
 const composer=page.locator('[data-composer]');await composer.fill('Which evidence should I inspect before deciding?');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await until(async()=>turns.length===2&&(await detail()).agent.status==='complete');
 await composer.fill('Keep this coordinator draft.');
 await page.getByRole('button',{name:'Show the fleet',exact:true}).click();
 assert.equal(await page.locator(`[data-home-card="${focusId}"]`).count(),0,'The coordinator has one dedicated tab');
 await page.getByRole('tab',{name:'Focus',exact:true}).click();await composer.waitFor();assert.equal(await composer.inputValue(),'Keep this coordinator draft.');
 assert.equal(turns.length,2,'Reopening Focus does not run a duplicate briefing');
 await page.reload();await composer.waitFor();assert.equal(await composer.inputValue(),'Keep this coordinator draft.');
 assert.equal(await page.getByRole('tab',{name:'Focus',exact:true}).count(),1);
 const requestId=crypto.randomUUID();await api('/api/focus/messages',{agentId:focusId,targetId:worker.id,text:'Check the existing validation evidence without changing approval state.',requestId});
 await until(async()=>turns.length===4&&(await api(`/api/agents/${worker.id}`)).agent.status==='complete'&&(await detail()).agent.status==='complete');
 await api('/api/focus/messages',{agentId:focusId,targetId:worker.id,text:'Check the existing validation evidence without changing approval state.',requestId});await pause(100);assert.equal(turns.length,4);assert.equal(interrupts,0);
 assert.equal((await api('/api/tasks')).find(item=>item.id===task.id).status,'done');
 await api(`/api/agents/${worker.id}/tags`,{set:['role:review-agent']});
 const reportRequest=crypto.randomUUID(),report={agentId:worker.id,targetId:focusId,text:'Independent evidence is ready for coordination.',requestId:reportRequest};
 await api('/api/focus/messages',report);
 await until(async()=>turns.length===5&&(await detail()).agent.status==='complete');
 await api('/api/focus/messages',report);
 const reports=(await detail()).timeline.filter(entry=>entry.kind==='coordination'&&entry.requestId===reportRequest);
 assert.equal(reports.length,1,'Coordination retries retain one visible entry');assert.equal(reports[0].origin,worker.id);
 const reportRow=page.locator(`[data-entry="${reports[0].id}"]`);await reportRow.getByText('Internal update',{exact:true}).waitFor();
 assert.ok(!(await reportRow.getAttribute('class')).includes('bg-mine'),'Agent reports never use human styling');
 assert.equal(await reportRow.evaluate(node=>node.tagName),'DETAILS','Only Focus coordination uses a disclosure');
 assert.equal(await reportRow.getAttribute('open'),null);
 assert.equal(await reportRow.getByText(report.text,{exact:true}).isVisible(),false);
 if(process.env.COORDINATION_SCREENSHOT)await page.screenshot({path:process.env.COORDINATION_SCREENSHOT.replace('.png','-collapsed.png')});
 await reportRow.locator('summary').focus();await page.keyboard.press('Enter');
 await reportRow.getByText(report.text,{exact:true}).waitFor();
 assert.notEqual(await reportRow.getByText(report.text,{exact:true}).evaluate(node=>getComputedStyle(node).color),await page.getByText('Validation evidence is ready. Review this result and approve it or request a revision.',{exact:true}).first().evaluate(node=>getComputedStyle(node).color),'Expanded coordination is muted');

 const sourceLink=reportRow.getByRole('button',{name:'Open Review agent',exact:true});await sourceLink.waitFor();
 assert.equal(await sourceLink.innerText(),'Review agent');assert.ok(!(await sourceLink.innerText()).includes(worker.id.slice(-6)),'Visible sender labels omit IDs');
 for(const width of [1280,390]) {
  await page.setViewportSize({width,height:900});await reportRow.scrollIntoViewIfNeeded();
  const source=await sourceLink.boundingBox(),label=await reportRow.getByText('Internal update',{exact:true}).boundingBox();
  if(width===1280)assert.ok(Math.abs(source.y-label.y)<3,'Source attribution shares update metadata');
  assert.ok(source.x>=0&&source.x+source.width<=width,'Source remains visible at narrow widths');
  assert.ok(await sourceLink.isVisible());
  if(process.env.COORDINATION_SCREENSHOT)await page.screenshot({path:process.env.COORDINATION_SCREENSHOT.replace('.png',`-${width}.png`)});
 }
 await page.setViewportSize({width:1280,height:900});
 await sourceLink.focus();await page.keyboard.press('Enter');
 await page.locator(`[data-agent-pane="${worker.id}"]`).first().waitFor();
 const ordinaryReport=(await api(`/api/agents/${worker.id}`)).timeline.find(entry=>entry.kind==='coordination'&&entry.requestId===requestId);
 const ordinaryRow=page.locator(`[data-entry="${ordinaryReport.id}"]`);
 await ordinaryRow.getByText('Check the existing validation evidence without changing approval state.',{exact:true}).waitFor();
 assert.notEqual(await ordinaryRow.evaluate(node=>node.tagName),'DETAILS','Other conversation coordination stays expanded');
 assert.equal(await ordinaryRow.getByRole('button',{name:'Open Source agent',exact:true}).innerText(),'Source agent','Missing role metadata never exposes an ID');
 await api(`/api/agents/${focusId}/tags`,{set:['role:runtime-agent']});
 await until(async()=>await ordinaryRow.getByRole('button',{name:'Open Runtime agent',exact:true}).count()===1);


 await page.goto(`${ui}/?view=focus`);await composer.waitFor();

 assert.equal((await api('/api/tasks')).find(item=>item.id===task.id).status,'done','Reports never approve tasks');
 if(process.env.COORDINATION_SCREENSHOT){await reportRow.scrollIntoViewIfNeeded();await page.screenshot({path:process.env.COORDINATION_SCREENSHOT});}
 await page.goto(ui+'/paused');daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));daemon=start();
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 assert.equal((await api('/api/focus/agent',{})).id,focusId);await pause(100);assert.equal(turns.length,5,'Accepted coordination and event receipts survive restart');
 const restored=page;await restored.goto(`${ui}/?view=focus`);
 await restored.locator(`[data-agent-pane="${focusId}"]`).waitFor();assert.equal(await restored.locator('[data-composer]').inputValue(),'Keep this coordinator draft.');
 const reference=restored.locator(`[data-task-reference="${task.id}"]`).first();await reference.getByRole('button',{name:'Approve',exact:true}).waitFor();
 if(process.env.SCREENSHOT)await restored.screenshot({path:process.env.SCREENSHOT});
 await reference.getByRole('button',{name:'Approve',exact:true}).click();await until(async()=>(await api('/api/tasks')).find(item=>item.id===task.id).status==='complete');
 const revision=restored.locator(`[data-task-card="${taskIds[1]}"]`).first();
 await revision.getByRole('button',{name:'Not yet',exact:true}).click();
 await revision.getByRole('textbox',{name:'Revision for Review network rollout',exact:true}).fill('Include the remaining validation evidence.');
 await revision.getByRole('button',{name:'Send revision',exact:true}).click();
 await revision.getByRole('alert').waitFor();
 assert.equal(await revision.getByRole('textbox').inputValue(),'Include the remaining validation evidence.','Failed revision retains the draft');
 await revision.getByRole('button',{name:'Send revision',exact:true}).click();
 await until(async()=>(await api('/api/tasks')).find(item=>item.id===taskIds[1]).status==='incomplete');
 assert.ok((await api('/api/task-notes')).some(note=>note.taskId===taskIds[1]&&note.text==='Include the remaining validation evidence.'));
 assert.equal(interrupts,0,'Queued revisions preserve active work');
 assert.equal(new URL(restored.url()).searchParams.get('view'),'focus','Revision leaves the coordinator conversation open');
 const third=restored.locator(`[data-task-card="${taskIds[2]}"]`).first();await third.getByRole('button',{name:'Approve',exact:true}).click();
 await until(async()=>(await api('/api/tasks')).find(item=>item.id===taskIds[2]).status==='complete');
 assert.equal((await api('/api/tasks')).find(item=>item.id===taskIds[1]).status,'incomplete','Only the revised task reopens');
 assert.deepEqual(errors,[]);
 console.log('Focus uses a persistent chat with task references, human approvals and durable drafts; internal coordination is queued/idempotent, and restart preserves identity and accepted wake receipts.');
}finally{
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));
 daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 for(const socket of rpc.clients)socket.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>rpcHttp.close(done));await rm(root,{recursive:true,force:true});
}
