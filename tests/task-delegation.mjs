import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';

const coordinator={id:`agent_${'c'.repeat(32)}`,name:'Current project',status:'complete',backend:'codex',model:'fixture',updatedAt:Date.now()/1000};
const workers=['Storage investigation','Network validation'].map((name,index)=>({...coordinator,id:`agent_${String(index+1).repeat(32)}`,name}));
const tasks=workers.map((worker,index)=>({id:`task_${String(index+1).repeat(32)}`,text:worker.name,status:index?'incomplete':'done',agentId:worker.id,blockedByTaskId:'',parentTaskId:'',images:[],createdAt:index,updatedAt:index,position:index}));
// Saved daemon notices must remain readable after a reload, with their IDs intact in metadata.
const timeline=tasks.map((task,index)=>({id:index+1,agentId:coordinator.id,kind:'notice',text:`Delegated ${task.id} to ${workers[index].id}`,detail:workers[index].id,at:Date.now()/1000}));
timeline.push({id:3,agentId:coordinator.id,kind:'said',text:`Diagnostic identifier: ${workers[0].id}`,detail:'',at:Date.now()/1000});
timeline.push({id:4,agentId:coordinator.id,kind:'notice',text:'Other diagnostic information',detail:workers[1].id,at:Date.now()/1000});
const manual={...coordinator,id:`agent_${'f'.repeat(32)}`,name:'Standalone fork'};
const fork=(id,worker)=>({id,agentId:coordinator.id,kind:'forked',text:'Session forked',detail:worker,at:Date.now()/1000});
timeline.unshift(fork(10,workers[0].id));
timeline.splice(2,0,fork(11,workers[1].id));
timeline.push(fork(12,manual.id));
const browser=await (process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),writes=[],errors=[];
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.route('**/api/state',r=>r.fulfill({json:{mode:'ask',agents:[coordinator,...workers,manual],archived:[],messages:{},tasks,taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]}}));
 await page.route('**/api/events',r=>r.fulfill({contentType:'text/event-stream',body:': fixture\n\n'}));
 await page.route('**/api/client-failures',r=>r.fulfill({json:{}}));
 await page.route('**/api/focus',r=>r.fulfill({json:{suggestions:[],feedback:{}}}));
 await page.route('**/api/terminals',r=>r.fulfill({json:[]}));
 await page.route('**/api/agents/*',r=>{const id=new URL(r.request().url()).pathname.split('/').at(-1);return r.fulfill({json:{agent:[coordinator,...workers,manual].find(agent=>agent.id===id),timeline:id===coordinator.id?timeline:[],delivery:'start'}});});
 let fail=false;
 await page.route('**/api/tasks/*',async r=>{
  writes.push(r.request().postDataJSON());
  if(fail)return r.fulfill({status:500,json:{error:'Approval could not be saved'}});
  const index=tasks.findIndex(task=>new URL(r.request().url()).pathname.endsWith(task.id));
  const body=r.request().postDataJSON();assert.equal(body.status,'complete');assert.equal(body.approved,true);
  tasks[index]={...tasks[index],...body};await r.fulfill({json:tasks[index]});
 });
 const root=`${process.env.TEST_URL}/?agent=${coordinator.id}`;
 await page.goto(root);
 await page.locator('[data-entry="1"]').waitFor();
 assert.equal(await page.locator('[data-entry="10"],[data-entry="11"]').count(),0,'Delegation forks do not occupy separate rows');
 await page.locator('[data-entry="12"]').getByRole('button',{name:'open child session',exact:true}).click();
 await page.locator(`[data-agent-pane="${manual.id}"]`).waitFor();
 await page.goto(root+'&entry=10');
 await page.waitForFunction(()=>!new URL(location.href).searchParams.has('entry'));
 await page.locator('[data-entry="1"]').waitFor();
 assert.equal(new URL(page.url()).searchParams.get('agent'),coordinator.id,'Fork links reveal their delegation without changing conversations');
 for(let index=0;index<workers.length;index++){
  const notice=page.locator(`[data-entry="${index+1}"]`);
  await notice.getByRole('button',{name:`Task ${tasks[index].text}`,exact:true}).waitFor();
  assert.ok(!(await notice.innerText()).includes(workers[index].id),'A delegation does not print its worker identifier or repeat it below');
  await notice.getByRole('button',{name:`Task ${tasks[index].text}`,exact:true}).click();
  await page.locator('[data-task-row][aria-current="true"]').filter({hasText:tasks[index].text}).waitFor();
  await notice.getByRole('button',{name:'Open delegated conversation',exact:true}).click();
  await page.locator(`[data-agent-pane="${workers[index].id}"]`).waitFor();
  await page.goto(root);
 }
 assert.ok((await page.locator('[data-entry="3"]').innerText()).includes(workers[0].id),'Ordinary model output is preserved');
 assert.ok((await page.locator('[data-entry="4"]').innerText()).includes(workers[1].id),'Unrelated metadata is preserved');
 assert.deepEqual(writes,[],'Viewing a task or worker does not approve or mutate it');
 const notice=page.locator('[data-entry="1"]');
 await notice.getByRole('button',{name:'Not yet',exact:true}).waitFor();
 if(process.env.SCREENSHOT)await notice.screenshot({path:process.env.SCREENSHOT});
 const failureReported=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/client-failures');
 fail=true;await notice.getByRole('button',{name:'Approve',exact:true}).click();
 await page.getByText('Approval could not be saved',{exact:true}).waitFor();
 await failureReported;
 await notice.getByRole('button',{name:'Approve',exact:true}).waitFor();
 fail=false;await notice.getByRole('button',{name:'Approve',exact:true}).click();
 await notice.getByText('Approved',{exact:true}).waitFor();
 assert.equal(writes.length,2,'Approval keeps its existing explicit failure and retry behavior');
 await page.waitForLoadState('networkidle');
 await page.reload();await notice.getByText('Approved',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('Delegation notices omit redundant fork rows and duplicate worker IDs while task navigation, worker navigation, approvals, retries and unrelated content remain available.');
}finally{await browser.close();}
