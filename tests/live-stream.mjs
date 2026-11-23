// A message recorded by another client appears in an open conversation with no input in the tab.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer,request} from 'node:http';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {baseEnv} from './daemon-env.mjs';
assert.ok(process.env.TEST_URL&&process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'),{recursive:true});const root=await mkdtemp(resolve('.tmp/live-stream-'));
const listen=s=>new Promise(done=>s.listen(0,'127.0.0.1',()=>done(s.address().port)));
const reserve=createServer(),port=await listen(reserve);await new Promise(done=>reserve.close(done));
const native=`http://127.0.0.1:${port}`,config=join(root,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(root,'test.sqlite3'))}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const daemon=spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{...baseEnv,OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:'ws://127.0.0.1:9',OXROUTE_CODEX_CLI:'/bin/false'}});
const api=async(path,body)=>{const r=await fetch(native+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,`${path}: ${await r.clone().text()}`);return r.json();};
const proxy=createServer((req,res)=>{const target=new URL(req.url,req.url.startsWith('/api/')&&!req.url.startsWith('/api/version')?native:process.env.TEST_URL);const up=request(target,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});up.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(up);res.on('close',()=>up.destroy());});
const base=`http://127.0.0.1:${await listen(proxy)}`;
let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch(native+'/api/health')).ok)break;}catch{}await new Promise(done=>setTimeout(done,100));}
 const agent=await api('/api/agents',{id:`agent_${crypto.randomUUID().replaceAll('-','')}`});
 browser=await(process.env.BROWSER==='webkit'?(await import('playwright')).webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage({viewport:{width:1280,height:850}});
 await page.goto(`${base}/?agent=${agent.id}`);
 await page.waitForTimeout(2000);
 const text=`Streamed ${crypto.randomUUID()}`;
 await api('/api/say',{agent:agent.id,text,queued:true});
 await page.getByText(text,{exact:false}).first().waitFor({timeout:8000});
 console.log('A message recorded elsewhere appears in the open conversation without any input.');
}finally{
 await browser?.close();proxy.closeAllConnections();await new Promise(done=>proxy.close(done));
 daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));await rm(root,{recursive:true,force:true});
}
