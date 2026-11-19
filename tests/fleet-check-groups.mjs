import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const agent={id:'focus-fixture',name:'Focus',backend:'codex',model:'fixture',status:'complete',updatedAt:1};
let serial=0;
const entry=(kind,text)=>({id:++serial,agentId:agent.id,kind,text,at:serial*1200,detail:'',output:'',origin:''});
const checks=count=>Array.from({length:count},()=>entry('notice','Focus checked the fleet'));
const entries=[...checks(5),entry('commentary','Inspecting retained source state.'),entry('commentary','Cross-checking recorded evidence.'),entry('worked','Context compaction'),...checks(4),entry('worked','Read workspace'),entry('worked','Context compaction'),...checks(3),entry('said','A decision needs your attention.'),...checks(3),entry('notice','Another notice'),entry('notice','Another notice'),...checks(1)];
const deferred=entries.find(entry=>entry.text==='Read workspace');deferred.outputDeferred=true;let outputReads=0;
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{constructor(){super();window.stream=this;}close(){}};});
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/version')return route.continue();
  if(path==='/api/state')return route.fulfill({json:{mode:'ask',nextActionSuggestions:false,agents:[agent],archived:[],messages:{},tasks:[],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]}});
  if(path===`/api/agents/${agent.id}/outputs`){outputReads++;return route.fulfill({json:{[deferred.id]:'Workspace inspected'}});}
  if(path===`/api/agents/${agent.id}`)return route.fulfill({json:{agent,timeline:entries,delivery:'start'}});
  return route.fulfill({json:[]});
 });
 await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);
 const groups=page.locator('[data-fleet-checks]');await groups.first().waitFor();
 assert.equal(await groups.count(),2);assert.equal(await groups.locator('[open]').count(),0);
 assert.equal(await groups.first().getAttribute('open'),null);
 await page.getByText('A decision needs your attention.',{exact:true}).waitFor();
 assert.equal(await page.getByText('Another notice',{exact:true}).count(),2);
 assert.equal(await page.getByText('Focus checked the fleet',{exact:true}).filter({visible:true}).count(),1);
 assert.equal(await page.getByText('Inspecting retained source state.',{exact:true}).isVisible(),false);
 assert.equal(outputReads,0,'Collapsed activity does not load outputs');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT.replace('.png','-collapsed.png')});
 await groups.first().locator('summary').focus();await page.keyboard.press('Enter');
 await groups.first().locator('[data-entry="1"]').waitFor({state:'visible'});
 assert.equal(await groups.first().locator('[data-entry]').count(),17);
 await groups.first().getByText('Inspecting retained source state.',{exact:true}).waitFor();
 await groups.first().getByText('Cross-checking recorded evidence.',{exact:true}).waitFor();
 assert.equal(await groups.first().locator('details').count(),0,'Background activity has one toggle');
 await groups.first().getByText('Read workspace',{exact:true}).first().waitFor();
 assert.equal(await groups.first().getByText('Context compaction',{exact:true}).count(),4);
 assert.match(await groups.first().locator('summary').innerText(),/12 fleet checks · 5 activity items/);
 await groups.first().getByText('Workspace inspected',{exact:true}).waitFor();
 assert.equal(outputReads,1);
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT.replace('.png','-expanded.png')});
 await groups.first().locator('summary').click();
 const next=entry('notice','Focus checked the fleet');entries.push(next);
 await page.evaluate(entry=>window.stream.onmessage({data:JSON.stringify({type:'timeline',entry})}),next);
 await groups.nth(2).locator('summary').waitFor();
 assert.equal(await groups.count(),3);assert.equal(await groups.first().getAttribute('open'),null);
 const compact=entry('worked','Context compaction');entries.push(compact);
 await page.evaluate(entry=>window.stream.onmessage({data:JSON.stringify({type:'timeline',entry})}),compact);
 await groups.nth(2).locator('summary').filter({hasText:'1 activity item'}).waitFor();
 assert.equal(await groups.count(),3);
 for(const next of [entry('you','Explain the current result.'),entry('commentary','Inspecting retained source state.')]) {
  entries.push(next);await page.evaluate(entry=>window.stream.onmessage({data:JSON.stringify({type:'timeline',entry})}),next);
 }
 await groups.nth(3).locator('summary').filter({hasText:'Fleet activity'}).waitFor();
 await page.getByText('Explain the current result.',{exact:true}).waitFor();
 assert.equal(await groups.count(),4,'Typed historical commentary folds even without a retained check marker');
 await page.evaluate(()=>{history.pushState(null,'','?agent=focus-fixture&entry=8');dispatchEvent(new PopStateEvent('popstate'));});
 await page.locator('[data-entry="8"]').waitFor({state:'visible'});assert.notEqual(await groups.first().getAttribute('open'),null);
 await groups.first().locator('summary').click();
 await page.locator('[data-composer]').first().click();
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 assert.deepEqual(errors,[]);console.log('Checks and interchangeable activity share one toggle, preserve original order and unrelated messages, append safely, toggle by keyboard and reveal deep-linked entries.');
}finally{await browser.close();}
