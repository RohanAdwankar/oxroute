import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
const agent={id:'settings-session',name:'Current work',backend:'codex',model:'fixture',status:'complete',updatedAt:1};
const task={id:'review-task',agentId:agent.id,text:'Review the completed work',status:'done',images:[],parentTaskId:'',blockedByTaskId:'',createdAt:1,updatedAt:1,position:0};
const state={mode:'ask',nextActionMode:'ask',nextActionSuggestions:true,agents:[agent],archived:[],messages:{},tasks:[task],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]};
let release,arrived,writes=0,fail=false;
const waiting=new Promise(done=>arrived=done),held=new Promise(done=>release=done);
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path==='/api/version')return r.continue();
  if(path==='/api/state')return r.fulfill({json:state});
  if(path==='/api/terminals')return r.fulfill({json:[]});
  if(path===`/api/agents/${agent.id}`)return r.fulfill({json:{agent,timeline:[],delivery:'start'}});
  if(path==='/api/mode'){
   writes++;arrived();await held;
   if(fail)return r.fulfill({status:503,json:{error:'Setting could not be updated'}});
   state.mode=r.request().postDataJSON().mode;return r.fulfill({json:state});
  }
  return r.fulfill({json:{}});
 });
 await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);
 await page.getByRole('button',{name:'Show or hide tasks',exact:true}).click();
 await page.getByRole('button',{name:'Route inputs automatically',exact:true}).click();await waiting;
 const correction=page.getByRole('button',{name:'Not yet',exact:true});
 assert.equal(await correction.isEnabled(),true,'A pending settings request must not freeze unrelated task actions');
 await correction.click();await page.locator('[data-composer]').fill('Keep this correction draft');
 assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isEnabled(),true);
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 release();
 await page.waitForFunction(()=>document.querySelector('[aria-label="Route inputs automatically"]')?.getAttribute('aria-pressed')==='true');
 const count=writes;await page.getByRole('button',{name:'Route inputs automatically',exact:true}).click();
 await page.waitForTimeout(100);assert.equal(writes,count,'Selecting the current routing mode does no work');
 fail=true;await page.getByRole('button',{name:'Ask me before routing inputs',exact:true}).click();
 await page.getByText('Setting could not be updated',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-composer]').inputValue(),'Keep this correction draft');
 assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isEnabled(),true);
 console.log('Pending and failed settings writes preserve independent task actions, correction drafts and send controls; selecting the current mode is a no-op.');
}finally{release();for(const c of browser.contexts())for(const p of c.pages())await p.unrouteAll({behavior:'ignoreErrors'});await browser.close();}
