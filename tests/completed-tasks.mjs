import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const agent={id:'active-owner',name:'Active work',backend:'codex',model:'fixture',status:'complete',updatedAt:1};
const make=(id,text,status,parentTaskId='')=>({id,text,status,parentTaskId,agentId:agent.id,blockedByTaskId:'',images:[],createdAt:1,updatedAt:1,position:0});
const tasks=[make('root','Review current work','done'),make('middle','Historical parent','complete','root'),make('child','Continue validation','incomplete','middle'),make('settled','Historical child','complete','root'),make('finished-root','Historical root','complete'),make('orphan','Continue rollout','blocked','finished-root'),make('decision','Choose access','waiting_for_human')];
const state={mode:'ask',nextActionSuggestions:false,agents:[agent],archived:[],messages:{},tasks,taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]};
const timeline=[{id:1,agentId:agent.id,kind:'said',text:tasks.map(task=>`[${task.text}](#task/${task.id})`).join('\n\n'),detail:'',output:'',at:1}];
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),writes=[],errors=[];let fail=true;
 page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>{localStorage.setItem('oxroute.tasks','true');sessionStorage.setItem('oxroute.windowTasks','false');localStorage.setItem('oxroute.taskReply.settled','Preserved historical draft');window.SharedWorker=undefined;window.EventSource=class extends EventTarget{constructor(){super();window.stream=this;}close(){}};});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/version')return route.continue();
  if(path==='/api/state')return route.fulfill({json:state});
  if(path===`/api/agents/${agent.id}`)return route.fulfill({json:{agent,timeline,delivery:'start'}});
  if(path==='/api/tasks/root'){
   const body=route.request().postDataJSON();writes.push(body);assert.equal(body.status,'complete');assert.equal(body.approved,true);
   if(fail)return route.fulfill({status:503,json:{error:'Approval temporarily unavailable'}});
   Object.assign(tasks[0],body);return route.fulfill({json:tasks[0]});
  }
  return route.fulfill({json:path==='/api/focus'?{suggestions:[],feedback:{}}:[]});
 });
 const base=process.env.TEST_URL;await page.goto(`${base}/?agent=${agent.id}`);
 const panel=page.getByRole('complementary',{name:'Tasks',exact:true});
 const row=id=>panel.locator('[data-task-row]').filter({has:page.locator('[data-task-open]',{hasText:tasks.find(task=>task.id===id).text})});
 const visible=()=>panel.locator('[data-task-open]').allTextContents();
 await row('child').waitFor();assert.deepEqual(await visible(),['Review current work','Continue validation','Continue rollout','Choose access']);
 assert.equal(await panel.getByRole('button',{name:/Done ·/}).count(),0,'No completed-history band remains');
 const depth=id=>row(id).evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft));
 assert.ok(await depth('child')>await depth('root'),'Hidden ancestors do not detach work from its visible ancestor');
 for(const task of tasks.filter(task=>task.status==='complete'))assert.equal(await page.locator(`[data-task-reference="${task.id}"]`).count(),0);
 const search=panel.getByRole('searchbox',{name:'Search tasks'});await search.fill('Historical');assert.deepEqual(await visible(),[]);await search.fill('');
 await row('root').getByRole('button',{name:'Approve',exact:true}).click();
 await page.getByText('Approval temporarily unavailable',{exact:true}).waitFor();await row('root').getByRole('button',{name:'Approve',exact:true}).waitFor();
 fail=false;await row('root').getByRole('button',{name:'Approve',exact:true}).click();await row('root').waitFor({state:'detached'});
 assert.equal(await page.locator('[data-task-reference="root"]').count(),0);assert.equal(tasks.length,7,'Completion hides records without deleting them');assert.equal(tasks[2].status,'incomplete');assert.equal(tasks[2].parentTaskId,'middle');
 assert.equal(await depth('child'),await depth('orphan'),'Unfinished descendants become roots when every ancestor is hidden');
 await page.waitForLoadState('networkidle');await page.reload();await row('child').waitFor();assert.equal(await row('root').count(),0,'Completed work stays hidden after reload');
 tasks[0].status='incomplete';await page.evaluate(()=>window.stream.onmessage({data:JSON.stringify({type:'sync'})}));await row('root').waitFor();assert.ok(await depth('child')>await depth('root'),'Reopened work returns with its hierarchy');
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await page.waitForLoadState('networkidle');await page.goto(base);await page.locator('[data-home-card]').waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Reply about Historical child',exact:true}).count(),0,'A saved draft cannot resurface completed work');
 assert.equal(await page.evaluate(()=>localStorage.getItem('oxroute.taskReply.settled')),'Preserved historical draft','Hidden task drafts are retained');
 assert.equal(writes.length,2);assert.deepEqual(errors,[]);
 console.log('Completed tasks disappear from sidebar, search, inline cards and Home drafts; approvals recover on failure, records persist and unfinished descendants/reopened work remain navigable.');
}finally{await browser.close();}
