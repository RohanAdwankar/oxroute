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
const root=await mkdtemp(resolve('.tmp/next-actions-'));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const rpcHttp=createServer(),rpc=new WebSocketServer({server:rpcHttp}),rpcPort=await listen(rpcHttp);
const actions=[{label:'Apply changes',message:'Apply the proposed changes after checking the current configuration'},
 {label:'Explain findings',message:'Explain how you verified these findings'},
 {label:'Check alternatives',message:'Compare the available alternatives'}];
let next=0,predictions=0,turns=[],automatic=null,failSend=false,reflections=[],predictionPrompts=[];
const learned='Prefer inspecting supporting evidence before proposing changes.';
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
  const text=learning?JSON.stringify({guidance:learned}):prediction?JSON.stringify({actions,automatic}):params.outputSchema?JSON.stringify({title:'Configuration review'}):'The configuration check is complete.';
  if(learning)reflections.push(params.input[0].text);
  if(prediction)predictionPrompts.push(params.input[0].text);
  if(prediction){predictions++;automatic=null;}else if(!params.outputSchema)turns.push(params.input);
  setTimeout(()=>{
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
 if(failSend&&req.method==='POST'&&req.url==='/api/say'){failSend=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Delivery unavailable'}));return;}
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
 await suggestions(agent);await send(agent,'Check another configuration source');await suggestions(agent);
 await until(()=>predictionPrompts.some(prompt=>prompt.includes(learned)));
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const learning=page.locator('section').filter({has:page.getByText('Learn from choices',{exact:true})});
 await learning.getByTitle('Keep current guidance without learning',{exact:true}).click();
 await until(async()=>!(await api('/api/recommendation-learning')).enabled);
 await page.keyboard.press('Escape');
 const before=reflections.length;await send(agent,'Compare against the previous measurements');await suggestions(agent);await pause(200);assert.equal(reflections.length,before);
 await page.getByRole('button',{name:'Settings',exact:true}).click();if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await page.close();daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));daemon=start();
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 const restored=await api('/api/recommendation-learning');assert.equal(restored.enabled,false);assert.equal(restored.nextActions.guidance,learned);
 console.log('Presented alternatives learn once; unseen, silent, disabled and duplicate choices do not retrain; guidance affects later predictions and persists independently across restart.');
}finally{
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 for(const client of rpc.clients)client.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>rpcHttp.close(done));await rm(root,{recursive:true,force:true});
}
