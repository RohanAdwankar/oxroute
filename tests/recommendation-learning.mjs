// Production UI + disposable daemon + local Codex JSON-RPC transport.
// No inference credentials or shared services are used.
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {chromium,webkit} from 'playwright';
const {WebSocketServer}=createRequire(import.meta.url)('next/dist/compiled/ws');
assert.ok(process.env.TEST_DAEMON,'TEST_DAEMON must name the reviewed daemon');
await mkdir(resolve('.tmp'),{recursive:true});
const root=await mkdtemp(resolve('.tmp/recommendation-learning-'));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const rpcHttp=createServer(),rpc=new WebSocketServer({server:rpcHttp}),rpcPort=await listen(rpcHttp);
const actions=[{label:'Apply changes',message:'Apply the proposed changes after checking the current configuration'},
 {label:'Explain findings',message:'Explain how you verified these findings'},
 {label:'Check alternatives',message:'Compare the available alternatives'}];
let next=0,reflections=[],predictionPrompts=[],routingPrompts=[],routeAgent='',blockedSend=false,holdLearning=false;
const learned='Prefer inspecting supporting evidence before proposing changes.';
const learnedRouting='Prefer the ongoing agent for the relevant project over generic sessions.';
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);
 if(id===undefined)return;
 let result={};
 if(method==='thread/start') result={thread:{id:`thread-${++next}`}};
 if(method==='thread/resume') result={thread:{id:params.threadId}};
 if(method==='turn/start') {
  const turn={id:`turn-${++next}`,status:'completed'};result={turn};
  const prediction=!!params.outputSchema?.properties?.actions;
  const learning=!!params.outputSchema?.properties?.guidance;
  const routing=!!params.outputSchema?.properties?.agentIds;
  const text=learning?JSON.stringify({guidance:params.input[0].text.includes('input-routing')?learnedRouting:learned}):routing?JSON.stringify({action:'existing',agentIds:[routeAgent],reason:'This agent owns the related ongoing work'}):prediction?JSON.stringify({actions,automatic:null}):params.outputSchema?JSON.stringify({title:'Configuration review'}):'The configuration check is complete.';
  if(routing)routingPrompts.push(params.input[0].text);
  if(learning)reflections.push(params.input[0].text);
  if(prediction)predictionPrompts.push(params.input[0].text);
  if(!learning||!holdLearning)setTimeout(()=>{
   for(const [method,extra] of [['turn/started',{turn}],['item/completed',{item:{id:`item-${next}`,type:'agentMessage',text,phase:'final_answer'}}],['turn/completed',{turn}]])
    if(socket.readyState===1)socket.send(JSON.stringify({method,params:{threadId:params.threadId,...extra}}));
  },20);
 }
 socket.send(JSON.stringify({id,result}));
}));
const reserve=createServer(),port=await listen(reserve);await new Promise(done=>reserve.close(done));
const native=`http://127.0.0.1:${port}`,config=join(root,'config.toml');
await writeFile(config,`owner = "fixture"\nlisten = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\n[limits]\nmin_free_bytes = 0\n[paths]\ndatabase = ${JSON.stringify(join(root,'test.sqlite3'))}\nartifacts = ${JSON.stringify(join(root,'artifacts'))}\nattachments = ${JSON.stringify(join(root,'attachments'))}\n`);
const start=()=>spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{...process.env,CODEX_HOME:join(root,'codex'),OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:`ws://127.0.0.1:${rpcPort}`,OXROUTE_CODEX_CLI:'/bin/false'}});
let daemon=start();
const frontend=process.env.TEST_URL??'http://127.0.0.1:14039';
const proxy=createServer((req,res)=>{
 if(blockedSend&&req.method==='POST'&&req.url==='/api/say'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Delivery unavailable'}));return;}
 const upstream=new URL(req.url,req.url.startsWith('/api/')&&!req.url.startsWith('/api/version')?native:frontend);
 const call=request(upstream,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
 call.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(call);res.on('close',()=>call.destroy());
});
const ui=`http://127.0.0.1:${await listen(proxy)}`;
let browser;
const api=async(path,body)=>{const response=await fetch(native+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`${path}: ${response.status}`);return response.json();};
const until=async(check)=>{for(let n=0;n<150;n++){if(await check())return;await pause(100);}assert.fail('Expected state did not arrive');};
try{
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 await api('/api/automatic-titles',{enabled:false});
 const send=(agent,text,requestId=crypto.randomUUID())=>api('/api/say',{agent:agent.id,text,requestId});
 const detail=agent=>api(`/api/agents/${agent.id}`);
 const suggestions=async agent=>until(async()=>(await detail(agent)).nextActions?.recommendationId>0);
 const unseen=await api('/api/agents',{});await send(unseen,'Inspect the current service configuration');await suggestions(unseen);
 await send(unseen,'Show the underlying measurements');await suggestions(unseen);await pause(150);
 assert.equal(reflections.length,0,'Predictions that were not displayed do not train');
 const agent=await api('/api/agents',{});await send(agent,'Inspect the service configuration');await suggestions(agent);
 browser=await (process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const shown=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/shown')&&r.ok());
 await page.goto(`${ui}/?agent=${agent.id}`);await page.getByRole('group',{name:'Suggested next steps'}).waitFor();await shown;
 await pause(100);assert.equal(reflections.length,0,'Merely displaying suggestions does not train');
 const requestId=crypto.randomUUID();await send(agent,'Show evidence supporting the result',requestId);await send(agent,'Show evidence supporting the result',requestId);
 await until(async()=>(await api('/api/recommendation-learning')).nextActions.revision===1);
 assert.equal(reflections.length,1,'An accepted alternative trains once despite delivery retries');
 assert.ok(reflections[0].includes('Show evidence supporting the result'));assert.ok(reflections[0].includes('Apply changes'));
 assert.equal((await api('/api/recommendation-learning')).inputRouting.revision,0,'Domains remain independent');
 await suggestions(agent);
 const pending=(await detail(agent)).nextActions.recommendationId;
 const nextShown=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/recommendations/${pending}/shown`&&r.ok());
 await page.reload();await nextShown;
 const choices=page.getByRole('group',{name:'Suggested next steps'});
 blockedSend=true;const beforeFailure=reflections.length;
 await choices.getByRole('button',{name:actions[2].label,exact:true}).click();
 await until(async()=>(await page.locator('[data-composer]').inputValue())===actions[2].message);
 assert.equal(reflections.length,beforeFailure,'Failed delivery does not train');
 blockedSend=false;
 const positiveBefore=(await api('/api/recommendation-learning')).nextActions.revision;
 await choices.getByRole('button',{name:actions[1].label,exact:true}).click();
 await until(async()=>(await api('/api/recommendation-learning')).nextActions.revision>positiveBefore);
 assert.ok(reflections.at(-1).includes('"selected":1'),'Choosing a proposed response supplies positive feedback');
 await suggestions(agent);await send(agent,'Check another configuration source');await suggestions(agent);
 await until(()=>predictionPrompts.some(prompt=>prompt.includes(learned)));
 const routeFirst=await api('/api/agents',{}),routeChosen=await api('/api/agents',{});
 await api('/api/rename',{agent:routeFirst.id,name:'General checks'});await api('/api/rename',{agent:routeChosen.id,name:'Storage project'});
 routeAgent=routeFirst.id;await api('/api/mode',{mode:'ask'});
 const text='Review storage capacity for the ongoing project';
 const incoming=await api('/api/signal',{source:'fixture-email',conversation:'fixture-mailbox',text});
 const advice=await api(`/api/routing-recommendations/${incoming.signal}`,{});
 assert.equal(advice.agentIds[0],routeFirst.id);
 const routeShown=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/recommendations/${advice.recommendationId}/shown`&&r.ok());
 await page.goto(ui);await page.getByText(text,{exact:true}).click();await routeShown;
 await page.getByLabel('Suggested route',{exact:true}).waitFor();
 if(process.env.ROUTING_SCREENSHOT)await page.screenshot({path:process.env.ROUTING_SCREENSHOT});
 const previousNext=(await api('/api/recommendation-learning')).nextActions.revision;
 await api('/api/route',{signal:incoming.signal,action:'existing',agentIds:[routeChosen.id]});
 await until(async()=>(await api('/api/recommendation-learning')).inputRouting.revision===1);
 const guidance=await api('/api/recommendation-learning');assert.equal(guidance.nextActions.revision,previousNext);assert.equal(guidance.inputRouting.guidance,learnedRouting);
 const another=await api('/api/signal',{source:'fixture-email',conversation:'another-mailbox',text:'Inspect another storage capacity report'});
 await api(`/api/routing-recommendations/${another.signal}`,{});
 assert.ok(routingPrompts.at(-1).includes(learnedRouting));
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const learning=page.locator('section').filter({has:page.getByText('Learn from choices',{exact:true})});
 await learning.getByTitle('Keep current guidance without learning',{exact:true}).click();
 await until(async()=>!(await api('/api/recommendation-learning')).enabled);
 await page.keyboard.press('Escape');
 const before=reflections.length;await send(agent,'Compare against the previous measurements');await suggestions(agent);await pause(200);assert.equal(reflections.length,before);
 await page.getByRole('button',{name:'Settings',exact:true}).click();if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await page.close();daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));daemon=start();
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 const restored=await api('/api/recommendation-learning');assert.equal(restored.enabled,false);assert.equal(restored.nextActions.guidance,learned);assert.equal(restored.inputRouting.guidance,learnedRouting);
 await api('/api/recommendation-learning',{enabled:true});
 const recovery=await api('/api/agents',{});await send(recovery,'Inspect the network configuration');await suggestions(recovery);
 const recoveryId=(await detail(recovery)).nextActions.recommendationId;
 const recoveryPage=await browser.newPage();
 const recoveryShown=recoveryPage.waitForResponse(r=>new URL(r.url()).pathname===`/api/recommendations/${recoveryId}/shown`&&r.ok());
 await recoveryPage.goto(`${ui}/?agent=${recovery.id}`);await recoveryShown;
 const revision=(await api('/api/recommendation-learning')).nextActions.revision,reflectionCount=reflections.length;
 holdLearning=true;await send(recovery,'Explain the observations before changing configuration');
 await until(()=>reflections.length>reflectionCount);
 assert.equal((await api('/api/recommendation-learning')).nextActions.revision,revision,'An unfinished refinement has not been committed');
 await recoveryPage.close();daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 holdLearning=false;daemon=start();
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 await until(async()=>(await api('/api/recommendation-learning')).nextActions.revision===revision+1);
 assert.equal((await api('/api/recommendation-learning')).inputRouting.guidance,learnedRouting);
 console.log('Both recommendation domains learn presented choices independently; unseen, silent, failed and disabled choices do not train; guidance and unfinished feedback survive restart.');
}finally{
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 for(const client of rpc.clients)client.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>rpcHttp.close(done));await rm(root,{recursive:true,force:true});
}
