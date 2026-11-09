// Exercise direct edits against real Git, the daemon, and the production UI.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer} from 'node:net';
import {chromium} from 'playwright';
assert.ok(process.env.TEST_URL && process.env.TEST_DAEMON);
await mkdir(resolve('.tmp'),{recursive:true});
const root=await mkdtemp(resolve('.tmp/review-edit-')),repo=join(root,'source');await mkdir(repo);
const socket=createServer();await new Promise(done=>socket.listen(0,'127.0.0.1',done));const port=socket.address().port;await new Promise(done=>socket.close(done));
const api=`http://127.0.0.1:${port}`,config=join(root,'config.toml');
await writeFile(config,`owner="fixture"\nlisten="127.0.0.1:${port}"\nworkspace=${JSON.stringify(root)}\n[limits]\nmin_free_bytes=0\n[paths]\ndatabase=${JSON.stringify(join(root,'state.sqlite3'))}\nartifacts=${JSON.stringify(join(root,'artifacts'))}\nattachments=${JSON.stringify(join(root,'attachments'))}\n`);
const daemon=spawn(process.env.TEST_DAEMON,[],{stdio:['ignore','ignore','inherit'],env:{...process.env,OXROUTE_CONFIG:config,OXROUTE_CODEX_URL:'ws://127.0.0.1:9',OXROUTE_CODEX_CLI:'/bin/false'}});
let browser;
try {
 for(let n=0;n<100;n++){try{if((await fetch(api+'/api/health')).ok)break;}catch{}await new Promise(done=>setTimeout(done,100));}
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.name','Reviewer');git('config','user.email','review@example.invalid');git('remote','add','origin','https://example.invalid/repo.git');
 const path='settings λ.txt';await writeFile(join(repo,path),'initial\n');await writeFile(join(repo,'untouched.txt'),'keep\n');git('add','.');git('commit','-m','Base');git('checkout','-b','proposal');
 const proposed='  proposal λ  \r\nsecond line\r\n';await writeFile(join(repo,path),proposed);await writeFile(join(repo,'binary.bin'),Buffer.from([0,1,2]));await symlink('untouched.txt',join(repo,'link.txt'));git('add','.');git('commit','-m','Proposal');const originalHead=git('rev-parse','HEAD');
 const request=async(path,body)=>fetch(api+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const post=async(path,body)=>{const r=await request(path,body);assert.ok(r.ok,await r.clone().text());return r.json();};
 const agent=await post('/api/agents',{}),review=await post(`/api/agents/${agent.id}/reviews`,{repository:repo,base:'main',remote:'origin',title:'Adjust service settings',description:'Review the proposed service configuration.'});
 const endpoint=`/api/agents/${agent.id}/reviews/${review.id}`;
 const read=path=>fetch(api+endpoint+'/edit?'+new URLSearchParams({path}));
 assert.equal((await (await read(path)).json()).text,proposed,'Editor preserves exact bytes and newlines');
 for(const invalid of ['../outside','untouched.txt','binary.bin','link.txt']) {assert.ok(!(await read(invalid)).ok);assert.ok(!(await request(endpoint+'/edit',{path:invalid,text:'changed',headCommit:originalHead})).ok);}
 assert.ok(!(await fetch(api+endpoint.replace(agent.id,'other')+'/edit?'+new URLSearchParams({path}))).ok);
 assert.ok(!(await request(endpoint+'/edit',{path,text:'changed',headCommit:'0'.repeat(40)})).ok);
 await writeFile(join(repo,path),'Concurrent agent draft\n');await writeFile(join(repo,'untouched.txt'),'Unrelated staged work\n');git('add','untouched.txt');const before=git('status','--porcelain');
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1280,height:850}});
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 let transient=true;
 await page.route('**/api/**',async route=>{
  const r=route.request(),url=new URL(r.url());
  if(url.pathname==='/api/version')return route.continue();
  if(url.pathname==='/api/state')return route.fulfill({json:{mode:'ask',agents:[agent],archived:[],tasks:[],taskNotes:[],messages:{},tags:{},paneLinks:{},inbox:[],boards:[],sources:[],models:[],backends:[]}});
  if(url.pathname==='/api/terminals')return route.fulfill({json:[]});
  // Avoid stale-notification inference: the original snapshot remains immutable and readable.
  if(url.pathname===endpoint)return route.fulfill({json:review});
  if(url.pathname===endpoint+'/edit'&&r.method()==='POST'&&transient){transient=false;return route.fulfill({status:503,json:{error:'Temporary save failure'}});}
  return route.fulfill({response:await route.fetch({url:api+url.pathname+url.search})});
 });
 await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}&review=${review.id}`);
 await page.getByRole('button',{name:`Edit ${path}`,exact:true}).click();
 const editor=page.getByRole('textbox',{name:`File contents ${path}`,exact:true});
 await editor.waitFor();const revised='reviewer revision λ\nsecond line\n';await editor.fill(revised);
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await page.getByRole('button',{name:'Save revision',exact:true}).click();await page.getByRole('alert').filter({hasText:'Temporary save failure'}).waitFor();assert.equal(await editor.inputValue(),revised);
 const saved=page.waitForResponse(r=>r.url().endsWith(endpoint+'/edit')&&r.request().method()==='POST'&&r.ok());await page.getByRole('button',{name:'Save revision',exact:true}).click();const next=await (await saved).json();
 await page.getByRole('dialog',{name:`Edit ${path}`,exact:true}).waitFor({state:'detached'});
 await page.locator('[data-diff-line]').filter({hasText:'+reviewer revision λ'}).waitFor();
 assert.notEqual(next.id,review.id);assert.equal(next.status,'pending');assert.equal(next.approvedAt,null);assert.equal(next.snapshot.baseCommit,review.snapshot.baseCommit);assert.equal(next.snapshot.remoteUrl,review.snapshot.remoteUrl);
 assert.equal(await readFile(join(next.snapshot.repository,path),'utf8'),revised);
 assert.equal(execFileSync('git',['-C',next.snapshot.repository,'show','HEAD:untouched.txt'],{encoding:'utf8'}),'keep\n');
 assert.equal(git('rev-parse','HEAD'),originalHead);assert.equal(git('status','--porcelain'),before);assert.equal(await readFile(join(repo,path),'utf8'),'Concurrent agent draft\n');
 assert.equal((await (await read(path)).json()).text,proposed,'Original review stays pinned');
 if(process.env.RESULT_SCREENSHOT)await page.screenshot({path:process.env.RESULT_SCREENSHOT});
 console.log('Direct review editing creates an unapproved committed revision, renders its diff, preserves pinned originals and concurrent staged/unstaged work, rejects out-of-review/binary/symlink paths, and retains edits on failure.');
} finally {
 if(browser)await browser.close();daemon.kill('SIGTERM');await new Promise(done=>daemon.exitCode!==null?done():daemon.once('exit',done));await rm(root,{recursive:true,force:true});
}
