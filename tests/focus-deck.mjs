// Reviewed daemon and production UI with an isolated local Codex JSON-RPC transport.
// The fixture uses no account credentials, inference endpoint or shared services.
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
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
let serial=0,interrupts=0,focusMode=false,focusThread='',reviewId='';const workerIds=[],turns=[];
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);if(id===undefined)return;
 let result={};
 if(method==='thread/start')result={thread:{id:`focus-session-${++serial}`}};
 if(method==='thread/resume')result={thread:{id:params.threadId}};
 if(method==='turn/interrupt')interrupts++;
 if(method==='turn/start'){
  const turn={id:`turn-${++serial}`,status:'completed'};result={turn};
  if(focusMode&&!focusThread&&!params.outputSchema)focusThread=params.threadId;
  const text=params.outputSchema?JSON.stringify({actions:[],title:'Focus',tags:[]}):params.threadId===focusThread?workerIds.map((id,index)=>`[Conversation ${index+1}](#agent/${id})`).join('\n')+`\n\n[Inspect the network change](#review/${reviewId})`:'**Validation is ready.** The current result and evidence can be reviewed here.';
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
let failRevision=true;
const frontend=process.env.TEST_URL,proxy=createServer((req,res)=>{
 if(failRevision&&req.method==='POST'&&req.url.includes('/correction')){failRevision=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Revision temporarily unavailable'}));return;}
 const upstream=new URL(req.url,req.url.startsWith('/api/')&&!req.url.startsWith('/api/version')?native:frontend);
 const call=request(upstream,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
 call.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(call);res.on('close',()=>call.destroy());
});const ui=`http://127.0.0.1:${await listen(proxy)}`;
const api=async(path,body,method='POST')=>{const response=await fetch(native+path,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`${path}: ${response.status} ${await response.clone().text()}`);return response.json();};
let browser;
try{
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 for(const path of ['automatic-titles','automatic-tags','recommendation-learning','next-action-suggestions'])await api(`/api/${path}`,{enabled:false});
 const names=['Storage validation','Network rollout','Research options'];
 for(const name of names){
  const agent=await api('/api/agents',{});workerIds.push(agent.id);await api('/api/rename',{agent:agent.id,name});
  await api('/api/say',{agent:agent.id,text:'Summarize the current evidence'});
  await until(async()=>{const view=await api(`/api/agents/${agent.id}`);return view.agent.status==='complete'&&view.timeline.some(entry=>entry.kind==='said');});
 }
 const item=await api('/api/tasks',{text:'Review storage evidence'});
 await api(`/api/tasks/${item.id}`,{...item,agentId:workerIds[0],status:'done',note:'Evidence is ready for human review'},'PUT');
 const repo=join(root,'source');await mkdir(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.name','Reviewer');git('config','user.email','review@example.invalid');git('remote','add','origin','https://example.invalid/repo.git');
 await writeFile(join(repo,'service.conf'),'workers=2\n');git('add','.');git('commit','-m','Base');git('checkout','-b','proposal');
 await writeFile(join(repo,'service.conf'),'workers=4\n');git('add','.');git('commit','-m','Proposal');
 const review=await api(`/api/agents/${workerIds[1]}/reviews`,{repository:repo,base:'main',remote:'origin',title:'Review worker count',description:'Adjust concurrency for the service.'});reviewId=review.id;
 turns.length=0;focusMode=true;
 browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',error=>{errors.push(String(error));console.error(String(error));});
 await page.goto(ui);await page.getByRole('tab',{name:'Focus',exact:true}).click();
 const deck=page.locator('[data-focus-deck]').first();try{await deck.waitFor();}catch(error){console.error((await page.locator('body').innerText()).slice(0,5000));console.error('Turns',turns.length,'Focus thread',focusThread);throw error;}
 assert.equal(await page.locator('[data-focus-deck]').count(),1,'Three recommendations form one stack');
 const card=id=>deck.locator(`[data-focus-conversation="${id}"]`);
 await card(workerIds[0]).getByText('Validation is ready.',{exact:true}).waitFor();
 assert.equal(await deck.locator('[data-focus-conversation]').count(),1,'Only the selected card is interactive');
 const composer=page.locator('[data-composer]');await composer.fill('Retain the coordinator draft.');
 await card(workerIds[0]).getByRole('textbox',{name:`Reply to ${names[0]}`,exact:true}).fill('A saved inline question.');
 await card(workerIds[0]).getByRole('button',{name:'Approve',exact:true}).click();
 await until(async()=>(await api('/api/tasks')).find(task=>task.id===item.id).status==='complete');
 await deck.getByRole('button',{name:'Next card',exact:true}).click();await card(workerIds[1]).waitFor();
 await deck.getByRole('button',{name:'Next card',exact:true}).click();await card(workerIds[2]).waitFor();
 assert.equal(await card(workerIds[2]).locator('[data-task-card]').count(),0,'Conversations do not need tracked tasks');
 await card(workerIds[2]).getByRole('textbox',{name:`Reply to ${names[2]}`,exact:true}).fill('Please explain the alternatives.');
 await card(workerIds[2]).getByRole('button',{name:'Send reply',exact:true}).click();
 await until(async()=>(await api(`/api/agents/${workerIds[2]}`)).timeline.some(entry=>entry.kind==='you'&&entry.text==='Please explain the alternatives.'));
 assert.equal(new URL(page.url()).searchParams.get('view'),'focus');
 assert.equal(await composer.inputValue(),'Retain the coordinator draft.');
 await deck.getByRole('button',{name:'Next card',exact:true}).click();await card(workerIds[0]).waitFor();
 assert.equal(await card(workerIds[0]).getByRole('textbox',{name:`Reply to ${names[0]}`,exact:true}).inputValue(),'A saved inline question.');
 const embedded=page.locator(`[data-focus-review="${reviewId}"]`).first();
 await embedded.getByText('+workers=4',{exact:true}).waitFor();
 assert.equal((await api(`/api/agents/${workerIds[1]}/reviews/${reviewId}`)).status,'pending');
 await embedded.locator('[data-diff-line]').filter({hasText:'+workers=4'}).click({button:'right'});
 await page.getByRole('button',{name:'Quote diff into chat',exact:true}).click();
 await page.getByRole('region',{name:'Attached diff service.conf',exact:true}).waitFor();
 assert.equal(await composer.inputValue(),'Retain the coordinator draft.','Review quotes retain the Focus draft');
 await embedded.getByRole('button',{name:'Expand review from Network rollout',exact:true}).click();
 await embedded.getByText('+workers=4',{exact:true}).waitFor();
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await embedded.getByRole('button',{name:'Approve publication',exact:true}).click();
 await until(async()=>(await api(`/api/agents/${workerIds[1]}/reviews/${reviewId}`)).status==='approved');
 assert.equal(new URL(page.url()).searchParams.get('view'),'focus','Cross-thread review approval stays inside Focus');
 assert.equal((await api(`/api/agents/${workerIds[1]}/reviews/${reviewId}`)).agentId,workerIds[1]);
 assert.deepEqual(errors,[]);assert.equal(interrupts,0);
 console.log('Focus stacks three conversation cards, including task-free work; cycling preserves drafts, replies stay inline, and source-owned real Git reviews approve inside Focus.');
}finally{
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));
 daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 for(const socket of rpc.clients)socket.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>rpcHttp.close(done));await rm(root,{recursive:true,force:true});
}
