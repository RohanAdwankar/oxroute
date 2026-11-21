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
let workerReply='**Validation is ready.** The current result and evidence can be reviewed here.';
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
  const text=params.outputSchema?JSON.stringify({actions:[],title:'Focus',tags:[]}):params.threadId===focusThread?`Start with **[Conversation 1](#agent/${workerIds[0]})**, then compare the alternatives.\n\n[Conversation 2](#agent/${workerIds[1]})\n\n- [Conversation 3](#agent/${workerIds[2]})\n\nThe comparison is ready; choose the next action after reading the evidence.\n\n[Inspect the network change](#review/${reviewId})`:workerReply;
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
 const taskIds=[item.id];
 for(let index=0;index<7;index++){
  const task=await api('/api/tasks',{text:`Review prepared evidence ${index+1}`});taskIds.push(task.id);
  await api(`/api/tasks/${task.id}`,{...task,agentId:workerIds[0],status:index%2&&index<5?'waiting_for_human':'done',note:'Existing decision requiring human attention'},'PUT');
 }
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
 const entry=deck.locator('xpath=ancestor::*[@data-entry][1]');
 const introduction=entry.locator('p').filter({hasText:'Start with Conversation 1, then compare the alternatives.'});
 await introduction.waitFor();
 const closing=entry.getByText('The comparison is ready; choose the next action after reading the evidence.',{exact:true});
 await closing.waitFor();
 assert.equal(await entry.locator('li').filter({hasText:'Conversation 3'}).count(),1,'List references retain their readable labels');
 assert.ok(await closing.evaluate(node=>!!(node.compareDocumentPosition(node.closest('[data-entry]').querySelector('[data-focus-deck]'))&Node.DOCUMENT_POSITION_FOLLOWING)),'Conversation cards follow all reply prose');
 assert.equal(await introduction.locator('[data-focus-deck]').count(),0,'A reference inside emphasis cannot split its sentence');

 const card=id=>deck.locator(`[data-focus-conversation="${id}"]`);
 await card(workerIds[0]).getByText('Validation is ready.',{exact:true}).waitFor();
 assert.equal(await deck.locator('[data-focus-conversation]').count(),1,'Only the selected card is interactive');
 const original=(await api(`/api/agents/${workerIds[0]}`)).timeline.findLast(entry=>entry.kind==='said');
 workerReply='A separate later result supersedes the current conversation preview.';
 await api('/api/say',{agent:workerIds[0],text:'Investigate a separate authorized follow-up'});
 await until(async()=>(await api(`/api/agents/${workerIds[0]}`)).timeline.some(entry=>entry.kind==='said'&&entry.text===workerReply));
 await page.reload();await deck.waitFor();
 await card(workerIds[0]).getByText('Validation is ready.',{exact:true}).waitFor({timeout:5000});
 assert.equal(await card(workerIds[0]).getByText(workerReply,{exact:true}).count(),0,'Historical publications cannot drift to later source results');
 assert.ok(original.id<Number(await entry.getAttribute('data-entry')));
 assert.equal(await card(workerIds[0]).getByRole('link',{name:names[0],exact:true}).getAttribute('href'),`#agent/${workerIds[0]}`,'Historical results retain source navigation');
 if(process.env.HISTORY_SCREENSHOT){for(const width of[1280,390]){await page.setViewportSize({width,height:850});await card(workerIds[0]).screenshot({path:`${process.env.HISTORY_SCREENSHOT}-${width}.png`});}await page.setViewportSize({width:1280,height:1000});}

 const reply=card(workerIds[0]).getByRole('textbox',{name:`Reply to ${names[0]}`,exact:true});
 assert.ok((await reply.boundingBox()).height<40,'The empty inline reply uses one compact line');
 if(process.env.PLACEMENT_SCREENSHOT){
  const review=page.locator(`[data-focus-review="${reviewId}"]`).first();
  await review.getByRole('button',{name:`Collapse review from ${names[1]}`,exact:true}).click();
  await introduction.scrollIntoViewIfNeeded();
  await entry.screenshot({path:process.env.PLACEMENT_SCREENSHOT});
  await review.getByRole('button',{name:`Expand review from ${names[1]}`,exact:true}).click();
 }

 const composer=page.locator('[data-composer]');await composer.fill('Retain the coordinator draft.');
 await card(workerIds[0]).getByRole('textbox',{name:`Reply to ${names[0]}`,exact:true}).fill('A saved inline question.');
 const taskList=card(workerIds[0]).getByRole('region',{name:`Tasks for ${names[0]}`,exact:true});
 await taskList.locator('[data-task-card]').first().waitFor();
 assert.equal(await taskList.locator('[data-task-card]').count(),3,'Focus shows a bounded group of tasks');
 await taskList.locator(`[data-task-card="${item.id}"]`).getByRole('button',{name:'Not yet',exact:true}).click();
 await taskList.getByRole('textbox',{name:'Revision for Review storage evidence',exact:true}).fill('Keep this unsent revision while paging.');
 const beforePaging=await api('/api/tasks'),seen=new Set();
 for(let pageIndex=0;pageIndex<3;pageIndex++){
  const ids=await taskList.locator('[data-task-card]').evaluateAll(nodes=>nodes.map(node=>node.dataset.taskCard));
  assert.ok(ids.length<=3);ids.forEach(id=>seen.add(id));
  if(pageIndex<2)await taskList.getByRole('button',{name:'Next tasks',exact:true}).press(pageIndex?'Space':'Enter');
 }
 assert.deepEqual([...seen].sort(),taskIds.slice().sort(),'Every attached task remains reachable');
 await taskList.getByRole('button',{name:'Next tasks',exact:true}).waitFor({state:'visible'});
 assert.equal(await taskList.getByRole('button',{name:'Next tasks',exact:true}).isDisabled(),true);
 assert.deepEqual(await api('/api/tasks'),beforePaging,'Paging never mutates tasks or approval state');
 assert.equal(await card(workerIds[0]).getByRole('textbox',{name:`Reply to ${names[0]}`,exact:true}).inputValue(),'A saved inline question.');
 if(process.env.TASK_SCREENSHOT)await page.screenshot({path:process.env.TASK_SCREENSHOT});
 // Approving the last page remains inline, and shrinking the page preserves the limit.
 const last=taskList.locator(`[data-task-card="${taskIds.at(-1)}"]`);
 await last.getByRole('button',{name:'Approve',exact:true}).click();
 await until(async()=>(await api('/api/tasks')).find(task=>task.id===taskIds.at(-1)).status==='complete');
 await last.waitFor({state:'detached'});
 await taskList.locator(`[data-task-card="${taskIds.at(-2)}"]`).getByRole('button',{name:'Approve',exact:true}).click();
 await taskList.getByText('Tasks 4–6 / 6',{exact:true}).waitFor();
 assert.equal(await taskList.locator('[data-task-card]').count(),3,'An emptied final page returns to available tasks');
 await taskList.getByRole('button',{name:'Previous tasks',exact:true}).click();
 assert.equal(await taskList.getByRole('textbox',{name:'Revision for Review storage evidence',exact:true}).inputValue(),'Keep this unsent revision while paging.');
 assert.equal(await taskList.getByRole('button',{name:'Previous tasks',exact:true}).isDisabled(),true);
 await taskList.locator(`[data-task-card="${item.id}"]`).getByRole('button',{name:'Approve',exact:true}).click();
 await until(async()=>(await api('/api/tasks')).find(task=>task.id===item.id).status==='complete');
 await deck.getByRole('button',{name:'Next card',exact:true}).click();await card(workerIds[1]).waitFor();
 await deck.getByRole('button',{name:'Next card',exact:true}).click();await card(workerIds[2]).waitFor();
 assert.equal(await card(workerIds[2]).locator('[data-task-card]').count(),0,'Conversations do not need tracked tasks');
 const replySource=(await api(`/api/agents/${workerIds[2]}`)).timeline.findLast(entry=>entry.kind==='said');
 await card(workerIds[2]).getByRole('textbox',{name:`Reply to ${names[2]}`,exact:true}).fill('Please explain the alternatives.');
 await card(workerIds[2]).getByRole('button',{name:'Send reply',exact:true}).click();
 await until(async()=>(await api(`/api/agents/${workerIds[2]}`)).timeline.some(entry=>entry.kind==='you'&&entry.text.endsWith('Please explain the alternatives.')&&entry.text.includes(`${workerIds[2]}/${replySource.id}`)));
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
 console.log('Focus limits attached tasks to three per page, preserves access and approval state while paging, and stacks three conversation cards, including task-free work; cycling preserves drafts, replies stay inline, and source-owned real Git reviews approve inside Focus.');
}finally{
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));
 daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 for(const socket of rpc.clients)socket.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>rpcHttp.close(done));await rm(root,{recursive:true,force:true});
}
