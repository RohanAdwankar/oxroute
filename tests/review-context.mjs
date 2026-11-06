// Run only against an isolated native daemon; the fixture invokes no inference.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
const api=process.env.TEST_NATIVE_URL,web=process.env.TEST_URL,workspace=process.env.TEST_WORKSPACE;
assert.ok(api&&web&&workspace);
const repo=await mkdtemp(join(workspace,'context-'));
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('remote','add','origin','https://example.invalid/repo.git');
const path='settings λ.ts',source=Array.from({length:80},(_,i)=>`const setting${i+1} = ${i+1};`);
await writeFile(join(repo,path),source.join('\n')+'\n');git('add','.');git('commit','-m','Base');git('checkout','-b','proposal');
const changed=[...source];changed[4]='const setting5 = 500;';changed.splice(5,0,'const extra = true;');changed[45]='const setting45 = 4500;';
await writeFile(join(repo,path),changed.join('\n')+'\n');git('commit','-am','Change');
const post=async(path,body)=>{const r=await fetch(api+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
const agent=await post('/api/agents',{}),review=await post(`/api/agents/${agent.id}/reviews`,{repository:repo,base:'main',remote:'origin',title:'Review with surrounding context',description:''});
await writeFile(join(repo,path),'Uncommitted replacement, never show this as review context.\n');
const endpoint=`/api/agents/${agent.id}/reviews/${review.id}`;
assert.equal((await fetch(api+endpoint.replace(agent.id,'unrelated-agent')+'/context?'+new URLSearchParams({path,side:'after',start:'1',count:'20'}))).ok,false);
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};localStorage.setItem('oxroute.theme','dark');});
 let fail=true,requests=0;
 await page.route('**/api/**',async route=>{
  const r=route.request(),url=new URL(r.url());
  if(url.pathname==='/api/version')return route.continue();
  if(url.pathname==='/api/state')return route.fulfill({json:{mode:'ask',agents:[agent],archived:[],tasks:[],taskNotes:[],messages:{},tags:{},paneLinks:{},inbox:[],boards:[],sources:[],models:[],backends:[]}});
  if(url.pathname==='/api/terminals')return route.fulfill({json:[]});
  if(url.pathname===endpoint)return route.fulfill({json:review});
  if(url.pathname.endsWith('/context')){requests++;if(fail)return route.fulfill({status:503,json:{error:'Context temporarily unavailable'}});}
  return route.fulfill({response:await page.request.get(api+url.pathname+url.search)});
 });
 await page.goto(`${web}/?agent=${agent.id}`);
 await page.getByRole('button',{name:`Review ${review.title}`,exact:true}).click();
 const pane=page.getByRole('region',{name:'Change review',exact:true});
 const section=pane.getByRole('region',{name:`Diff ${path}`,exact:true});
 const expand=section.getByRole('button',{name:'↓ Expand down',exact:true});
 assert.equal(requests,0,'Opening a diff does not preload the rest of its files');
 assert.equal(await expand.count(),2,'Each hunk can expand down');
 await expand.first().click();await section.getByRole('alert').waitFor();
 fail=false;await section.getByRole('button',{name:'Retry expansion',exact:true}).click();
 const content=section.locator('[data-diff-line]');
 await content.filter({hasText:'const setting30 = 30;'}).waitFor();
 const added=content.filter({hasText:'const setting30 = 30;'});
 assert.equal(await added.locator('span').nth(0).innerText(),'30');
 assert.equal(await added.locator('span').nth(1).innerText(),'31','Inserted lines preserve both gutters');
 assert.equal(await section.getByText('Uncommitted replacement, never show this as review context.',{exact:false}).count(),0);
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await expand.first().click();await page.waitForFunction(()=>[...document.querySelectorAll('[data-diff-line]')].some(row=>row.textContent.includes('const setting39 = 39;')));
 assert.equal(await content.filter({hasText:'const setting40 = 40;'}).count(),1,'Expansion stops before the next hunk and never duplicates its lines');
 assert.equal(await expand.count(),1);
 while(await expand.count()){await expand.click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].some(b=>b.textContent==='Loading context…'));}
 await content.filter({hasText:'const setting80 = 80;'}).waitFor();
 assert.equal(await content.filter({hasText:'const setting80 = 80;'}).count(),1);
 await added.click({button:'right'});await page.getByRole('button',{name:'Quote diff into chat',exact:true}).click();
 await page.getByRole('region',{name:`Attached diff ${path}`,exact:true}).waitFor();
 console.log('Review context expands unchanged pinned lines in batches, preserves gutters and quotes, stops before hunks/EOF, and retries without changing the diff.');
}finally{await browser.close();}
