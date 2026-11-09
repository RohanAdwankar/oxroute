import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createServer as httpServer,request} from 'node:http';
import {resolve,join} from 'node:path';
const web=process.env.TEST_URL;
assert.ok(web && process.env.TEST_DAEMON,'Set TEST_URL and TEST_DAEMON');
await mkdir(resolve('.tmp'),{recursive:true});
const root=await mkdtemp(resolve('.tmp/workstreams-'));
const socket=createServer();await new Promise(done=>socket.listen(0,'127.0.0.1',done));const port=socket.address().port;await new Promise(done=>socket.close(done));
const native=`http://127.0.0.1:${port}`,config=join(root,'config.toml');
await mkdir(join(root,'artifacts'));await mkdir(join(root,'attachments'));
await writeFile(config,`owner = "fixture"\nlisten = "127.0.0.1:${port}"\nworkspace = ${JSON.stringify(root)}\n[limits]\nmin_free_bytes = 0\n[paths]\ndatabase = ${JSON.stringify(join(root,'test.sqlite3'))}\nartifacts = ${JSON.stringify(join(root,'artifacts'))}\nattachments = ${JSON.stringify(join(root,'attachments'))}\n`);
let daemon;
async function stop(){if(daemon){daemon.kill('SIGTERM');await new Promise(done=>daemon.exitCode===null?daemon.once('exit',done):done());daemon=null;}}
async function start(){daemon=spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{...process.env,OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:'ws://127.0.0.1:9',OXROUTE_CODEX_CLI:'/bin/false'}});for(let i=0;i<100;i++){try{if((await fetch(`${native}/api/health`)).ok)return;}catch{}await new Promise(done=>setTimeout(done,100));}throw Error('Disposable daemon did not start');}
try{
await start();
assert.ok((await(await fetch(`${native}/api/state`)).json()).artifactRoot.includes('/.tmp/'),'Requires disposable runtime');
async function api(path,body,method='POST'){const r=await fetch(native+path,body===undefined?{}:{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();}
const agent=await api('/api/agents',{id:`agent_${crypto.randomUUID().replaceAll('-','')}`,name:'Partner launch'});
await api('/api/rename',{agent:agent.id,name:'Partner launch'});
const board=await api('/api/boards',{name:'Workstreams',columns:'workflow',columnOrder:['waiting','review'],selected:['workstream:launch']});
await api(`/api/agents/${agent.id}/tags`,{set:['workflow:waiting','workstream:launch']});
const brief={outcome:'Publish the product webpage and datasheet.',owner:'Content team',blocker:'Design team to supply the template.',nextAction:'Review the first draft when it arrives.',target:'Launch event · estimated milestone',estimateDays:3,stageStartedAt:Date.now()/1000-4*86400,followUpAt:Date.now()/1000-86400,sources:['https://example.com/launch-evidence']};
assert.deepEqual(await api(`/api/agents/${agent.id}/workstream`,brief,'PUT'),brief);
await stop();await start();
assert.deepEqual(await api(`/api/agents/${agent.id}/workstream`),brief,'Context survives a daemon restart');
assert.deepEqual((await api(`/api/boards/${board.id}`)).workstreams[agent.id],brief);
assert.ok(!(await fetch(`${native}/api/agents/${agent.id}/workstream`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...brief,estimateDays:-1})})).ok);
for(const patch of [{estimateDays:0},{stageStartedAt:-1},{followUpAt:-1},{sources:['javascript:alert(1)']}]){
 assert.ok(!(await fetch(`${native}/api/agents/${agent.id}/workstream`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...brief,...patch})})).ok);
}
const invalid=await fetch(`${native}/api/agents/${agent.id}/workstream`,{method:'PUT',headers:{'content-type':'application/json'},body:'{"estimateDays":1e999}'});assert.ok(!invalid.ok);
// Use real HTTP forwarding so reload/close can cancel requests normally.
// A delayed interception callback must never outlive its browser route.
const proxy=httpServer((incoming,outgoing)=>{
 const path=new URL(incoming.url,'http://fixture');
 const target=new URL(path.pathname+path.search,path.pathname.startsWith('/api/')&&path.pathname!='/api/version'?native:web);
 const upstream=request(target,{method:incoming.method,headers:{...incoming.headers,host:target.host}},reply=>{outgoing.writeHead(reply.statusCode,reply.headers);reply.pipe(outgoing);});
 upstream.on('error',()=>{if(!outgoing.destroyed){if(outgoing.headersSent)outgoing.destroy();else{outgoing.writeHead(502);outgoing.end();}}});
 outgoing.on('close',()=>upstream.destroy());incoming.pipe(upstream);
});
await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
const browser=await chromium.launch();
let page;
try{
 page=await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.goto(`http://127.0.0.1:${proxy.address().port}`);
 await page.getByRole('button',{name:'Show boards',exact:true}).click();
 await page.getByRole('combobox',{name:'Choose board',exact:true}).selectOption(board.id);
 const card=page.locator('article').filter({hasText:'Partner launch'});
 await card.getByText(brief.outcome,{exact:true}).waitFor();
 await card.getByText(/Stage estimate · 3 days.*overdue/).waitFor();
 await card.getByText(/Follow-up due/).waitFor();
 assert.equal(await card.getByRole('link',{name:'Source 1'}).getAttribute('href'),brief.sources[0]);
 await card.click({button:'right'});
 const dialog=page.getByRole('dialog');
 await dialog.waitFor();
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await dialog.getByLabel('Waiting on',{exact:true}).fill('Template arrived; author is drafting.');
 await dialog.getByLabel('Sources (one link per line)',{exact:true}).fill('javascript:invalid');
 await dialog.getByRole('button',{name:'Save',exact:true}).click();
 await dialog.getByRole('alert').waitFor();
 assert.equal(await dialog.getByLabel('Waiting on',{exact:true}).inputValue(),'Template arrived; author is drafting.','Failed save retains draft');
 await dialog.getByLabel('Sources (one link per line)',{exact:true}).fill(brief.sources.join('\n'));
 await dialog.getByRole('button',{name:'Save',exact:true}).click();
 await dialog.waitFor({state:'detached'});
 await card.getByText('Waiting · Template arrived; author is drafting.',{exact:true}).waitFor();
 await page.reload();
 await card.getByText('Waiting · Template arrived; author is drafting.',{exact:true}).waitFor();
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 const before=await api(`/api/agents/${agent.id}/workstream`);
 await api(`/api/boards/${board.id}/move`,{agent:agent.id,column:'review',row:null});
 const moved=await api(`/api/agents/${agent.id}/workstream`);
 assert.ok(moved.stageStartedAt>before.stageStartedAt,'A new workflow stage starts a fresh estimate');
 assert.deepEqual({...moved,stageStartedAt:before.stageStartedAt},before,'Moving preserves context and explicit checkpoint');
 await api(`/api/boards/${board.id}/move`,{agent:agent.id,column:'review',row:null});
 assert.deepEqual(await api(`/api/agents/${agent.id}/workstream`),moved,'Same-stage drops do not reset estimate');
 await api(`/api/agents/${agent.id}/tags`,{set:['workstream:another']});
 assert.deepEqual(await api(`/api/agents/${agent.id}/workstream`),moved,'Row changes do not reset stage estimate');
 const snapshot=await api('/api/state');assert.ok(snapshot.tags[agent.id].includes('workflow:review'));
 assert.deepEqual(errors,[]);
 console.log('Workstream cards persist context, edit in place, retain source links and flag elapsed estimates/checkpoints without changing tags or task states.');
}finally{await browser.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));}

}finally{await stop();await rm(root,{recursive:true,force:true});}
