// Production UI + disposable daemon + local Codex JSON-RPC transport.
// No inference credentials or shared services are used.
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
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
let next=0,predictions=0,turns=[],automatic=null,failSend=false;
rpc.on('connection',socket=>socket.on('message',raw=>{
 const {id,method,params={}}=JSON.parse(raw);
 if(id===undefined)return;
 let result={};
 if(method==='thread/start') result={thread:{id:`thread-${++next}`}};
 if(method==='thread/resume') result={thread:{id:params.threadId}};
 if(method==='turn/start') {
  const turn={id:`turn-${++next}`,status:'completed'};result={turn};
  const prediction=!!params.outputSchema?.properties?.actions;
  const text=params.outputSchema?.properties?.guidance?JSON.stringify({guidance:'Keep useful replies grounded in the current work'}):prediction?JSON.stringify({actions,automatic}):params.outputSchema?JSON.stringify({title:'Configuration review'}):'The configuration check is complete.';
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
 await api('/api/mode',{mode:'ask'});
 const agent=await api('/api/agents',{});
 await api('/api/say',{agent:agent.id,text:'Inspect the current configuration',requestId:crypto.randomUUID()});
 await until(async()=>(await api(`/api/agents/${agent.id}`)).nextActions?.actions.length===3);
 const detail=await api(`/api/agents/${agent.id}`);assert.equal(detail.timeline.at(-1).text,'The configuration check is complete.');assert.equal(turns.length,1);
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`${ui}/?agent=${agent.id}`);
 const suggestions=page.getByRole('group',{name:'Suggested next steps'});
 await suggestions.waitFor();assert.equal(await suggestions.getByRole('button').count(),3);
 const firstChoice=suggestions.getByRole('button').first();
 assert.ok((await firstChoice.boundingBox()).height<40,'Suggestions default to subtle inline choices');
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByTitle('Large choices with descriptions',{exact:true}).click();await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.documentElement.dataset.nextActionLayout==='stacked');
 assert.ok((await firstChoice.boundingBox()).height>=96,'Stacked layout remains available');
 if(process.env.STACKED_SCREENSHOT)await page.screenshot({path:process.env.STACKED_SCREENSHOT});
 await page.reload();await suggestions.waitFor();assert.ok((await firstChoice.boundingBox()).height>=96,'Layout persists across reload');
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByTitle('Small inline suggestions',{exact:true}).click();await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.documentElement.dataset.nextActionLayout==='subtle');
 const settings = await api('/api/state'); assert.equal(settings.mode,'ask'); assert.equal(settings.nextActionMode,'ask'); assert.equal(settings.nextActionSuggestions,true);
 const options=page.getByRole('button',{name:'Continue next actions automatically options',exact:true});
 await options.click();const suggestOption=page.getByRole('menuitemcheckbox',{name:'Suggest next actions',exact:true});
 assert.equal(await suggestOption.getAttribute('aria-checked'),'true');await suggestOption.click();
 await until(async()=>(await api('/api/state')).nextActionSuggestions===false);
 await suggestions.waitFor({state:'detached'});assert.equal((await api(`/api/agents/${agent.id}`)).nextActions,null);
 await options.click();assert.equal(await suggestOption.getAttribute('aria-checked'),'false');await suggestOption.click();
 await suggestions.waitFor();assert.equal((await api('/api/state')).nextActionSuggestions,true);

 assert.equal(await suggestions.getByRole('button',{name:actions[0].label,exact:true}).getAttribute('title'),actions[0].message);
 await page.reload();await suggestions.waitFor();
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 const delivered=page.waitForResponse(r=>r.url().endsWith('/api/say')&&r.request().method()==='POST');
 await suggestions.getByRole('button',{name:actions[1].label,exact:true}).click();assert.equal((await delivered).request().postDataJSON().text,actions[1].message);
 await until(async()=>turns.length===2&&(await api(`/api/agents/${agent.id}`)).nextActions!==null);
 await page.reload();await suggestions.waitFor();failSend=true;
 await suggestions.getByRole('button',{name:actions[2].label,exact:true}).click();
 await until(async()=>(await page.locator('[data-composer]').inputValue())===actions[2].message);
 assert.equal(turns.length,2,'Failed click retains its message without starting a turn');
 await page.locator('[data-composer]').fill('My unsent draft');
 await page.reload();await suggestions.waitFor();
 const inputAuto=page.getByRole('button',{name:'Route inputs automatically',exact:true});
 const inputAsk=page.getByRole('button',{name:'Ask me before routing inputs',exact:true});
 const nextAuto=page.getByRole('button',{name:'Continue next actions automatically',exact:true});
 await inputAuto.click();await until(async()=>(await api('/api/state')).mode==='auto');
 assert.equal((await api('/api/state')).nextActionMode,'ask');
 automatic=0;await api('/api/say',{agent:agent.id,text:'Inspect the remaining settings',requestId:crypto.randomUUID()});
 await until(async()=>turns.length===3&&(await api(`/api/agents/${agent.id}`)).nextActions!==null);
 await pause(150);assert.equal(turns.length,3,'Automatic input routing does not enable automatic next actions');
 await nextAuto.click();await until(async()=>(await api('/api/state')).nextActionMode==='auto');
 assert.equal((await api('/api/state')).mode,'auto');
 await inputAsk.click();await until(async()=>(await api('/api/state')).mode==='ask');
 assert.equal((await api('/api/state')).nextActionMode,'auto');
 await page.reload();assert.equal(await nextAuto.getAttribute('aria-pressed'),'true');
 assert.equal(await inputAsk.getAttribute('aria-pressed'),'true');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 automatic=0;await api('/api/say',{agent:agent.id,text:'Apply the changes we agreed on',requestId:crypto.randomUUID()});
 await until(async()=>turns.length===5&&(await api(`/api/agents/${agent.id}`)).nextActions!==null);
 await pause(150);assert.equal(turns.length,5,'Automatic next actions continue with manual input routing, then accept a null selection and stop');
 assert.ok(turns[4].some(input=>input.text?.includes('not a new user request or approval')));
 await page.setViewportSize({width:420,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 await page.close();
 daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));daemon=start();
 await until(async()=>{try{return(await fetch(native+'/api/health')).ok;}catch{return false;}});
 const persisted=await api('/api/state');assert.equal(persisted.mode,'ask');assert.equal(persisted.nextActionMode,'auto');
 const restored=await browser.newPage();await restored.goto(`${ui}/?agent=${agent.id}`);
 await until(async()=>await restored.getByRole('button',{name:'Continue next actions automatically',exact:true}).getAttribute('aria-pressed')==='true');
 assert.equal(await restored.getByRole('button',{name:'Ask me before routing inputs',exact:true}).getAttribute('aria-pressed'),'true');
 console.log('Independent input and next-action modes cover all four combinations, persist through restart, retain suggestion buttons/retries, and continue only when next-action automation is enabled.');
}finally{
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));
 daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));
 for(const socket of rpc.clients)socket.terminate();await new Promise(done=>rpc.close(done));await new Promise(done=>rpcHttp.close(done));await rm(root,{recursive:true,force:true});
}
