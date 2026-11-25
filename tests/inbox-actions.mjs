// Real disposable Inbox actions; no credentials or external services.
import assert from 'node:assert/strict';
import {DatabaseSync}from'node:sqlite';
import{createServer,request}from'node:http';
import{spawn}from'node:child_process';
import{mkdtemp,mkdir,writeFile,rm}from'node:fs/promises';
import{resolve,join}from'node:path';
import{createRequire}from'node:module';
import{chromium}from'playwright';
import{baseEnv}from'./daemon-env.mjs';
const{WebSocketServer}=createRequire(import.meta.url)('next/dist/compiled/ws');
assert.ok(process.env.TEST_DAEMON);await mkdir('.tmp',{recursive:true});const root=await mkdtemp(resolve('.tmp/inbox-actions-'));
const listen=s=>new Promise(done=>s.listen(0,'127.0.0.1',()=>done(s.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(check,label)=>{for(let n=0;n<240;n++){if(await check())return;await pause(50);}assert.fail(label);};
const transport=createServer(),rpc=new WebSocketServer({server:transport}),rpcPort=await listen(transport);
let serial=0,target='',failDraft=false,holdOwner=true;const sessions=new Map(),turns=[];
const send=(s,method,params)=>s.readyState===1&&s.send(JSON.stringify({method,params}));
const finish=(id,notify=true)=>{const saved=sessions.get(id);saved.turn.status='completed';if(notify){send(saved.socket,'item/completed',{threadId:id,item:{id:'result',type:'agentMessage',text:saved.text,phase:'final_answer'}});send(saved.socket,'turn/completed',{threadId:id,turn:saved.turn});}};
rpc.on('connection',socket=>socket.on('message',raw=>{
 const{id,method,params={}}=JSON.parse(raw);if(id===undefined)return;let result={};
 if(method==='thread/start')result={thread:{id:'session-'+(++serial)}};
 if(method==='thread/resume'){const saved=sessions.get(params.threadId);if(saved)saved.socket=socket;result={thread:{id:params.threadId,turns:saved?[saved.turn]:[]}};}
 if(method==='turn/interrupt'){const saved=sessions.get(params.threadId);saved.turn.status='interrupted';setTimeout(()=>send(socket,'turn/completed',{threadId:params.threadId,turn:saved.turn}),5);}
 if(method==='turn/start'){
  const schema=params.outputSchema?.properties,ordinary=!schema,turn={id:'turn-'+(++serial),status:'inProgress',items:[]};
  const text=schema?.draft?JSON.stringify({draft:'A concise local response grounded in the source conversation.'}):schema?.agentIds?JSON.stringify({attention:'response_needed',evidenceMessageIds:[],action:'existing',agentIds:[target],reason:'Existing conversation owns the related work'}):schema?.attention?JSON.stringify({attention:'response_needed',evidenceMessageIds:[],reason:'Current source request remains unanswered'}):schema?JSON.stringify({title:'Source review'}):'Internal source handling completed.';
  sessions.set(params.threadId,{turn,text,socket});turns.push(params);result={turn};
  if(schema?.draft&&failDraft){failDraft=false;turn.error={message:'Draft generation interrupted'};turn.status='failed';setTimeout(()=>send(socket,'turn/completed',{threadId:params.threadId,turn}),10);}
  else if(!ordinary||!holdOwner)setTimeout(()=>finish(params.threadId),10);
 }
 socket.send(JSON.stringify({id,result}));
}));
const reserve=createServer(),port=await listen(reserve);await new Promise(done=>reserve.close(done));const base='http://127.0.0.1:'+port;
const legacy=new DatabaseSync(join(root,'legacy.sqlite3'));legacy.exec('CREATE TABLE threads(slack_user TEXT,channel TEXT,root_ts TEXT,codex_thread_id TEXT);CREATE TABLE pending_context(thread_id TEXT,message_ts TEXT,question TEXT,answer TEXT);CREATE TABLE dashboard(singleton INTEGER,channel TEXT,message_ts TEXT)');legacy.close();
const config=join(root,'config.toml');
await writeFile(config,'owner="fixture"\nlisten="127.0.0.1:'+port+'"\nworkspace='+JSON.stringify(root)+'\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase='+JSON.stringify(join(root,'state.sqlite3'))+'\nartifacts='+JSON.stringify(join(root,'artifacts'))+'\nattachments='+JSON.stringify(join(root,'attachments'))+'\n');
const env={...baseEnv,OXROUTE_CONFIG:config,CODEX_SLACK_DATABASE:join(root,'legacy.sqlite3'),CODEX_HOME:join(root,'codex'),OXROUTE_CODEX_URL:'ws://127.0.0.1:'+rpcPort,OXROUTE_CODEX_CLI:'/bin/false',RUST_LOG:'warn'};
const start=()=>spawn(process.env.TEST_DAEMON,[],{env,stdio:['ignore','ignore','inherit']});let daemon=start();
const stop=async()=>{daemon.kill('SIGKILL');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));};
const read=async path=>{const r=await fetch(base+path);assert.ok(r.ok,path+': '+r.status);return r.json();};
const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,path+': '+r.status+' '+await r.clone().text());return r.json();};
const healthy=()=>until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}},'Disposable daemon readiness');
const proxy=createServer((req,res)=>{const upstream=request(new URL(req.url,req.url.startsWith('/api/')&&!req.url.startsWith('/api/version')?base:process.env.TEST_URL),{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);res.on('close',()=>upstream.destroy());});
const web='http://127.0.0.1:'+await listen(proxy);let browser,db;
const body=(item,action,extra={})=>({requestId:crypto.randomUUID(),revision:item.revision,contextRevision:item.contextRevision,action,...extra});
try{
 await healthy();for(const name of ['automatic-titles','automatic-tags','next-action-suggestions','recommendation-learning'])await post('/api/'+name,{enabled:false});
 const owner=await post('/api/agents',{});target=owner.id;await post('/api/rename',{agent:owner.id,name:'Source investigation'});await post('/api/say',{agent:owner.id,text:'Inspect current local evidence'});
 await until(()=>turns.some(t=>!t.outputSchema),'Owner did not start');const ownerThread=turns.find(t=>!t.outputSchema).threadId;
 const incoming=await post('/api/signal',{source:'outlook-inbox',conversation:'mail-account',threadKey:'first-source',label:'Current source',text:'Review observations and retain '+'https://example.test/'.repeat(18)});
 const unrelated=await post('/api/signal',{source:'outlook-inbox',conversation:'mail-account',threadKey:'independent-source',label:'Independent source',text:'A separate request retains its source context.'});
 await until(async()=>(await read('/api/state')).inbox.every(i=>i.recommendation),'Response assessment did not finish');
 db=new DatabaseSync(join(root,'state.sqlite3'));db.exec('PRAGMA busy_timeout=5000');
 db.prepare("INSERT INTO tasks(id,text,status,created_at,updated_at) VALUES('retained','Independent work','waiting_for_human',1,1)").run();
 db.prepare("INSERT INTO kv(key,value) VALUES('review:independent','{\"status\":\"pending\"}')").run();
 const originalTasks=await read('/api/tasks'),agentCount=(await read('/api/state')).agents.length;
 const originalMessages=db.prepare('SELECT * FROM inbox_messages ORDER BY external_id').all();
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(web);
 const row=page.locator('[data-inbox-item]').filter({has:page.getByText('Current source',{exact:true})});
 await row.waitFor();await row.hover();
 assert.equal(await row.locator('button button').count(),0,'Row actions never nest interactive buttons');
 await row.getByRole('button',{name:'Generate inline response',exact:true}).click();
 await until(async()=>await row.getByRole('textbox',{name:'Local Inbox response'}).inputValue()==='A concise local response grounded in the source conversation.','Generated draft did not stay inline');
 assert.equal((await read('/api/state')).agents.length,agentCount,'Draft generation cannot create a conversation');
 assert.equal((await read('/api/state')).inbox.find(i=>i.signal.id===incoming.signal).state,'waiting','Drafting never routes or resolves source');
 await row.getByRole('textbox',{name:'Local Inbox response'}).fill('Retained edited local response');await page.getByRole('button',{name:'Show or hide the inbox',exact:true}).focus();
 await until(async()=>(await read('/api/intake/'+incoming.signal)).review.draft==='Retained edited local response','Edited draft did not persist');
 failDraft=true;await row.getByRole('button',{name:'Regenerate inline response',exact:true}).click();await row.getByRole('alert').waitFor();
 assert.equal(await row.getByRole('textbox',{name:'Local Inbox response'}).inputValue(),'Retained edited local response','A failed regeneration retains the local draft');
 const cdp=await page.context().newCDPSession(page);if(process.env.INBOX_SCREENSHOTS)await mkdir(process.env.INBOX_SCREENSHOTS,{recursive:true});
 for(const width of [1280,390])for(const zoom of [.8,1,1.25]){
  const viewport={width:Math.round(width/zoom),height:Math.round(900/zoom)};await page.setViewportSize(viewport);await cdp.send('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:zoom,mobile:false});await row.scrollIntoViewIfNeeded();await row.getByRole('button',{name:'Mark resolved',exact:true}).focus();
  const bounds=await row.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=viewport.width+.1,'Row fits narrow/zoom viewport');
  assert.ok(await row.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Row text, icons and draft never overflow horizontally');
  for(const button of await row.locator('button').all()){const box=await button.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=viewport.width+.1,'Every row action remains reachable');}
  if(process.env.INBOX_SCREENSHOTS)await page.screenshot({path:join(process.env.INBOX_SCREENSHOTS,'actions-'+width+'-'+zoom+'.png'),clip:{x:0,y:0,...viewport},captureBeyondViewport:false});
 }
 await page.setViewportSize({width:1280,height:900});await cdp.send('Emulation.clearDeviceMetricsOverride');
 await row.getByRole('button',{name:'Mark resolved',exact:true}).click();
 await until(async()=>(await read('/api/intake/'+incoming.signal)).review.state==='resolved','Resolve not persisted');
 assert.equal((await read('/api/intake/'+incoming.signal)).state,'waiting');
 await page.getByRole('button',{name:/Handled ·/}).click();await row.getByRole('button',{name:'Review again',exact:true}).click();
 await until(async()=>['unreviewed','response_needed'].includes((await read('/api/intake/'+incoming.signal)).review.state),'Resolve is recoverable');
 await until(async()=>(await read('/api/state')).inbox.find(i=>i.signal.id===incoming.signal).recommendation,'Prediction missing after review');
 const item=(await read('/api/state')).inbox.find(i=>i.signal.id===incoming.signal);
 const stale=body(item,'route',{target:owner.id,recommendationId:item.recommendation.recommendationId+1});
 assert.equal((await fetch(base+'/api/intake/'+incoming.signal+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(stale)})).ok,false,'Stale target prediction cannot route');
 let accepted;await page.route('**/api/intake/'+incoming.signal+'/action',async route=>{const action=route.request().postDataJSON();if(action.action==='route')accepted=action;await route.continue();});
 const location=page.url();await row.getByRole('button',{name:'Route to Source investigation',exact:true}).click();await until(()=>Boolean(accepted),'Direct route click did not submit');await until(async()=>(await read('/api/intake/'+incoming.signal)).state==='done','Direct route did not complete');assert.equal(page.url(),location,'Internal route keeps the current place');assert.equal(accepted.target,owner.id);
 await post('/api/intake/'+incoming.signal+'/action',accepted);
 assert.equal(db.prepare("SELECT count(*) n FROM kv WHERE key LIKE 'inbox-route:%'").get().n,1,'Busy owner retains one durable internal handoff');
 assert.equal((await read('/api/state')).agents.length,agentCount);assert.deepEqual(await read('/api/tasks'),originalTasks);
 assert.equal(db.prepare("SELECT value FROM kv WHERE key='review:independent'").get().value,'{"status":"pending"}');
 finish(ownerThread,false);await stop();daemon=start();await healthy();holdOwner=false;
 await until(()=>turns.filter(t=>!t.outputSchema).length===2,'Queued internal route did not recover after restart');
 const routed=turns.filter(t=>!t.outputSchema).at(-1),savedTarget=JSON.parse(db.prepare('SELECT target FROM active_turns WHERE agent_id=?').get(owner.id).target);
 assert.equal(savedTarget.source,'you','Internal routing never falls back to destination external home');assert.ok(JSON.stringify(routed.input).includes('Review observations and retain'));
 await post('/api/intake/'+incoming.signal+'/action',accepted);assert.equal(turns.filter(t=>!t.outputSchema).length,2,'Accepted route retry cannot deliver twice');
 finish(routed.threadId);assert.equal((await read('/api/intake/'+unrelated.signal)).state,'waiting');
 assert.deepEqual(db.prepare('SELECT * FROM inbox_messages ORDER BY external_id').all(),originalMessages);assert.deepEqual(await read('/api/tasks'),originalTasks);assert.deepEqual(errors,[]);
 // Confirmed thread destinations are looked up without invoking the model router.
 await until(async()=>(await read('/api/agents/'+owner.id)).agent.status==='complete','Owner did not settle');
 db.prepare("INSERT INTO kv(key,value) VALUES('source-account:slack',?)").run(JSON.stringify({account:'workspace',owner:'reader',actor:'source-bot'}));
 db.prepare("INSERT INTO kv(key,value) VALUES('inbox-dm:workspace:direct','true')").run();
 db.prepare("INSERT INTO bindings(source,conversation,thread_key,agent_id) VALUES('slack','direct','100.1',?)").run(owner.id);
 const routerCount=()=>turns.filter(t=>t.outputSchema?.properties?.agentIds).length;
 const routedBefore=routerCount(),incomingThread=text=>post('/api/signal',{source:'slack-inbox',conversation:'workspace:reader:direct',threadKey:'100.1',label:'Thread source',text});
 const first=await incomingThread('First source reply'),second=await incomingThread('Later source reply');
 for(const message of [first,second]){assert.equal(await post('/api/routing-recommendations/'+message.signal,{}),null);assert.equal((await read('/api/intake/'+message.signal)).destination.agentId,owner.id);}
 assert.equal(routerCount(),routedBefore,'Original binding resolves the first and subsequent replies without a router invocation');
 let grouped=(await read('/api/state')).inbox.find(i=>i.group?.members.some(m=>m.id===second.signal));
 assert.equal(grouped.group.members.length,2);const groupKey=grouped.group.key;
 const threadRow=page.locator('[data-inbox-thread='+JSON.stringify(groupKey)+']');await threadRow.waitFor();
 await threadRow.getByRole('button',{name:'Show thread history',exact:true}).click();await threadRow.getByLabel('Thread history',{exact:true}).getByText('First source reply',{exact:true}).waitFor();
 await threadRow.getByRole('button',{name:'Open Inbox item',exact:true}).click();
 const context=page.getByLabel('Conversation context',{exact:true});await until(async()=>(await context.textContent()).includes('Later source reply'),'Thread context did not load');
 await context.evaluate(node=>{window.threadFlashes=0;window.threadObserver=new MutationObserver(()=>{if(node.textContent.includes('Loading conversation'))window.threadFlashes++;});window.threadObserver.observe(node,{subtree:true,childList:true,characterData:true});});
 for(const width of [1280,390])for(const zoom of [.8,1,1.25]){
  const viewport={width:Math.round(width/zoom),height:Math.round(900/zoom)};await page.setViewportSize(viewport);await cdp.send('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:zoom,mobile:false});
  if(!await threadRow.isVisible())await page.getByRole('button',{name:'Show or hide the inbox',exact:true}).click();
  await threadRow.scrollIntoViewIfNeeded();assert.ok(await threadRow.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Expanded thread stays within the viewport');
  if(process.env.INBOX_SCREENSHOTS)await page.screenshot({path:join(process.env.INBOX_SCREENSHOTS,'thread-'+width+'-'+zoom+'.png'),clip:{x:0,y:0,...viewport},captureBeyondViewport:false});
 }
 await page.setViewportSize({width:1280,height:900});await cdp.send('Emulation.clearDeviceMetricsOverride');
 const oldResolve=body(grouped,'resolve',{members:grouped.group.members.map(({id,revision})=>({id,revision}))});
 const third=await incomingThread('New arrival after the member snapshot');await post('/api/routing-recommendations/'+third.signal,{});
 await post('/api/intake/'+grouped.signal.id+'/action',oldResolve);
 assert.equal((await read('/api/intake/'+first.signal)).review.state,'resolved');assert.equal((await read('/api/intake/'+third.signal)).review.state,'response_needed','Later arrival survives group resolve');
 await until(async()=>(await context.textContent()).includes('New arrival after the member snapshot'),'Selected context did not refresh after its anchor changed');
 assert.equal(await page.evaluate(()=>window.threadFlashes),0,'New same-thread arrivals keep the loaded pane visible');
 assert.equal(await threadRow.getByRole('button',{name:'Show thread history'}).getAttribute('aria-expanded'),'true','Expandable history retains its place');
 assert.equal(routerCount(),routedBefore);
 const alternate=await post('/api/agents',{});await post('/api/rename',{agent:alternate.id,name:'Alternate owner'});holdOwner=true;
 grouped=(await read('/api/state')).inbox.find(i=>i.group?.key===groupKey);
 await post('/api/intake/'+grouped.signal.id+'/action',body(grouped,'route_manual',{target:alternate.id,targets:[alternate.id,owner.id],members:grouped.group.members.map(({id,revision})=>({id,revision}))}));
 await until(async()=>(await read('/api/agents/'+alternate.id)).agent.status==='working','Manual reroute did not reach the selected owner');
 await until(async()=>turns.filter(t=>!t.outputSchema&&t.threadId===ownerThread).length===3,'Manual fanout did not preserve the original owner');
 const fourth=await incomingThread('Same root after manual reroute');await post('/api/routing-recommendations/'+fourth.signal,{});
 assert.equal((await read('/api/intake/'+fourth.signal)).destination.agentId,alternate.id,'Accepted manual reroute overrides original ownership');
 await post('/api/interrupt',{agent:alternate.id});
 await until(async()=>(await read('/api/intake/'+fourth.signal)).destination.blocked,'Stopped destination boundary not retained');
 const ordinaryBefore=turns.filter(t=>!t.outputSchema).length;const fifth=await incomingThread('Arrival while its owner is stopped');await post('/api/routing-recommendations/'+fifth.signal,{});
 assert.equal((await read('/api/intake/'+fifth.signal)).destination.agentId,alternate.id);assert.equal(turns.filter(t=>!t.outputSchema).length,ordinaryBefore,'Inheritance never resumes a stopped owner');
 await stop();daemon=start();await healthy();
 assert.equal((await read('/api/intake/'+fifth.signal)).destination.agentId,alternate.id);assert.equal(routerCount(),routedBefore,'Restart retains destinations with no model router calls');
 const beforeRoot=await read('/api/intake/'+fifth.signal);
 db.prepare("INSERT INTO inbox_messages VALUES('slack-inbox','workspace:reader:direct','100.1','100.1','reader','Original root collected later',100.1)").run();
 const historyResult=await read('/api/intake/'+fifth.signal+'/thread');assert.equal(historyResult.messages[0].id,'100.1');assert.equal((await read('/api/intake/'+fifth.signal)).destination.agentId,beforeRoot.destination.agentId);
 const isolated=await post('/api/signal',{source:'slack-inbox',conversation:'workspace:reader:direct',threadKey:'200.1',text:'Independent provider root'});
 assert.equal((await read('/api/intake/'+isolated.signal)).destination,undefined,'Unrelated roots cannot inherit a channel destination');
 assert.equal((await read('/api/state')).inbox.filter(i=>i.signal.source==='slack-inbox').length,2,'One row per provider root');
 assert.deepEqual(await read('/api/tasks'),originalTasks);assert.equal(db.prepare("SELECT value FROM kv WHERE key='review:independent'").get().value,'{"status":"pending"}');
 console.log('Original/accepted provider-root destination inheritance, zero model router calls, grouped history, anchor/scroll retention, later-arrival resolve boundary, manual reroute, stopped-owner and restart isolation pass.');
 console.log('Real daemon inline local generation/edit/error retention, no conversation creation, resolve/recovery, stale prediction rejection, durable deduped internal route/restart, task/review/history preservation and desktop/narrow80/100/125% controls pass.');
}finally{db?.close();await browser?.close();await stop();for(const client of rpc.clients)client.terminate();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));await new Promise(done=>rpc.close(done));await new Promise(done=>transport.close(done));await rm(root,{recursive:true,force:true});}
