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
let next=0, models=[], metadataCalls=0, held=[], hold=false;
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);
 if(id===undefined)return;
 let result={};
 if(method==='thread/start'){models.push(params.model);result={thread:{id:`thread-${++next}`}};}
 if(method==='thread/resume')result={thread:{id:params.threadId}};
 if(method==='turn/start'){
  const turn={id:`turn-${++next}`,status:'completed'};result={turn};
  const properties=params.outputSchema?.properties;
  const text=properties?.title?JSON.stringify({title:'Inspect database health'}):properties?.tags?JSON.stringify({tags:['databases','monitoring']}):'The requested check is complete.';
  const complete=()=>{for(const [method,extra] of [['turn/started',{turn}],['item/completed',{item:{id:`item-${turn.id}`,type:'agentMessage',text,phase:'final_answer'}}],['turn/completed',{turn}]])if(socket.readyState===1)socket.send(JSON.stringify({method,params:{threadId:params.threadId,...extra}}));};
  if(properties)metadataCalls++;
  if(properties&&hold)held.push(complete);else setTimeout(complete,20);
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
 await api('/api/next-action-suggestions',{enabled:false});
 const state=await api('/api/state');assert.equal(state.automaticTitles,true);assert.equal(state.automaticTags,false);
 browser=await (process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage({viewport:{width:1100,height:1000}});await page.goto(ui);
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 const title=page.locator('section').filter({has:page.getByText('Automatic card titles',{exact:true})});
 const tags=page.locator('section').filter({has:page.getByText('Automatic card tags',{exact:true})});
 await tags.getByTitle('Tag cards automatically',{exact:true}).click();
 await title.getByTitle('Keep titles as they are',{exact:true}).click();
 await until(async()=>{const s=await api('/api/state');return s.automaticTags&&!s.automaticTitles;});
 await until(async()=>await title.getByTitle('Keep titles as they are',{exact:true}).getAttribute('aria-pressed')==='true');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await page.keyboard.press('Escape');
 const say=agent=>api('/api/say',{agent:agent.id,text:'Inspect the database health and monitoring configuration',requestId:crypto.randomUUID()});
 const first=await api('/api/agents',{});await api(`/api/agents/${first.id}/tags`,{add:['priority:p1','my-topic']});await api('/api/rename',{agent:first.id,name:'My database card'});await say(first);
 await until(async()=>(await api(`/api/agents/${first.id}/tags`)).includes('databases'));
 assert.deepEqual(await api(`/api/agents/${first.id}/tags`),['databases','monitoring','my-topic','priority:p1']);
 assert.equal((await api(`/api/agents/${first.id}`)).agent.name,'My database card');
 await api(`/api/agents/${first.id}/tags`,{remove:['databases']});await say(first);
 await until(async()=>(await api(`/api/agents/${first.id}`)).agent.status==='complete');await pause(250);
 assert.ok(!(await api(`/api/agents/${first.id}/tags`)).includes('databases'),'Explicitly removed topic stays removed');
 await api('/api/automatic-titles',{enabled:true});await api('/api/automatic-tags',{enabled:false});
 const second=await api('/api/agents',{});await say(second);
 await until(async()=>(await api(`/api/agents/${second.id}`)).agent.name==='Inspect database health');
 assert.deepEqual(await api(`/api/agents/${second.id}/tags`),[]);
 assert.ok(models.includes('gpt-6-luna'),'Metadata selects Luna independently of the conversation model');
 hold=true;const third=await api('/api/agents',{});await say(third);await until(()=>held.length>0);
 await api('/api/rename',{agent:third.id,name:'Chosen while prediction runs'});hold=false;held.splice(0).forEach(f=>f());await pause(300);
 assert.equal((await api(`/api/agents/${third.id}`)).agent.name,'Chosen while prediction runs');
 const nativeSession=(await api(`/api/agents/${third.id}`)).agent.sessionId;
 for(const client of rpc.clients)client.send(JSON.stringify({method:'thread/name/updated',params:{threadId:nativeSession,threadName:'A late native title'}}));
 await pause(100);assert.equal((await api(`/api/agents/${third.id}`)).agent.name,'Chosen while prediction runs');
 hold=true;const fourth=await api('/api/agents',{});await say(fourth);await until(()=>held.length>0);
 await api('/api/automatic-titles',{enabled:false});hold=false;held.splice(0).forEach(f=>f());await pause(300);
 assert.equal((await api(`/api/agents/${fourth.id}`)).agent.name,'New agent','Disabling titles rejects pending metadata');
 const before=metadataCalls;await say(fourth);await pause(300);assert.equal(metadataCalls,before,'Both disabled settings avoid metadata inference');
 await api('/api/automatic-tags',{enabled:true});hold=true;
 const fifth=await api('/api/agents',{});await say(fifth);await until(()=>held.length>0);
 await api(`/api/agents/${fifth.id}/tags`,{remove:['databases']});await api('/api/automatic-tags',{enabled:false});
 hold=false;held.splice(0).forEach(f=>f());await pause(300);assert.deepEqual(await api(`/api/agents/${fifth.id}/tags`),[],'Disabling tags rejects pending metadata');
 await api('/api/automatic-tags',{enabled:true});await say(fifth);await until(async()=>(await api(`/api/agents/${fifth.id}/tags`)).includes('monitoring'));
 assert.deepEqual(await api(`/api/agents/${fifth.id}/tags`),['monitoring'],'An explicit removal during prediction stays removed');
 await api('/api/automatic-tags',{enabled:false});
 await page.close();daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));daemon=start();
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 const restored=await api('/api/state');assert.equal(restored.automaticTitles,false);assert.equal(restored.automaticTags,false);
 await api('/api/automatic-titles',{enabled:true});await api('/api/automatic-tags',{enabled:true});await say(first);
 await until(async()=>(await api(`/api/agents/${first.id}`)).agent.status==='complete');await pause(300);
 assert.equal((await api(`/api/agents/${first.id}`)).agent.name,'My database card');assert.ok(!(await api(`/api/agents/${first.id}/tags`)).includes('databases'));
 console.log('Independent title/tag settings, Luna selection, manual title protection, pending-result cancellation, additive tags, explicit removals and restart persistence pass.');
}finally{
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));
 daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 for(const client of rpc.clients)client.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>rpcHttp.close(done));
 await rm(root,{recursive:true,force:true});
}
