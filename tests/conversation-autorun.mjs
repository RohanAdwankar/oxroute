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
const root=await mkdtemp(resolve('.tmp/conversation-autorun-'));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const rpcHttp=createServer(),rpc=new WebSocketServer({server:rpcHttp}),rpcPort=await listen(rpcHttp);
const actions=[{label:'Apply changes',message:'Apply the proposed changes after checking the current configuration'},
 {label:'Explain findings',message:'Explain how you verified these findings'},
 {label:'Check alternatives',message:'Compare the available alternatives'}];
let next=0,predictions=0,turns=[],automatic=null,failSend=false,holdTurns=false,holdPredictions=false,held=[],interrupts=0;
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);
 if(id===undefined)return;
 let result={};
 if(method==='turn/interrupt')interrupts++;
 if(method==='thread/start') result={thread:{id:`thread-${++next}`}};
 if(method==='thread/resume') result={thread:{id:params.threadId}};
 if(method==='turn/start') {
  const turn={id:`turn-${++next}`,status:'completed'};result={turn};
  const prediction=!!params.outputSchema?.properties?.actions;
  const text=params.outputSchema?.properties?.guidance?JSON.stringify({guidance:'Keep useful replies grounded in the current work'}):prediction?JSON.stringify({actions,automatic}):params.outputSchema?JSON.stringify({title:'Configuration review'}):'The configuration check is complete.';
  if(prediction){predictions++;automatic=null;}else if(!params.outputSchema)turns.push(params.input);
  const finish=()=>{
   for(const [method,extra] of [['turn/started',{turn}],['item/completed',{item:{id:`item-${next}`,type:'agentMessage',text,phase:'final_answer'}}],['turn/completed',{turn}]])
    if(socket.readyState===1)socket.send(JSON.stringify({method,params:{threadId:params.threadId,...extra}}));
  };
  if((prediction&&holdPredictions)||(!params.outputSchema&&holdTurns))held.push(finish);else setTimeout(finish,20);
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
 await api('/api/automatic-titles',{enabled:false});await api('/api/recommendation-learning',{enabled:false});
 await api('/api/mode',{mode:'ask'});await api('/api/next-action-mode',{mode:'ask'});
 const agent=await api('/api/agents',{}),other=await api('/api/agents',{});
 const detail=()=>api(`/api/agents/${agent.id}`);
 const send=()=>api('/api/say',{agent:agent.id,text:'Inspect the authorized configuration',requestId:crypto.randomUUID()});
 const suggestionsReady=()=>until(async()=>(await detail()).nextActions?.actions.length===3);
 await api(`/api/agents/${agent.id}/autorun`,{enabled:true});automatic=0;await send();
 await until(async()=>turns.length===2&&(await detail()).nextActions?.actions.length===3);
 browser=await (process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`${ui}/?agent=${agent.id}`);
 const toggle=page.getByRole('button',{name:'Conversation autorun',exact:true});
 const options=page.getByRole('button',{name:'Conversation autorun options',exact:true});
 const choices=page.getByRole('group',{name:'Suggested next steps'});
 await choices.waitFor();assert.equal(await toggle.getAttribute('aria-pressed'),'true');
 holdTurns=true;automatic=0;const beforeActive=turns.length;await send();
 await until(async()=>turns.length===beforeActive+1&&(await detail()).agent.status==='working');
 await toggle.click();await until(async()=>(await detail()).autorun===false);
 assert.equal((await detail()).agent.status,'working');assert.equal(interrupts,0);
 holdTurns=false;held.splice(0).forEach(finish=>finish());await suggestionsReady();
 assert.equal(turns.length,beforeActive+1,'Turning off during work permits completion but no automatic follow-up');
 await options.click();await page.getByRole('menuitemcheckbox',{name:'Autorun on',exact:true}).click();
 await until(async()=>(await detail()).autorun===true);
 holdPredictions=true;automatic=0;const beforePrediction=predictions,beforeTurn=turns.length;await send();
 await until(()=>predictions>beforePrediction);await page.locator('[data-composer]').fill('My unfinished draft');
 await toggle.click();await until(async()=>(await detail()).autorun===false);
 holdPredictions=false;held.splice(0).forEach(finish=>finish());await suggestionsReady();await choices.waitFor();
 assert.equal(turns.length,beforeTurn+1,'Turning off rejects a prediction that finishes later');
 assert.equal(await page.locator('[data-composer]').inputValue(),'My unfinished draft');assert.equal(interrupts,0);
 await api('/api/next-action-mode',{mode:'auto'});
 automatic=0;const beforeOther=turns.length;
 await api('/api/say',{agent:other.id,text:'Inspect the other authorized configuration',requestId:crypto.randomUUID()});
 await until(async()=>turns.length===beforeOther+2&&(await api(`/api/agents/${other.id}`)).nextActions?.actions.length===3);
 assert.equal((await detail()).autorun,false);assert.equal((await api(`/api/agents/${other.id}`)).autorun,null);
 const beforeClick=turns.length;await choices.getByRole('button',{name:actions[1].label,exact:true}).click();
 await until(async()=>turns.length===beforeClick+1&&(await detail()).nextActions?.actions.length===3);
 assert.equal((await api('/api/state')).nextActionSuggestions,true);
 await options.click();await page.getByRole('menuitemcheckbox',{name:'Use global setting',exact:true}).click();
 await until(async()=>(await detail()).autorun===null);
 await until(async()=>await toggle.getAttribute('aria-pressed')==='true');
 await api('/api/next-action-mode',{mode:'ask'});
 await until(async()=>await toggle.getAttribute('aria-pressed')==='false');
 await options.click();await page.getByRole('menuitemcheckbox',{name:'Autorun on',exact:true}).click();
 await until(async()=>(await detail()).autorun===true);
 await page.close();daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));daemon=start();
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 assert.equal((await detail()).autorun,true);assert.equal((await api('/api/state')).nextActionMode,'ask');
 const restored=await browser.newPage({viewport:{width:1280,height:900}});await restored.goto(`${ui}/?agent=${agent.id}`);
 await until(async()=>await restored.getByRole('button',{name:'Conversation autorun',exact:true}).getAttribute('aria-pressed')==='true');
 await restored.getByRole('button',{name:'Conversation autorun options',exact:true}).click();
 assert.equal(await restored.getByRole('menuitemcheckbox',{name:'Autorun on',exact:true}).getAttribute('aria-checked'),'true');
 if(process.env.SCREENSHOT)await restored.screenshot({path:process.env.SCREENSHOT});
 assert.deepEqual(errors,[]);
 console.log('Conversation overrides isolate automatic next actions, persist through restart, follow global settings when reset, retain suggestions/drafts/manual clicks, and never interrupt active work.');
}finally{
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));
 daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 for(const socket of rpc.clients)socket.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>rpcHttp.close(done));await rm(root,{recursive:true,force:true});
}
