// Run only against an isolated native daemon; the fixture invokes no inference.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {chromium,webkit} from 'playwright';
assert.ok(process.env.TEST_URL&&process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'),{recursive:true});const workspace=await mkdtemp(resolve('.tmp/review-context-'));
const reserve=createServer();await new Promise(done=>reserve.listen(0,'127.0.0.1',done));const port=reserve.address().port;await new Promise(done=>reserve.close(done));
const api=`http://127.0.0.1:${port}`,web=process.env.TEST_URL,config=join(workspace,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(workspace)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(workspace,'state.sqlite3'))}\nartifacts=${JSON.stringify(join(workspace,'artifacts'))}\nattachments=${JSON.stringify(join(workspace,'attachments'))}\n`);
const daemon=spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{...process.env,OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:'ws://127.0.0.1:9',OXROUTE_CODEX_CLI:'/bin/false'}});
let browser;
try {
for(let n=0;n<100;n++){try{if((await fetch(api+'/api/health')).ok)break;}catch{}await new Promise(done=>setTimeout(done,100));}
const repo=await mkdtemp(join(workspace,'context-'));
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('remote','add','origin','https://example.invalid/repo.git');
const path='settings λ.ts',source=Array.from({length:120},(_,i)=>`const setting${i+1} = ${i+1};`);
await writeFile(join(repo,path),source.join('\n')+'\n');git('add','.');git('commit','-m','Base');git('checkout','-b','proposal');
const changed=[...source];changed[34]='const setting35 = 3500;';changed.splice(35,0,'const extra = true;');changed[85]='const setting85 = 8500;';
await writeFile(join(repo,path),changed.join('\n')+'\n');git('commit','-am','Change');
const post=async(path,body)=>{const r=await fetch(api+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
const agent=await post('/api/agents',{}),review=await post(`/api/agents/${agent.id}/reviews`,{repository:repo,base:'main',remote:'origin',title:'Review with surrounding context',description:''});
await writeFile(join(repo,path),'Uncommitted replacement, never show this as review context.\n');
const endpoint=`/api/agents/${agent.id}/reviews/${review.id}`;
assert.equal((await fetch(api+endpoint.replace(agent.id,'unrelated-agent')+'/context?'+new URLSearchParams({path,side:'after',start:'1',count:'20'}))).ok,false);
browser=await (process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};localStorage.setItem('oxroute.theme','dark');});
 let fail=true,requests=0,gate=null;
 await page.route('**/api/**',async route=>{
  const r=route.request(),url=new URL(r.url());
  if(url.pathname==='/api/version')return route.continue();
  if(url.pathname==='/api/state')return route.fulfill({json:{mode:'ask',agents:[agent],archived:[],tasks:[],taskNotes:[],messages:{},tags:{},paneLinks:{},inbox:[],boards:[],sources:[],models:[],backends:[]}});
  if(url.pathname==='/api/terminals')return route.fulfill({json:[]});
  if(url.pathname===endpoint)return route.fulfill({json:review});
  if(url.pathname.endsWith('/context')){requests++;if(fail)return route.fulfill({status:503,json:{error:'Context temporarily unavailable'}});if(gate)await gate;}
  return route.fulfill({response:await page.request.get(api+url.pathname+url.search)});
 });
 await page.goto(`${web}/?agent=${agent.id}`);
 await page.getByRole('button',{name:`Review ${review.title}`,exact:true}).click();
 const pane=page.getByRole('region',{name:'Change review',exact:true});
 const section=pane.getByRole('region',{name:`Diff ${path}`,exact:true});
 const up=section.getByRole('button',{name:'Expand up',exact:true});
 assert.ok(await up.count()>0,'Unchanged lines before a hunk can expand upward');
 const expand=section.getByRole('button',{name:'Expand down',exact:true});
 assert.equal(requests,0,'Opening a diff does not preload the rest of its files');
 assert.equal(await expand.count(),2,'Each hunk can expand down');
 const content=section.locator('[data-diff-line]');
 const initial=(await content.locator(':scope > span:first-child').allTextContents()).filter(Boolean).map(Number);
 await up.first().click();await section.getByRole('alert').waitFor();
 fail=false;
 const click=async button=>{
  const before=await content.count();
  const returned=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/context')&&r.ok());
  await button.click();await returned;await page.waitForFunction(before=>document.querySelectorAll('[data-diff-line]').length>before,before);
 };
 await click(section.getByRole('button',{name:'Retry expansion',exact:true}));
 const after=(await content.locator(':scope > span:first-child').allTextContents()).filter(Boolean).map(Number);
 assert.ok(Math.min(...after)<Math.min(...initial),'Upward expansion prepends earlier unchanged lines');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 let release;gate=new Promise(done=>{release=done;});
 const reading=click(expand.first());
 await page.waitForFunction(()=>document.querySelector('[aria-label="Expand down"][disabled]'));
 assert.equal(await up.last().isDisabled(),true,'Both ends of one gap share the pending read');
 release();gate=null;await reading;
 let turn=0;
 while(await up.count()||await expand.count()){
  await click(await up.count()&&(turn++%2===0||!await expand.count())?up.last():expand.first());
 }
 const gutters=await content.locator(':scope > span:first-child').allTextContents();
 assert.deepEqual(gutters.filter(Boolean).map(Number),Array.from({length:120},(_,i)=>i+1),'Expansion covers pinned lines in order without duplicates and stops at BOF/EOF');
 const added=content.filter({hasText:'const setting58 = 58;'});
 assert.equal(await added.locator('span').nth(0).innerText(),'58');
 assert.equal(await added.locator('span').nth(1).innerText(),'59','Inserted lines preserve both gutters');
 assert.equal(await section.getByText('Uncommitted replacement, never show this as review context.',{exact:false}).count(),0);
 await added.click({button:'right'});await page.getByRole('button',{name:'Quote diff into chat',exact:true}).click();
 await page.getByRole('region',{name:`Attached diff ${path}`,exact:true}).waitFor();
 console.log('Up/down context expansion, shared gap boundaries, BOF/EOF, exact gutters, pinned content, retry and quoting pass.');
}finally{await browser?.close();daemon.kill('SIGTERM');if(daemon.exitCode===null)await new Promise(done=>daemon.once('exit',done));await rm(workspace,{recursive:true,force:true});}
