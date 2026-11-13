import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
const agent={id:'attention',name:'Network rollout',backend:'codex',model:'fixture',status:'complete',updatedAt:Date.now()/1000};
const actions=[{label:'Inspect evidence',message:'Inspect the verification evidence'},{label:'Compare options',message:'Compare available rollout options'},{label:'Explain impact',message:'Explain the rollout impact'}];
const state={mode:'ask',nextActionSuggestions:true,agents:[agent],archived:[],messages:{attention:'Validation passed. Choose a next step.'},tasks:Array.from({length:24},(_,i)=>({id:`review-${i}`,text:`Review configuration ${i}`,status:'done',agentId:agent.id,updatedAt:Date.now()/1000-60+i,createdAt:1,parentTaskId:'',blockedByTaskId:'',images:[]})),taskNotes:[],inbox:[],tags:{},paneLinks:{},boards:[],sources:[],models:[],backends:[]};
const data={suggestions:[{agent,nextActions:{entryId:1,recommendationId:42,actions}}],feedback:{'next-actions':{decisions:8,matched:6},'input-routing':{decisions:3,matched:2}}};
try{
 const page=await browser.newPage({viewport:{width:1280,height:960}}),writes=[],errors=[];let fail=true;
 page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>{localStorage.setItem('oxroute.nextActionLayout','stacked');window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.route('**/api/**',r=>{
  const path=new URL(r.request().url()).pathname;
  if(path==='/api/version')return r.continue();
  if(path==='/api/state')return r.fulfill({json:state});
  if(path==='/api/focus')return r.fulfill({json:data});
  if(path==='/api/client-failures')return r.fulfill({json:{}});
  if(path==='/api/terminals')return r.fulfill({json:[]});
  if(path==='/api/recommendations/42/shown')return r.fulfill({json:{}});
  if(path==='/api/say'){
   writes.push(r.request().postDataJSON());
   if(fail)return r.fulfill({status:503,json:{error:'Delivery unavailable'}});
   return r.fulfill({json:{}});
  }
  assert.equal(r.request().method(),'GET',`Unexpected mutation ${path}`);
  return r.fulfill({json:[]});
 });
 await page.goto(`${process.env.TEST_URL}/?view=focus`);
 const row=page.locator('[data-focus-suggestions="attention"]'),tasks=page.locator('[data-focus-task]');
 await row.waitFor();assert.ok((await row.getByRole('button',{name:'Inspect evidence',exact:true}).boundingBox()).height>=90);assert.equal(await tasks.count(),24);assert.equal(await page.locator('ol').first().locator(':scope > li').first().getAttribute('data-focus-suggestions'),'attention');
 await page.getByLabel('Recommendation feedback').getByText('Next actions: 6/8 choices matched · Routing: 2/3 choices matched',{exact:true}).waitFor();
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await row.getByRole('button',{name:'Inspect evidence',exact:true}).click();await row.getByRole('alert').waitFor();
 assert.equal(writes.length,1);fail=false;
 await row.getByRole('button',{name:'Inspect evidence',exact:true}).click();await row.getByText('Sent to conversation',{exact:true}).waitFor();
 assert.equal(writes.length,2);assert.equal(writes[0].requestId,writes[1].requestId);assert.equal(writes[1].agent,agent.id);assert.equal(writes[1].text,actions[0].message);
 assert.equal(state.tasks.every(task=>task.status==='done'),true);
 await page.getByRole('combobox',{name:'Sort attention queue'}).selectOption('oldest');assert.equal(await tasks.first().getAttribute('data-focus-task'),'review-0');
 await page.reload();await tasks.first().waitFor();assert.equal(await page.getByRole('combobox',{name:'Sort attention queue'}).inputValue(),'oldest');
 await page.getByRole('combobox',{name:'Sort attention queue'}).selectOption('recent');assert.equal(await tasks.first().getAttribute('data-focus-task'),'review-23');
 await page.setViewportSize({width:420,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);
 console.log('Full attention queue sorts persistently, includes manual next-action choices and recorded choice-match counts, retries delivery with one identity and preserves formal task approvals.');
}finally{await browser.close();}
