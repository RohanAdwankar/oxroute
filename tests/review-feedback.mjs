// Real daemon, Git snapshots, durable human feedback and a local credential-free runtime.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {createServer,request} from 'node:http';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
const {WebSocketServer}=createRequire(import.meta.url)('next/dist/compiled/ws');
assert.ok(process.env.TEST_URL&&process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'),{recursive:true});const root=await mkdtemp(resolve('.tmp/review-feedback-'));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(check,label)=>{for(let n=0;n<150;n++){if(await check())return;await pause(50);}assert.fail(label);};
const transport=createServer(),rpc=new WebSocketServer({server:transport}),rpcPort=await listen(transport);
let serial=0,rejectStarts=false,holdTurns=false,interrupts=0;const turns=[],sessions=new Map(),reviews=[];
const send=(socket,method,params)=>socket.readyState===1&&socket.send(JSON.stringify({method,params}));
const finish=thread=>{const active=sessions.get(thread);if(!active||active.done)return;active.done=true;const {socket,turn}=active;
 send(socket,'item/completed',{threadId:thread,item:{id:`answer-${turn.id}`,type:'agentMessage',text:reviews.map(review=>`[Prepared review](#review/${review.id})`).join('\n\n')||'Local feedback received.',phase:'final_answer'}});
 send(socket,'turn/completed',{threadId:thread,turn:{...turn,status:'completed'}});
};
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);if(id===undefined)return;let result={};
 if(method==='thread/start')result={thread:{id:`feedback-session-${++serial}`}};
 if(method==='thread/resume')result={thread:{id:params.threadId}};
 if(method==='turn/interrupt'){interrupts++;const active=sessions.get(params.threadId);if(active){active.done=true;send(socket,'turn/completed',{threadId:params.threadId,turn:{...active.turn,status:'interrupted'}});}}
 if(method==='turn/start'){
  if(rejectStarts){socket.send(JSON.stringify({id,error:{code:-32000,message:'Local runtime temporarily unavailable'}}));return;}
  const turn={id:`feedback-turn-${++serial}`,status:'inProgress'};result={turn};turns.push({...params,turn});sessions.set(params.threadId,{socket,turn,done:false});
  setTimeout(()=>{send(socket,'turn/started',{threadId:params.threadId,turn});if(!holdTurns)finish(params.threadId);},10);
 }
 socket.send(JSON.stringify({id,result}));
}));
const reserve=createServer(),port=await listen(reserve);await new Promise(done=>reserve.close(done));
const native=`http://127.0.0.1:${port}`,database=join(root,'state.sqlite3'),config=join(root,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(database)}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const start=()=>spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',RUST_LOG:'error',CODEX_HOME:join(root,'codex'),OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:`ws://127.0.0.1:${rpcPort}`,OXROUTE_CODEX_CLI:'/bin/false'}});
let daemon=start();
const stop=async()=>{daemon.kill('SIGKILL');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));};
const healthy=()=>until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}},'Daemon did not start');
const api=async(path,body,method='POST')=>{const response=await fetch(native+path,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`${path}: ${await response.clone().text()}`);return response.json();};
const decide=async(path,body,expectOk=true)=>{const form=new FormData();form.set('decision',JSON.stringify(body));const response=await fetch(native+path+'/decision',{method:'POST',body:form});if(!expectOk)return response;assert.ok(response.ok,`${path}: ${await response.clone().text()}`);return response.json();};
const decision=async request=>JSON.parse((await new Response(request.postDataBuffer(),{headers:request.headers()}).formData()).get('decision'));
const proxy=createServer((req,res)=>{const target=new URL(req.url,req.url.startsWith('/api/')&&!req.url.startsWith('/api/version')?native:process.env.TEST_URL);const upstream=request(target,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);res.on('close',()=>upstream.destroy());});
const base=`http://127.0.0.1:${await listen(proxy)}`;
let browser,db;
try{
 await healthy();for(const name of['automatic-titles','automatic-tags','recommendation-learning','next-action-suggestions'])await api(`/api/${name}`,{enabled:false});
 const owner=await api('/api/agents',{});await api('/api/rename',{agent:owner.id,name:'Review source'});
 const makeReview=async(file,before,after,title)=>{
  const repo=join(root,`proposal-${reviews.length}`);await mkdir(repo);const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe',encoding:'utf8'}).trim();
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('remote','add','origin','https://example.invalid/proposal.git');
  await writeFile(join(repo,file),before);git('add','.');git('commit','-m','Initial proposal');git('checkout','-b','proposal');await writeFile(join(repo,file),after);git('commit','-am','Revise proposal');
  const review=await api(`/api/agents/${owner.id}/reviews`,{kind:'git',repository:repo,remote:'origin',base:'main',title,description:'Inspect the prepared local revision.'});reviews.push(review);return review;
 };
 const textReview=await makeReview('settings.txt','limit=2\n','limit=3\n','Review configuration change');
 const svg=color=>`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="180" height="100" fill="${color}"/></svg>`;
 const imageReview=await makeReview('diagram.svg',svg('#777777'),svg('#444444'),'Review diagram change');
 const binaryReview=await makeReview('payload.bin',Buffer.from([0,1,2]),Buffer.from([0,3,4]),'Review binary change');
 const task=await api('/api/tasks',{text:'Revise prepared proposal'});await api(`/api/tasks/${task.id}`,{...task,agentId:owner.id,status:'waiting_for_human',note:'Awaiting a review decision.'},'PUT');
 const focus=await api('/api/focus/agent',{});await until(async()=>(await api(`/api/agents/${focus.id}`)).timeline.some(entry=>entry.kind==='said'),'Focus did not render reviews');
 db=new DatabaseSync(database);db.exec('PRAGMA busy_timeout=5000');
 const evidence=Number(db.prepare("INSERT INTO entries(agent_id,at,kind,text) VALUES(?,?,'said',?)").run(owner.id,Date.now()/1000,'The prepared visual proposal is ready for inspection.').lastInsertRowid);
 const state=await api('/api/focus/task-priorities');await api('/api/focus/task-priorities',{agentId:focus.id,requestId:crypto.randomUUID(),focusContextEntryId:state.review.focusContextEntryId,items:[{reviewId:imageReview.id,basis:state.reviews[imageReview.id].basis,nextAction:'Inspect the prepared diagram',reason:'A local image revision is ready.',humanReason:'The user owns this decision.',unblocks:'Revise or publish the inspected proposal.',nextActor:'human',urgency:'normal',impact:'routine',effort:'small',evidenceEntryIds:[evidence]}]},'PUT');
 const tasksBefore=await api('/api/tasks');
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 let failBefore=true,loseReply=false;const submissions=[];
 await page.route('**/decision',async route=>{const body=await decision(route.request());if(body.status!=='changes_requested')return route.continue();submissions.push(body);if(failBefore){failBefore=false;return route.fulfill({status:503,json:{error:'Feedback temporarily unavailable'}});}if(loseReply){loseReply=false;await route.fetch();return route.abort();}return route.continue();});
 await page.goto(`${base}/?view=focus&decision=${imageReview.id}`);const deck=page.locator('[data-focus-decisions]');await deck.getByRole('button',{name:'Request changes',exact:true}).click();
 const reason=page.getByRole('textbox',{name:'Requested changes',exact:true}),sendFeedback=page.getByRole('button',{name:'Send feedback',exact:true});assert.equal(await sendFeedback.isDisabled(),true);
 await reason.fill('Increase the diagram scale.');await page.getByRole('button',{name:'Cancel feedback',exact:true}).click();assert.equal(submissions.length,0);assert.equal((await api(`/api/agents/${owner.id}/reviews/${imageReview.id}`)).feedback.length,0,'Cancellation never submits feedback');
 await deck.getByRole('button',{name:'Request changes',exact:true}).click();assert.equal(await reason.inputValue(),'Increase the diagram scale.');await sendFeedback.focus();await sendFeedback.press('Enter');await page.getByRole('alert').filter({hasText:'Feedback temporarily unavailable'}).waitFor();assert.equal(await reason.inputValue(),'Increase the diagram scale.');
 for(const width of[1280,390]){await page.setViewportSize({width,height:900});const box=await reason.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);if(process.env.SCREENSHOT)await page.screenshot({path:`${process.env.SCREENSHOT}-form-${width}.png`});}
 await sendFeedback.click();await until(async()=>(await api(`/api/agents/${owner.id}/reviews/${imageReview.id}`)).feedback.length===1,'Feedback not saved');assert.equal(submissions[0].requestId,submissions[1].requestId,'Failed saves retain the same retry identity');
 await page.waitForURL(url=>url.searchParams.get('agent')===owner.id&&!url.searchParams.has('review')&&!url.searchParams.has('decision'));if(process.env.SCREENSHOT)await page.screenshot({path:`${process.env.SCREENSHOT}-returned-390.png`});
 let saved=await api(`/api/agents/${owner.id}/reviews/${imageReview.id}`);assert.equal(saved.status,'changes_requested');assert.notEqual(saved.decision?.status,'approved');assert.equal(saved.feedback[0].revision,imageReview.subject.headCommit);
 await page.goto(`${base}/?agent=${owner.id}&review=${imageReview.id}`);await page.getByRole('region',{name:'Review feedback',exact:true}).getByText('Increase the diagram scale.',{exact:true}).waitFor();await page.reload();await page.getByRole('region',{name:'Review feedback',exact:true}).getByText('Increase the diagram scale.',{exact:true}).waitFor();
 for(const width of[1280,390]){await page.setViewportSize({width,height:900});if(process.env.SCREENSHOT)await page.screenshot({path:`${process.env.SCREENSHOT}-saved-${width}.png`});}
 await page.getByRole('button',{name:'Approve publication',exact:true}).click();await until(async()=>(await api(`/api/agents/${owner.id}/reviews/${imageReview.id}`)).status==='approved','Explicit approval remains available after feedback');
 saved=await decide(`/api/agents/${owner.id}/reviews/${imageReview.id}`,submissions[1]);assert.equal(saved.status,'approved','An older feedback retry cannot revoke newer explicit approval');assert.equal(saved.feedback.length,1);
 const wrong=await decide(`/api/agents/${owner.id}/reviews/${textReview.id}`,{status:'changes_requested',requestId:crypto.randomUUID(),revision:imageReview.subject.headCommit,text:'Inspect a different revision.'},false);assert.equal(wrong.ok,false,'Feedback cannot drift to another snapshot');
 await page.setViewportSize({width:1280,height:900});await page.goto(`${base}/?agent=${owner.id}&review=${textReview.id}`);await page.getByRole('button',{name:'Request changes',exact:true}).click();await reason.fill('Explain the changed limit.');
 rejectStarts=true;loseReply=true;await sendFeedback.click();await page.getByRole('alert').waitFor();assert.equal(await reason.inputValue(),'Explain the changed limit.','A lost acknowledgement retains the human explanation');
 const pendingBody=submissions.at(-1),entry=(await api(`/api/agents/${owner.id}`)).timeline.findLast(entry=>entry.kind==='you'&&entry.detail.startsWith('review-feedback:')&&entry.text.includes(textReview.id));assert.ok(entry,'Human feedback is durably recorded in the original owner conversation');
 assert.ok(entry.text.includes(textReview.subject.headCommit));assert.notEqual((await api(`/api/agents/${owner.id}/reviews/${textReview.id}`)).decision?.status,'approved');
 await stop();rejectStarts=false;holdTurns=true;daemon=start();await healthy();await until(()=>turns.some(turn=>turn.input[0]?.text===entry.text),'Pending feedback was not delivered after restart');
 const received=turns.filter(turn=>turn.input[0]?.text===entry.text);assert.equal(received.length,1);assert.equal((await api(`/api/agents/${owner.id}`)).agent.sessionId,received[0].threadId,'Delivery uses the original owning session');
 const target=JSON.parse(db.prepare('SELECT target FROM active_turns WHERE agent_id=?').get(owner.id).target);assert.deepEqual(target,{source:'you',conversation:'local',threadKey:owner.id},'Feedback never routes through external conversation bindings');
 await page.reload();await page.getByRole('region',{name:'Review feedback',exact:true}).getByText('Explain the changed limit.',{exact:true}).waitFor();await page.getByRole('button',{name:'Request changes',exact:true}).click();assert.equal(await reason.inputValue(),'Explain the changed limit.');await sendFeedback.click();await reason.waitFor({state:'hidden'});await page.waitForURL(url=>url.searchParams.get('agent')===owner.id&&!url.searchParams.has('review')&&!url.searchParams.has('decision'));if(process.env.SCREENSHOT)await page.screenshot({path:`${process.env.SCREENSHOT}-returned-1280.png`});
 const history=(await api(`/api/agents/${owner.id}`)).timeline.filter(item=>item.kind==='you'&&item.requestId===entry.requestId);assert.equal(history.length,1);assert.equal((await api(`/api/agents/${owner.id}/reviews/${textReview.id}`)).feedback.length,1);
 const collision=await decide(`/api/agents/${owner.id}/reviews/${textReview.id}`,{...pendingBody,text:'Another explanation.'},false);assert.equal(collision.ok,false,'A retry identity cannot overwrite different human feedback');
 holdTurns=false;for(const thread of sessions.keys())finish(thread);await pause(100);assert.equal(turns.filter(turn=>turn.input[0]?.text===entry.text).length,1,'Retries never start a second feedback turn');
 await page.goto(`${base}/?view=focus`);const embedded=page.locator(`[data-focus-review="${binaryReview.id}"]`).first();await embedded.getByRole('button',{name:'Request changes',exact:true}).click();await reason.fill('Document how to inspect the binary.');await sendFeedback.click();await reason.waitFor({state:'hidden'});await page.waitForURL(url=>url.searchParams.get('agent')===owner.id&&!url.searchParams.has('review')&&!url.searchParams.has('decision'));await page.goto(`${base}/?agent=${owner.id}&review=${binaryReview.id}`);await page.getByRole('region',{name:'Review feedback',exact:true}).getByText('Document how to inspect the binary.',{exact:true}).waitFor();
 assert.equal((await api(`/api/agents/${owner.id}/reviews/${binaryReview.id}`)).status,'changes_requested','Binary-only reviews support the same feedback flow');
 assert.deepEqual(await api('/api/tasks'),tasksBefore,'Review feedback and approvals never close the broader tracking task');assert.equal(interrupts,0);assert.deepEqual(errors,[]);
 const binaryEntry=(await api(`/api/agents/${owner.id}`)).timeline.findLast(item=>item.kind==='you'&&item.text.includes(binaryReview.id));
 await until(async()=>turns.some(turn=>turn.input[0]?.text===binaryEntry.text)&&(await api(`/api/agents/${owner.id}`)).agent.status==='complete','Binary feedback did not finish its local turn');
 holdTurns=true;await api('/api/say',{agent:owner.id,text:'Continue inspecting the prepared configuration.'});await until(async()=>(await api(`/api/agents/${owner.id}`)).agent.status==='working','Owner did not enter its active turn');
 const queued={status:'changes_requested',requestId:crypto.randomUUID(),revision:textReview.subject.headCommit,text:'Retain the remaining configuration evidence.'};await decide(`/api/agents/${owner.id}/reviews/${textReview.id}`,queued);
 const stoppedEntry=(await api(`/api/agents/${owner.id}`)).timeline.findLast(item=>item.kind==='you'&&item.text.includes(queued.text));assert.ok(stoppedEntry);
 await api('/api/interrupt',{agent:owner.id});await decide(`/api/agents/${owner.id}/reviews/${textReview.id}`,queued);
 holdTurns=false;for(const thread of sessions.keys())finish(thread);await stop();daemon=start();await healthy();await pause(150);
 assert.equal(turns.filter(turn=>turn.input[0]?.text===stoppedEntry.text).length,0,'A newer explicit stop cancels undelivered feedback wakes without deleting the human feedback');
 assert.equal((await api(`/api/agents/${owner.id}/reviews/${textReview.id}`)).feedback.at(-1).text,queued.text);assert.equal(interrupts,1,'Only the explicit stop interrupts a turn');
 assert.deepEqual(await api('/api/tasks'),tasksBefore);
 console.log('Real review feedback: exact snapshots, image/binary/embedded/full UI, cancellation, retained drafts, failed/lost responses, safe retries, local human delivery, restart recovery, explicit later approval, reload history and unchanged tasks passed.');
}finally{if(browser)await browser.close();if(db)db.close();await stop();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));for(const socket of rpc.clients)socket.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>transport.close(done));await rm(root,{recursive:true,force:true});}
