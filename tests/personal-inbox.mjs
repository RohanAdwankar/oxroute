// Production UI + disposable daemon + local Codex JSON-RPC transport.
// No inference credentials or shared services are used.
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {chromium,webkit} from 'playwright';
const {WebSocketServer}=createRequire(import.meta.url)('next/dist/compiled/ws');
assert.ok(process.env.TEST_DAEMON,'TEST_DAEMON must name the reviewed daemon');
await mkdir(resolve('.tmp'),{recursive:true});
const root=await mkdtemp(resolve('.tmp/personal-inbox-'));
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const rpcHttp=createServer(),rpc=new WebSocketServer({server:rpcHttp}),rpcPort=await listen(rpcHttp);
const actions=[{label:'Apply changes',message:'Apply the proposed changes after checking the current configuration'},
 {label:'Explain findings',message:'Explain how you verified these findings'},
 {label:'Check alternatives',message:'Compare the available alternatives'}];
let next=0;const delivered=new Map();
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);
 if(id===undefined)return;
 let result={};
 if(method==='thread/start') result={thread:{id:`thread-${++next}`}};
 if(method==='thread/resume') result={thread:{id:params.threadId}};
 if(method==='turn/start') {
  delivered.set(params.threadId,[...(delivered.get(params.threadId)??[]),params]);
  const turn={id:`turn-${++next}`,status:'completed'};result={turn};
  const prediction=!!params.outputSchema?.properties?.actions;
  const learning=!!params.outputSchema?.properties?.guidance;
  const routing=!!params.outputSchema?.properties?.agentIds;
  const text=learning?JSON.stringify({guidance:'Prefer context relevant to ongoing work'}):routing?JSON.stringify({action:'spawn',agentIds:[],reason:'A new agent can review this context'}):prediction?JSON.stringify({actions,automatic:null}):params.outputSchema?JSON.stringify({title:'Configuration review'}):'The configuration check is complete.';
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
const legacy=join(root,'legacy.sqlite3');
execFileSync('uv',['run','--no-project','python','-c','import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript("CREATE TABLE threads(slack_user TEXT,channel TEXT,root_ts TEXT,codex_thread_id TEXT); CREATE TABLE pending_context(thread_id TEXT,message_ts TEXT,question TEXT,answer TEXT); CREATE TABLE dashboard(singleton INTEGER,channel TEXT,message_ts TEXT);"); c.close()',legacy]);
const start=()=>spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{...process.env,CODEX_SLACK_DATABASE:legacy,CODEX_HOME:join(root,'codex'),OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:`ws://127.0.0.1:${rpcPort}`,OXROUTE_CODEX_CLI:'/bin/false'}});
let daemon=start();
const frontend=process.env.TEST_URL??'http://127.0.0.1:14039';
const proxy=createServer((req,res)=>{
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
 await api('/api/automatic-titles',{enabled:false});await api('/api/next-action-suggestions',{enabled:false});
 await api('/api/mode',{mode:'auto'});await api('/api/next-action-mode',{mode:'ask'});
 for(const source of ['outlook-inbox','slack-inbox']) {
  await api('/api/signal',{source,conversation:source,threadKey:'ongoing',label:source==='outlook-inbox'?'Capacity report':'Project discussion',text:'Review the current observations'});
  await api('/api/signal',{source,conversation:source,threadKey:'ongoing',text:'Additional measurements are available'});
 }
 await until(async()=>(await api('/api/state')).inbox.every(item=>item.recommendation));
 let state=await api('/api/state');assert.equal(state.inbox.length,2);assert.equal(state.agents.length,0);assert.ok(state.inbox.every(item=>item.state==='waiting'));
 browser=await (process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
 // Source HTTP and Socket Mode transports are exercised by the Rust runtime test.
 // Inspect status and source links in the production UI with synthetic account data.
 await page.route('**/api/state',async route=>{const response=await route.fetch();const state=await response.json();state.inboxConnectors=['outlook-inbox','slack-inbox'].map(source=>({source,configured:true,lastSync:Date.now()/1000,error:null}));state.inbox=state.inbox.map(item=>({...item,sourceUrl:'https://example.test/original'}));await route.fulfill({response,json:state});});
 await page.goto(ui);await until(async()=>await page.locator('[data-inbox-item]').count()===2);
 await page.locator('[data-inbox-item]').first().click();await page.getByLabel('Suggested route',{exact:true}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Open source message'}).getAttribute('href'),'https://example.test/original');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 assert.equal((await api('/api/state')).agents.length,0,'Viewing advice does not start work');
 await page.getByRole('button',{name:'start a new agent',exact:true}).click();
 await until(async()=>(await api('/api/state')).agents.length===1);
 await until(async()=>(await api('/api/state')).inbox.filter(item=>item.state==='waiting').length===1);
 const agent=(await api('/api/state')).agents[0];await until(async()=>(await api(`/api/agents/${agent.id}`)).agent.status==='complete');
 await page.locator('[data-inbox-item]').first().click();await page.getByRole('button',{name:'discard',exact:true}).click();
 await until(async()=>(await api('/api/state')).inbox.every(item=>item.state==='done'));
 assert.equal((await api('/api/state')).agents.length,1,'Discarding does not start another agent');assert.deepEqual(errors,[]);
 const recipients=await Promise.all([api('/api/agents',{}),api('/api/agents',{})]);
 for(const source of ['outlook-inbox','slack-inbox']) {
  const text=`Additional context for both reviewers from ${source}`;
  const item=await api('/api/signal',{source,conversation:'shared-review',threadKey:source,text});
  await api('/api/route',{signal:item.signal,action:'existing',agentIds:recipients.map(agent=>agent.id)});
  await until(async()=>{const views=await Promise.all(recipients.map(agent=>api(`/api/agents/${agent.id}`)));return views.every(view=>view.agent.status==='complete'&&JSON.stringify(delivered.get(view.agent.sessionId)??[]).includes(text));});
 }
 assert.equal((await api('/api/state')).agents.length,3,'Manual fan-out retains both destinations without duplicating agents');
 console.log('Personal threads group in the Inbox; advice waits even in auto mode; source links, explicit new-agent routing and local dismissal work.');
}finally{
 for(const context of browser?.contexts()??[])for(const page of context.pages())await page.unrouteAll({behavior:"wait"});
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 for(const client of rpc.clients)client.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>rpcHttp.close(done));await rm(root,{recursive:true,force:true});
}
