// Disposable real daemon, persisted source evidence, and production sidebar.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chromium, webkit } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn,execFileSync } from 'node:child_process';
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
 const urgent=await task('Review release readiness'), unblocker=await task('Choose validation environment','incomplete');
 const other=await task('Await upstream package','blocked',urgent.id);
 const closed=await task('Archive finished outcome');
 await api(`/api/tasks/${closed.id}`,{...closed,status:'complete',note:'Fixture human approval.',approved:true},'PUT');
 const state=await api('/api/focus/task-priorities');
 const priority=(t,nextAction,reason,urgency,impact,effort,nextActor='human')=>({taskId:t.id,basis:state.priorities[t.id].basis,nextAction,reason,urgency,impact,effort,nextActor,...(nextActor==='human'?{humanReason:'The user owns this choice.',unblocks:'The selected delivery path.'}:{}),evidenceEntryIds:[evidence]});
 const order={requestId:crypto.randomUUID(),focusContextEntryId:state.review.focusContextEntryId,items:[
  {...priority(urgent,'Choose release window','Delivery deadline today','urgent','substantial','substantial'),deadlineAt:Date.now()/1000+3600},
  priority(unblocker,'Choose the available environment','Unblocks recording and validation','normal','substantial','small'),
  priority(trivial,'Inspect chart wording','Presentation cleanup can wait','normal','routine','small'),
  priority(other,'Wait for upstream delivery','External dependency remains','normal','substantial','substantial','other')
 ]};
 const response=await fetch(native+'/api/focus/task-priorities',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:owner.id,...order})});assert.equal(response.ok,false,'Workers cannot reprioritize shared work');
 const missingReason=await fetch(native+'/api/focus/task-priorities',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:focus.id,...order,requestId:crypto.randomUUID(),items:[{...order.items[0],humanReason:''}]})});assert.equal(missingReason.ok,false,'A status or generic review label cannot substitute for why human input is required');
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
 await panel.getByText('You: Choose release window',{exact:false}).waitFor();
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
 // Focus is a maintained decision queue; ordinary task tracking remains intact.
 const decisions=await browser.newPage({viewport:{width:1280,height:850}});
 await decisions.addInitScript(()=>{localStorage.setItem('oxroute.tasks','true');localStorage.setItem('oxroute.taskWidth','320');sessionStorage.setItem('oxroute.windowTasks','false');});
 await decisions.goto(`${base}/?view=focus`);
 const queue=decisions.locator('[data-task-panel]');
 await queue.getByRole('button',{name:'All tasks',exact:true}).waitFor();
 await queue.getByText('Choose release window',{exact:true}).waitFor();
 assert.deepEqual(await queue.locator('[data-task-open]').allInnerTexts(),order.items.filter(i=>i.nextActor==='human').map(i=>i.nextAction),'Only current human decisions occupy the primary queue');
 assert.equal(await queue.getByText(published.text,{exact:true}).count(),0,'Done status alone does not imply a decision');
 assert.equal(await queue.getByText(other.text,{exact:true}).count(),0,'Waiting on others is tracking context');
 for(const width of [1280,390]){
  await decisions.setViewportSize({width,height:850});
  const row=queue.locator('[data-task-row]').first();
  await row.getByText('The user owns this choice.',{exact:false}).waitFor();
  assert.ok((await row.innerText()).includes('Unblocks The selected delivery path.'));
  const box=await row.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
  if(process.env.DECISION_SCREENSHOT)await decisions.screenshot({path:process.env.DECISION_SCREENSHOT.replace('.png',`-${width}.png`)});
 }
 await decisions.reload();await queue.getByText('Choose release window',{exact:true}).waitFor();
 await queue.getByRole('button',{name:'All tasks',exact:true}).click();
 await queue.getByText(published.text,{exact:true}).waitFor();
 assert.ok(await queue.getByRole('combobox',{name:`status for ${published.text}`,exact:true}).isVisible(),'All status and approval controls remain accessible');
 await queue.getByRole('button',{name:'All tasks',exact:true}).click();
 const legacy=JSON.parse(db.prepare('SELECT details FROM task_priorities WHERE task_id=?').get(trivial.id).details);delete legacy.humanReason;delete legacy.unblocks;
 db.prepare('UPDATE task_priorities SET details=? WHERE task_id=?').run(JSON.stringify(legacy),trivial.id);
 await decisions.reload();await queue.getByText('Choose release window',{exact:true}).waitFor();
 assert.equal(await queue.getByText('Inspect chart wording',{exact:true}).count(),0,'Legacy recommendations without a grounded human action never become decisions');
 await api(`/api/tasks/${urgent.id}/notes`,{text:'A newer decision resolves this prerequisite; verification is now agent work.',agentId:owner.id});
 await queue.getByText('Choose release window',{exact:true}).waitFor({state:'hidden'});
 await decisions.reload();assert.equal(await queue.getByText('Choose release window',{exact:true}).count(),0,'Changed task evidence retires the old human action');
 await decisions.close();
 // Restore the actual fixture facts for independent manual-order checks below.
 const rebased=await api('/api/focus/task-priorities');
 const refreshed={...order,requestId:crypto.randomUUID(),items:order.items.map(item=>({...item,basis:rebased.priorities[item.taskId].basis}))};
 await api('/api/focus/task-priorities',{agentId:focus.id,...refreshed},'PUT');
 await page.setViewportSize({width:1280,height:850});
 await panel.getByRole('searchbox').fill('environment');assert.equal(await panel.locator('[data-task-open]').count(),1);await panel.getByRole('searchbox').fill('');
 await panel.getByRole('button',{name:'Only open conversations',exact:true}).click();assert.ok(await panel.locator('[data-task-open]').count()>0);await panel.getByRole('button',{name:'Only open conversations',exact:true}).click();
 await api(`/api/tasks/${trivial.id}/move`,{after:null});
 assert.equal((await api('/api/tasks'))[0].id,trivial.id,'Existing manual movement remains effective');
 assert.deepEqual(await api('/api/focus/task-priorities',{agentId:focus.id,...order},'PUT'),receipt);assert.equal((await api('/api/tasks'))[0].id,trivial.id,'Retries do not overwrite newer manual order');
 await page.close();await stop();daemon=start();await healthy();
 assert.equal((await api('/api/tasks'))[0].id,trivial.id);assert.equal((await api('/api/state')).taskPriorities[urgent.id].recommendation.nextAction,'Choose release window');
 page=await open();panel=page.locator('[data-task-panel]');rows=panel.locator('[data-task-row]');await panel.getByText('You: Choose release window',{exact:false}).waitFor();assert.equal(await rows.first().locator('[data-task-open]').innerText(),trivial.text);
 entry('you','Inspect an unrelated contextual metric.',focus.id);
 const unrelated=await api('/api/focus/task-priorities');
 assert.equal(unrelated.review.changed,true);assert.equal(unrelated.priorities[unblocker.id].stale,false,'Unrelated Focus input does not erase outcome-linked next action');
 assert.equal((await api('/api/tasks'))[0].id,trivial.id,'Unrelated input preserves manual order and valid priorities');
 await page.goto(`${base}/?view=focus`);
 await panel.getByText('Choose the available environment',{exact:true}).waitFor({timeout:3000});
 assert.equal(await panel.getByText('No verified decision queued. Agents continue their work.',{exact:true}).count(),0,'An unrelated conversation message cannot erase an existing decision');
 const independent=await task('Choose execution region');
 const pairState=await api('/api/focus/task-priorities');
 await mcp('prioritize_tasks',{requestId:crypto.randomUUID(),focusContextEntryId:pairState.review.focusContextEntryId,items:[{...order.items[1],basis:pairState.priorities[unblocker.id].basis},{...order.items[1],taskId:independent.id,basis:pairState.priorities[independent.id].basis,nextAction:'Select the permitted region'}]});
 entry('you','One independent choice is complete; keep the separate request pending.',focus.id);
 await api(`/api/tasks/${independent.id}`,{...independent,status:'complete',approved:true,note:'Fixture human completed this independent choice.'},'PUT');
 await page.reload();await panel.getByText('Choose the available environment',{exact:true}).waitFor();
 assert.equal(await panel.getByText('Select the permitted region',{exact:true}).count(),0,'Completing one human choice must not restore it or erase another pending decision');
 const onlyState=await api('/api/focus/task-priorities');
 const onlyDecision={requestId:crypto.randomUUID(),focusContextEntryId:onlyState.review.focusContextEntryId,items:[{...order.items[1],basis:onlyState.priorities[unblocker.id].basis}]};
 await mcp('prioritize_tasks',onlyDecision);

 assert.equal((await mcp('prioritize_tasks',{...order,requestId:crypto.randomUUID()})).isError,true,'New order requires reconciliation with fresh Focus human context');
 entry('you','The environment choice is complete. Revalidate the selected service.');
 const sourceAdvanced=await api('/api/focus/task-priorities');
 assert.equal(sourceAdvanced.priorities[unblocker.id].needsReview,true);assert.equal(sourceAdvanced.priorities[unblocker.id].stale,false,'Advanced conversation context requests reconciliation without silently canceling an outcome');
 await page.reload();await panel.getByText('Choose the available environment',{exact:true}).waitFor();
 await panel.getByText('Checking latest context',{exact:false}).waitFor();

 await api(`/api/tasks/${unblocker.id}/notes`,{text:'The human prerequisite is complete; agent verification is next.',agentId:owner.id});
 const stale=await api('/api/focus/task-priorities');assert.equal(stale.review.changed,true,'Changed evidence requests fresh Focus judgment');assert.equal(stale.priorities[unblocker.id].stale,true,'New actual human/source evidence withdraws old action');assert.equal(stale.priorities[unblocker.id].recommendation,null);
 await page.reload();await panel.getByText('Checking updated decision evidence. Agents continue their work.',{exact:true}).waitFor();
 assert.equal(await panel.getByText('Choose the available environment',{exact:true}).count(),0,'Changed task facts withdraw the old action without claiming all decisions resolved');
 await api(`/api/tasks/${trivial.id}/move`,{after:null});
 assert.equal((await api('/api/focus/task-priorities')).priorities[unblocker.id].stale,true,'Manual movement is not a resolution of pending decision evidence');
 await page.reload();await panel.getByText('Checking updated decision evidence. Agents continue their work.',{exact:true}).waitFor();

 await page.goto(`${base}/?agent=${owner.id}`);

 const rejected=await mcp('prioritize_tasks',{...order,requestId:crypto.randomUUID()});assert.equal(rejected.isError,true,'Stale evidence cannot restore an obsolete human obligation');
 const fresh={requestId:crypto.randomUUID(),focusContextEntryId:stale.review.focusContextEntryId,items:[{...order.items[1],basis:stale.priorities[unblocker.id].basis,nextActor:'agent',nextAction:'Revalidate the selected service',reason:'Human prerequisite completed',evidenceEntryIds:[entry('said','The selected environment is available for verification.')]}]};
 // The fresh result advances the source head, so read its new basis before applying.
 fresh.items[0].basis=(await api('/api/focus/task-priorities')).priorities[unblocker.id].basis;
 assert.equal((await mcp('prioritize_tasks',fresh)).isError,false);
 await page.reload();await panel.getByText('Next: Revalidate the selected service',{exact:false}).waitFor();assert.equal(await panel.getByText('You: Choose the available environment',{exact:false}).count(),0);
 await page.goto(`${base}/?view=focus`);
 await panel.getByText('No verified decision queued. Agents continue their work.',{exact:true}).waitFor();
 assert.equal(await panel.locator('[data-task-row]').count(),0,'Agent verification cannot fill an empty human decision queue');
 await panel.getByRole('button',{name:'All tasks',exact:true}).click();await panel.getByText('Next: Revalidate the selected service',{exact:false}).waitFor();
 await page.goto(`${base}/?agent=${owner.id}`);

 const preserved=(await api('/api/tasks')).find(t=>t.id===unblocker.id);assert.equal(preserved.agentId,owner.id);assert.equal(preserved.status,unblocker.status,'Priority judgment does not silently change status or consent');
 const parent=await task('Complete release preparation');
 const nested=await api(`/api/tasks/${urgent.id}`,{...urgent,parentTaskId:parent.id,note:'Retain the existing work hierarchy.'},'PUT');
 const nestedState=await api('/api/focus/task-priorities');
 await api('/api/focus/task-priorities',{agentId:focus.id,requestId:crypto.randomUUID(),focusContextEntryId:nestedState.review.focusContextEntryId,items:[{...order.items[0],basis:nestedState.priorities[nested.id].basis,evidenceEntryIds:fresh.items[0].evidenceEntryIds}]},'PUT');
 await page.reload();await panel.getByText('You: Choose release window',{exact:false}).waitFor();
 assert.equal(await rows.nth(0).locator('[data-task-open]').innerText(),parent.text,'Prioritized child brings its intact branch forward');
 assert.equal(await rows.nth(1).locator('[data-task-open]').innerText(),urgent.text);
 // A pending review is an artifact decision, independent of task wrappers.
 const second=await api('/api/agents',{});await api('/api/rename',{agent:second.id,name:'Storage validation'});
 const makeReview=async(agent,label)=>{const repo=join(root,`proposal-${agent.id}`);await mkdir(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('remote','add','origin','https://example.invalid/proposal.git');
  await writeFile(join(repo,'setting.txt'),'alpha\n');git('add','.');git('commit','-m','Initial settings');git('checkout','-b','proposal');await writeFile(join(repo,'setting.txt'),'beta\n');git('commit','-am','Proposed settings');
  return api(`/api/agents/${agent.id}/reviews`,{repository:repo,remote:'origin',base:'main',title:label,description:'Choose whether to publish the committed configuration.'});};
 const firstReview=await makeReview(owner,'Network Change Review'),secondReview=await makeReview(second,'Storage Change Review');
 const firstEvidence=entry('said','A committed proposal is ready for a publication decision.'),secondEvidence=entry('said','A separate committed proposal is ready for a publication decision.',second.id);
 const reviewState=await api('/api/focus/task-priorities');
 const reviewItem=(review,evidence,taskId)=>({...order.items[0],taskId,reviewId:review.id,basis:reviewState.reviews[review.id].basis,nextAction:'Inspect the committed proposal',humanReason:'Only the user can approve publication.',unblocks:'Publish the accepted committed revision.',evidenceEntryIds:[evidence]});
 const mixed={requestId:crypto.randomUUID(),focusContextEntryId:reviewState.review.focusContextEntryId,items:[reviewItem(firstReview,firstEvidence,urgent.id),reviewItem(firstReview,firstEvidence),reviewItem(secondReview,secondEvidence),{...order.items[1],basis:reviewState.priorities[unblocker.id].basis,nextAction:'Choose the execution plan',evidenceEntryIds:[firstEvidence]}]};
 const wrongOwner=await mcp('prioritize_tasks',{...mixed,requestId:crypto.randomUUID(),items:[reviewItem(secondReview,secondEvidence,urgent.id)]});assert.equal(wrongOwner.isError,true,'A tracking task cannot redirect a review to another owner');
 const beforeTasks=await api('/api/tasks');
 const reviewReceipt=(await mcp('prioritize_tasks',mixed)).structuredContent;assert.deepEqual(reviewReceipt.reviewIds,[firstReview.id,secondReview.id]);
 assert.equal((await api('/api/tasks')).length,beforeTasks.length,'Reviews never create wrapper tasks');
 const scopedReview=await browser.newPage();
 await scopedReview.addInitScript(()=>{localStorage.setItem('oxroute.tasks','true');sessionStorage.setItem('oxroute.windowTasks','true');});
 await scopedReview.goto(`${base}/?view=focus`);
 const scopedPanel=scopedReview.locator('[data-task-panel]');
 await scopedPanel.getByText(secondReview.title,{exact:true}).waitFor();
 await scopedReview.setViewportSize({width:390,height:850});
 const decisionBox=await scopedPanel.boundingBox();assert.ok(decisionBox.x>=0&&decisionBox.x+decisionBox.width<=390,'Default-width decisions fit a narrow viewport');
 assert.equal(await scopedPanel.getByRole('button',{name:'Only open conversations',exact:true}).getAttribute('aria-pressed'),'false','Cross-thread decisions are independent of window-scoped task defaults');
 entry('you','Check progress on a separate outcome.',focus.id);await scopedReview.reload();await scopedPanel.getByText(secondReview.title,{exact:true}).waitFor();
 await scopedPanel.getByRole('button',{name:'Only open conversations',exact:true}).click();
 assert.equal(await scopedPanel.getByText(secondReview.title,{exact:true}).count(),0,'Explicit decision scope remains available');
 await scopedPanel.getByText('No decisions for open conversations.',{exact:true}).waitFor();
 await scopedPanel.getByRole('button',{name:'All tasks',exact:true}).click();
 assert.equal(await scopedPanel.getByRole('button',{name:'Only open conversations',exact:true}).getAttribute('aria-pressed'),'true','Task scope is preserved independently');
 await scopedReview.close();

 await page.goto(`${base}/?view=focus`);await panel.getByText(firstReview.title,{exact:true}).waitFor();
 assert.deepEqual(await panel.locator('[data-task-open]').allInnerTexts(),[firstReview.title,secondReview.title,'Choose the execution plan'],'Task-backed and taskless representations share one review identity');
 const tabCount=await page.getByRole('tab').count();
 await page.locator('[data-composer]').fill('Retain the decision note.');
 await panel.getByText(firstReview.title,{exact:true}).click();
 let deck=page.locator('[data-focus-decisions]');await deck.locator(`[data-focus-review="${firstReview.id}"]`).getByRole('button',{name:'Approve publication',exact:true}).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('view'),'focus');assert.equal(await page.getByRole('tab').count(),tabCount);
 for(const width of[1280,390]){await page.setViewportSize({width,height:850});const box=await deck.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);if(process.env.REVIEW_SCREENSHOT)await page.screenshot({path:process.env.REVIEW_SCREENSHOT.replace('.png',`-${width}.png`)});}
 await page.setViewportSize({width:1280,height:850});
 await deck.getByRole('button',{name:'Next decision',exact:true}).click();await deck.locator(`[data-focus-review="${secondReview.id}"]`).waitFor();
 await page.reload();deck=page.locator('[data-focus-decisions]');await deck.locator(`[data-focus-review="${secondReview.id}"]`).waitFor();
 await deck.getByRole('button',{name:'Next decision',exact:true}).click();await deck.locator(`[data-focus-conversation="${owner.id}"]`).waitFor();
 assert.equal(await page.getByRole('tab').count(),tabCount,'Normal decision cards stay inside Focus too');
 await deck.getByRole('button',{name:'Previous decision',exact:true}).click();await deck.locator(`[data-focus-review="${secondReview.id}"]`).getByRole('button',{name:'Edit setting.txt',exact:true}).click();
 await page.getByRole('textbox',{name:'File contents setting.txt',exact:true}).waitFor();await page.getByRole('button',{name:'Cancel edit',exact:true}).click();
 await deck.getByRole('button',{name:'Previous decision',exact:true}).click();
 const quoted=deck.locator('[data-diff-line]').filter({hasText:'beta'}).first();await quoted.click({button:'right'});await page.getByRole('button',{name:'Quote diff into chat',exact:true}).click();
 await deck.waitFor({state:'hidden'});await page.getByRole('region',{name:'Attached diff setting.txt',exact:true}).waitFor();assert.equal(await page.locator('[data-composer]').inputValue(),'Retain the decision note.','Quoting preserves the Focus draft');
 await page.locator('[data-composer]').press('Enter');
 for(let i=0;i<60&&!db.prepare("SELECT id FROM entries WHERE agent_id=? AND kind='you' AND instr(detail,?)>0").get(focus.id,firstReview.id);i++)await new Promise(done=>setTimeout(done,100));
 assert.ok(db.prepare("SELECT id FROM entries WHERE agent_id=? AND kind='you' AND instr(detail,?)>0").get(focus.id,firstReview.id),'The attached quote retains original review identity in the actual Focus submission');
 entry('you','Inspect an independent status update.',focus.id);await page.reload();await panel.getByText(firstReview.title,{exact:true}).waitFor();
 assert.equal(await panel.getByText('No verified decision queued. Agents continue their work.',{exact:true}).count(),0,'Context changes retain taskless and multi-owner reviews');
 for(const review of[firstReview,secondReview])assert.equal(JSON.parse(db.prepare('SELECT value FROM kv WHERE key=?').get(`review:${review.id}`).value).approvedAt,null,'Selecting, quoting and editing do not approve reviews');
 await panel.getByText(firstReview.title,{exact:true}).click();deck=page.locator('[data-focus-decisions]');await deck.getByRole('button',{name:'Approve publication',exact:true}).click();
 for(let i=0;i<60&&!JSON.parse(db.prepare('SELECT value FROM kv WHERE key=?').get(`review:${firstReview.id}`).value).approvedAt;i++)await new Promise(done=>setTimeout(done,100));
 assert.ok(JSON.parse(db.prepare('SELECT value FROM kv WHERE key=?').get(`review:${firstReview.id}`).value).approvedAt);assert.equal(JSON.parse(db.prepare('SELECT value FROM kv WHERE key=?').get(`review:${secondReview.id}`).value).approvedAt,null,'Human approval applies only to the selected owner and artifact');
 assert.equal((await api('/api/tasks')).find(t=>t.id===urgent.id).status,beforeTasks.find(t=>t.id===urgent.id).status,'Review approval never closes its broader tracking task');
 await page.close();
 db.prepare('DELETE FROM kv WHERE key=?').run(`review-status:${secondReview.id}`);
 let grounding=await api('/api/focus/task-priorities');assert.equal(grounding.reviews[secondReview.id].status,'unverified');
 const unverified=await mcp('prioritize_tasks',{requestId:crypto.randomUUID(),focusContextEntryId:grounding.review.focusContextEntryId,items:[{...reviewItem(secondReview,secondEvidence),basis:grounding.reviews[secondReview.id].basis}]});assert.equal(unverified.isError,true,'Stored pending metadata cannot substitute for an observed artifact status');
 assert.equal((await api(`/api/agents/${second.id}/reviews/${secondReview.id}`)).status,'pending');
 await writeFile(join(secondReview.snapshot.repository,'setting.txt'),'gamma\n');execFileSync('git',['-C',secondReview.snapshot.repository,'commit','-am','Advance proposal'],{stdio:'ignore'});
 assert.equal((await api(`/api/agents/${second.id}/reviews/${secondReview.id}`)).status,'stale');
 grounding=await api('/api/focus/task-priorities');assert.equal(grounding.reviews[secondReview.id].status,'stale');assert.equal(grounding.reviews[secondReview.id].recommendation,null);
 const obsolete=await mcp('prioritize_tasks',{requestId:crypto.randomUUID(),focusContextEntryId:grounding.review.focusContextEntryId,items:[{...reviewItem(secondReview,secondEvidence),basis:grounding.reviews[secondReview.id].basis}]});assert.equal(obsolete.isError,true,'A stale saved snapshot remains readable without becoming a ready publication decision');

 assert.deepEqual(errors,[]);
 console.log('Real daemon: contextual order, native/API authorization and receipts, manual moves, reload/restart, fresh evidence, unchanged ownership/status, search/scope, keyboard and 1280/390 sidebar passed.');
} finally {if(browser)await browser.close();if(db)db.close();await stop();await new Promise(done=>proxy.close(done));await rm(root,{recursive:true,force:true});}
