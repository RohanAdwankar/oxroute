import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createServer} from 'node:net';
assert.ok(process.env.TEST_DAEMON, 'Use a disposable reviewed daemon binary');
const root=await mkdtemp(resolve('.tmp/review-probe-'));await mkdir(join(root,'artifacts'));await mkdir(join(root,'bin'));
const gate=join(root,'hold'),entered=join(root,'entered');await writeFile(gate,'');
execFileSync('uv',['run','--no-project','--with','reportlab','python','-c',`from reportlab.pdfgen import canvas\nc=canvas.Canvas(${JSON.stringify(join(root,'artifacts/held.pdf'))});c.drawString(40,700,'Document preparation');c.save()`]);
await writeFile(join(root,'artifacts/image.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=','base64'));
const pdfinfo=execFileSync('which',['pdfinfo'],{encoding:'utf8'}).trim();
await writeFile(join(root,'bin/pdfinfo'),`#!/usr/bin/env node\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');fs.writeFileSync(${JSON.stringify(entered)},'');const wait=()=>{if(fs.existsSync(${JSON.stringify(gate)}))setTimeout(wait,20);else process.exit(spawnSync(${JSON.stringify(pdfinfo)},process.argv.slice(2),{stdio:'inherit'}).status??1)};wait();`,{mode:0o755});
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const config=join(root,'config.toml');await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(root,'test.sqlite3'))}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const daemon=spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{...process.env,OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:'ws://127.0.0.1:9',PATH:join(root,'bin')+':'+process.env.PATH}});
const base=`http://127.0.0.1:${port}`,pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body){const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();}
try{
for(let i=0;i<100;i++){try{await api('/api/health');break;}catch{await pause(100);}}
const agent=await api('/api/agents',{}),create=name=>api(`/api/agents/${agent.id}/file-reviews`,{path:join(root,'artifacts',name)});
const doc=create('held.pdf');for(let i=0;i<100;i++){try{await access(entered);break;}catch{await pause(50);}}
let ready=false,imageMs;const start=performance.now();const image=create('image.png').then(r=>{ready=true;imageMs=Math.round(performance.now()-start);return r;});await pause(1000);const waiting=!ready;await rm(gate);await Promise.all([doc,image]);
const timeline=(await api(`/api/agents/${agent.id}`)).timeline;
console.log(JSON.stringify({imageWaitedForDocument:waiting,imageMs,totalMs:Math.round(performance.now()-start),notices:timeline.filter(e=>e.kind==='notice').length}));
{assert.equal(waiting,false,'Image preview must not wait for unrelated document rendering');assert.equal(timeline.length,0,'Opening previews must not create conversation entries');const reviews=await Promise.all([create('image.png'),create('image.png')]);assert.equal(reviews[0].id,reviews[1].id);}
}finally{await rm(gate,{force:true});daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(r=>daemon.once('exit',r));await rm(root,{recursive:true,force:true});}
