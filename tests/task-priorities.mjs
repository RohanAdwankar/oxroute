// Disposable real daemon, persisted source evidence, and production sidebar.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chromium, webkit } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { resolve, join } from 'node:path';
assert.ok(process.env.TEST_URL && process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'), {recursive:true});
const root=await mkdtemp(resolve('.tmp/task-priorities-'));
const listen=s=>new Promise(done=>s.listen(0,'127.0.0.1',()=>done(s.address().port)));
const reserve=createServer(), port=await listen(reserve); await new Promise(done=>reserve.close(done));
const native=`http://127.0.0.1:${port}`, dbPath=join(root,'state.sqlite3'), config=join(root,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(dbPath)}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const start=()=>spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',CODEX_HOME:join(root,'codex'),OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:'ws://127.0.0.1:9',OXROUTE_CODEX_CLI:'/bin/false'}});
let daemon=start();
const stop=async()=>{daemon.kill('SIGKILL');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));};
const healthy=async()=>{for(let i=0;i<100;i++){try{if((await fetch(native+'/api/health')).ok)return;}catch{}await new Promise(done=>setTimeout(done,100));}assert.fail('Daemon did not start');};
const api=async(path,body,method='POST')=>{const r=await fetch(native+path,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${await r.clone().text()}`);return r.json();};
const proxy=createServer((req,res)=>{const target=new URL(req.url,req.url.startsWith('/api/')&&!req.url.startsWith('/api/version')?native:process.env.TEST_URL);const up=request(target,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});up.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(up);res.on('close',()=>up.destroy());});
const base=`http://127.0.0.1:${await listen(proxy)}`;
let browser,db;
try {
 await healthy();await api('/api/focus/task-priorities');
 for(const name of ['automatic-titles','automatic-tags','recommendation-learning','next-action-suggestions'])await api(`/api/${name}`,{enabled:false});
 const focus=await api('/api/agents',{}),owner=await api('/api/agents',{});
 await api('/api/rename',{agent:owner.id,name:'Release validation'});
 db=new DatabaseSync(dbPath);db.prepare('INSERT INTO kv VALUES(?,?)').run('focus.agent',focus.id);
 db.prepare('INSERT INTO kv VALUES(?,?)').run(`agent-tool-token:${focus.id}`,'fixture-token');
 const entry=(kind,text,agent=owner.id)=>Number(db.prepare('INSERT INTO entries(agent_id,at,kind,text) VALUES(?,?,?,?)').run(agent,Date.now()/1000,kind,text).lastInsertRowid);
 const evidence=entry('you','Prioritize important delivery and concrete unblockers.');
 const task=async(text,status='waiting_for_human',blocker='')=>{const t=await api('/api/tasks',{text});return api(`/api/tasks/${t.id}`,{...t,agentId:owner.id,status,blockedByTaskId:blocker,note:'Source-grounded next action retained.'},'PUT');};
 const trivial=await task('Refine chart labels'), published=await task('Inspect published output','done');
 const urgent=await task('Review release readiness'), unblocker=await task('Choose validation environment');
 const other=await task('Await upstream package','blocked',urgent.id);
 const closed=await task('Archive finished outcome');
 await api(`/api/tasks/${closed.id}`,{...closed,status:'complete',note:'Fixture human approval.',approved:true},'PUT');
 const state=await api('/api/focus/task-priorities');
 const priority=(t,nextAction,reason,urgency,impact,effort,nextActor='human')=>({taskId:t.id,basis:state.priorities[t.id].basis,nextAction,reason,urgency,impact,effort,nextActor,evidenceEntryIds:[evidence]});
 const order={requestId:crypto.randomUUID(),focusContextEntryId:state.review.focusContextEntryId,items:[
  {...priority(urgent,'Inspect release evidence','Delivery deadline today','urgent','substantial','substantial'),deadlineAt:Date.now()/1000+3600},
  priority(unblocker,'Choose the available environment','Unblocks recording and validation','normal','substantial','small'),
  priority(trivial,'Inspect chart wording','Presentation cleanup can wait','normal','routine','small'),
  priority(other,'Wait for upstream delivery','External dependency remains','normal','substantial','substantial','other')
 ]};
 const response=await fetch(native+'/api/focus/task-priorities',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:owner.id,...order})});assert.equal(response.ok,false,'Workers cannot reprioritize shared work');
 const receipt=await api('/api/focus/task-priorities',{agentId:focus.id,...order},'PUT');
 assert.equal((await api('/api/focus/task-priorities')).review.changed,false,'Applied review revision is durable');
 const current=await api('/api/tasks');assert.deepEqual(current.slice(0,4).map(t=>t.id),order.items.map(t=>t.taskId),'Contextual order beats insertion/status/recency: urgent substantial, small high-impact, trivial, waiting others');
 assert.equal(current.find(t=>t.id===published.id).status,'done');assert.equal(current.find(t=>t.id===closed.id).status,'complete');
 const mcp=async(name,args)=>{const r=await fetch(native+`/api/agent-tools/${focus.id}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-token'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});assert.ok(r.ok);return(await r.json()).result;};
 assert.deepEqual((await mcp('prioritize_tasks',order)).structuredContent,receipt,'Native and HTTP paths share durable receipts');
 browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const errors=[];
 const open=async()=>{const page=await browser.newPage({viewport:{width:1280,height:850}});page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{localStorage.setItem('oxroute.tasks','true');localStorage.setItem('oxroute.taskWidth','320');sessionStorage.setItem('oxroute.windowTasks','false');});
  await page.goto(`${base}/?agent=${owner.id}`);return page;};
 let page=await open(),panel=page.locator('[data-task-panel]'),rows=panel.locator('[data-task-row]');
 await panel.getByText('You: Inspect release evidence',{exact:false}).waitFor();
 assert.equal(await rows.first().locator('[data-task-open]').innerText(),urgent.text);
 assert.equal(await panel.getByText(closed.text,{exact:true}).count(),0);
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:850});
  for(const item of [urgent,unblocker]){
   const row=rows.filter({has:page.locator('[data-task-open]',{hasText:item.text})}),box=await row.locator('[data-task-next-action]').boundingBox();
   assert.ok(box.x>=0&&box.x+box.width<=width,'Next action and reason stay inside the viewport');
   await row.getByRole('combobox',{name:`status for ${item.text}`,exact:true}).focus();assert.equal(await row.getByRole('combobox',{name:`status for ${item.text}`,exact:true}).evaluate(e=>e===document.activeElement),true);
  }
  if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT.replace('.png',`-${width}.png`)});
 }
 await page.setViewportSize({width:1280,height:850});
 await panel.getByRole('searchbox').fill('environment');assert.equal(await panel.locator('[data-task-open]').count(),1);await panel.getByRole('searchbox').fill('');
 await panel.getByRole('button',{name:'Only open conversations',exact:true}).click();assert.ok(await panel.locator('[data-task-open]').count()>0);await panel.getByRole('button',{name:'Only open conversations',exact:true}).click();
 await api(`/api/tasks/${trivial.id}/move`,{after:null});
 assert.equal((await api('/api/tasks'))[0].id,trivial.id,'Existing manual movement remains effective');
 assert.deepEqual(await api('/api/focus/task-priorities',{agentId:focus.id,...order},'PUT'),receipt);assert.equal((await api('/api/tasks'))[0].id,trivial.id,'Retries do not overwrite newer manual order');
 await page.close();await stop();daemon=start();await healthy();
 assert.equal((await api('/api/tasks'))[0].id,trivial.id);assert.equal((await api('/api/state')).taskPriorities[urgent.id].recommendation.nextAction,'Inspect release evidence');
 page=await open();panel=page.locator('[data-task-panel]');rows=panel.locator('[data-task-row]');await panel.getByText('You: Inspect release evidence',{exact:false}).waitFor();assert.equal(await rows.first().locator('[data-task-open]').innerText(),trivial.text);
 entry('you','Inspect an unrelated contextual metric.',focus.id);
 const unrelated=await api('/api/focus/task-priorities');
 assert.equal(unrelated.review.changed,true);assert.equal(unrelated.priorities[unblocker.id].stale,false,'Unrelated Focus input does not erase outcome-linked next action');
 assert.equal((await api('/api/tasks'))[0].id,trivial.id,'Unrelated input preserves manual order and valid priorities');
 assert.equal((await mcp('prioritize_tasks',{...order,requestId:crypto.randomUUID()})).isError,true,'New order requires reconciliation with fresh Focus human context');
 entry('you','The environment choice is complete. Revalidate the selected service.');
 const sourceAdvanced=await api('/api/focus/task-priorities');
 assert.equal(sourceAdvanced.priorities[unblocker.id].needsReview,true);assert.equal(sourceAdvanced.priorities[unblocker.id].stale,false,'Advanced conversation context requests reconciliation without silently canceling an outcome');
 await api(`/api/tasks/${unblocker.id}/notes`,{text:'The human prerequisite is complete; agent verification is next.',agentId:owner.id});
 const stale=await api('/api/focus/task-priorities');assert.equal(stale.review.changed,true,'Changed evidence requests fresh Focus judgment');assert.equal(stale.priorities[unblocker.id].stale,true,'New actual human/source evidence withdraws old action');assert.equal(stale.priorities[unblocker.id].recommendation,null);
 const rejected=await mcp('prioritize_tasks',{...order,requestId:crypto.randomUUID()});assert.equal(rejected.isError,true,'Stale evidence cannot restore an obsolete human obligation');
 const fresh={requestId:crypto.randomUUID(),focusContextEntryId:stale.review.focusContextEntryId,items:[{...order.items[1],basis:stale.priorities[unblocker.id].basis,nextActor:'agent',nextAction:'Revalidate the selected service',reason:'Human prerequisite completed',evidenceEntryIds:[entry('said','The selected environment is available for verification.')]}]};
 // The fresh result advances the source head, so read its new basis before applying.
 fresh.items[0].basis=(await api('/api/focus/task-priorities')).priorities[unblocker.id].basis;
 assert.equal((await mcp('prioritize_tasks',fresh)).isError,false);
 await page.reload();await panel.getByText('Next: Revalidate the selected service',{exact:false}).waitFor();assert.equal(await panel.getByText('You: Choose the available environment',{exact:false}).count(),0);
 const preserved=(await api('/api/tasks')).find(t=>t.id===unblocker.id);assert.equal(preserved.agentId,owner.id);assert.equal(preserved.status,'waiting_for_human','Priority judgment does not silently change status or consent');
 const parent=await task('Complete release preparation');
 const nested=await api(`/api/tasks/${urgent.id}`,{...urgent,parentTaskId:parent.id,note:'Retain the existing work hierarchy.'},'PUT');
 const nestedState=await api('/api/focus/task-priorities');
 await api('/api/focus/task-priorities',{agentId:focus.id,requestId:crypto.randomUUID(),focusContextEntryId:nestedState.review.focusContextEntryId,items:[{...order.items[0],basis:nestedState.priorities[nested.id].basis,evidenceEntryIds:fresh.items[0].evidenceEntryIds}]},'PUT');
 await page.reload();await panel.getByText('You: Inspect release evidence',{exact:false}).waitFor();
 assert.equal(await rows.nth(0).locator('[data-task-open]').innerText(),parent.text,'Prioritized child brings its intact branch forward');
 assert.equal(await rows.nth(1).locator('[data-task-open]').innerText(),urgent.text);
 assert.deepEqual(errors,[]);
 console.log('Real daemon: contextual order, native/API authorization and receipts, manual moves, reload/restart, fresh evidence, unchanged ownership/status, search/scope, keyboard and 1280/390 sidebar passed.');
} finally {if(browser)await browser.close();if(db)db.close();await stop();await new Promise(done=>proxy.close(done));await rm(root,{recursive:true,force:true});}
