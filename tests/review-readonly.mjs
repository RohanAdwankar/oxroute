// Real Git and HTTP reads must never create work, even for stale saved cards.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
const {WebSocketServer}=createRequire(import.meta.url)('next/dist/compiled/ws');
assert.ok(process.env.TEST_DAEMON);
await mkdir('.tmp',{recursive:true});
const root=await mkdtemp(resolve('.tmp/review-readonly-')),repo=join(root,'source');await mkdir(repo);
const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('remote','add','origin','https://example.invalid/source.git');
await writeFile(join(repo,'settings.txt'),'initial\n');git('add','.');git('commit','-m','Initial settings');git('switch','-c','proposal');
await writeFile(join(repo,'settings.txt'),'prepared\n');git('commit','-am','Prepared settings');
const listen=server=>new Promise(done=>server.listen(0,'127.0.0.1',()=>done(server.address().port)));
const server=createServer(),rpc=new WebSocketServer({server}),rpcPort=await listen(server);let starts=0;
rpc.on('connection',socket=>socket.on('message',raw=>{const {id,method}=JSON.parse(raw);if(id===undefined)return;if(method==='turn/start')starts++;socket.send(JSON.stringify({id,result:method.startsWith('thread/')?{thread:{id:'fixture-session'}}:method==='turn/start'?{turn:{id:'fixture-turn'}}:{}}));}));
const reserve=createServer(),port=await listen(reserve);await new Promise(done=>reserve.close(done));
const api=`http://127.0.0.1:${port}`,config=join(root,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(root,'state.sqlite3'))}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const daemon=spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:`ws://127.0.0.1:${rpcPort}`,OXROUTE_CODEX_CLI:'/bin/false'}});
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const get=async path=>{const r=await fetch(api+path);assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
const post=async(path,body)=>{const r=await fetch(api+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
try {
 for(let n=0;n<100;n++){try{if((await fetch(api+'/api/health')).ok)break;}catch{}await pause(100);}
 for(const feature of ['automatic-titles','automatic-tags','recommendation-learning','next-action-suggestions'])await post(`/api/${feature}`,{enabled:false});
 const agent=await post('/api/agents',{}),path=`/api/agents/${agent.id}`;
 const review=await post(path+'/reviews',{repository:repo,base:'main',remote:'origin',title:'Prepared settings',description:'Inspect this saved change.'}),endpoint=path+'/reviews/'+review.id;
 await writeFile(join(repo,'settings.txt'),'uncommitted change\n');
 const before=await get(path);
 for(const response of await Promise.all([get(endpoint),get(endpoint+'?full=true'),get(endpoint)]))assert.equal(response.status,'stale');
 await pause(500);
 assert.equal(starts,0,'Reading a stale review never starts a turn');
 assert.deepEqual((await get(path)).timeline,before.timeline,'Reads preserve conversation history');
 await rm(repo,{recursive:true});
 assert.equal((await fetch(api+endpoint)).ok,false);
 await pause(250);assert.equal(starts,0,'Failed reads never start a turn');
 assert.deepEqual((await get(path)).timeline,before.timeline);
 console.log('Concurrent stale and failed review reads preserve history and start no agent work.');
}finally{daemon.kill('SIGTERM');for(const socket of rpc.clients)socket.terminate();rpc.close();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});}
