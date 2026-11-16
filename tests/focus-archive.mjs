import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const agents=['Finished discussion','Pending approval'].map((name,index)=>({id:`archive-${index}`,name,backend:'codex',model:'fixture',status:'complete',updatedAt:Date.now()/1000-index}));
const task={id:'awaiting-review',text:'Review the prepared change',agentId:agents[1].id,status:'done',parentTaskId:'',blockedByTaskId:'',images:[],createdAt:1,updatedAt:1};
const state={mode:'ask',nextActionSuggestions:true,agents:[...agents],archived:[],messages:{},tasks:[task],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],sources:[],models:[],backends:[]};
const browser=await(process.env.BROWSER==='webkit'?webkit:chromium).launch(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1280,height:960}}),writes=[],errors=[];let fail=false;
 page.on('pageerror',error=>errors.push(String(error)));
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.route('**/api/**',route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/version')return route.continue();
  if(path==='/api/state')return route.fulfill({json:state});
  if(path==='/api/terminals')return route.fulfill({json:[]});
  if(path==='/api/focus')return route.fulfill({json:{suggestions:state.agents.map(agent=>({agent,nextActions:{entryId:1,actions:[{label:'Continue investigation',message:'Investigate the remaining options'},{label:'Explain result',message:'Explain the current result'}]}})),feedback:{}}});
  if(path==='/api/client-failures')return route.fulfill({json:{}});
  if(path==='/api/archive'){
   const body=request.postDataJSON();writes.push(body);
   if(fail)return route.fulfill({status:503,json:{error:'Archive temporarily unavailable'}});
   const agent=state.agents.find(agent=>agent.id===body.agent);state.agents=state.agents.filter(agent=>agent.id!==body.agent);state.archived.push(agent);
   if(body.completeTasks)for(const task of state.tasks)if(task.agentId===body.agent)task.status='complete';
   return route.fulfill({json:state});
  }
  assert.equal(request.method(),'GET',`Unexpected mutation ${path}`);
  return route.fulfill({json:[]});
 });
 await page.goto(`${process.env.TEST_URL}/?view=focus`);
 const card=id=>page.locator(`[data-focus-suggestions="${id}"]`),archive=index=>page.getByRole('button',{name:`Archive ${agents[index].name}`,exact:true});
 await archive(0).waitFor();
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await archive(0).click();await card(agents[0].id).waitFor({state:'detached'});
 assert.equal(await page.getByRole('dialog').count(),0,'No-task conversations archive directly');
 assert.deepEqual(writes,[{agent:agents[0].id,archived:true,completeTasks:false}]);
 assert.equal(new URL(page.url()).searchParams.get('view'),'focus');
 await card(agents[1].id).getByRole('button',{name:`Archive ${agents[1].name}`,exact:true}).click();
 const dialog=page.getByRole('dialog',{name:`Archive ${agents[1].name}?`,exact:true});
 await dialog.getByText(task.text,{exact:true}).waitFor();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(writes.length,1,'Cancel does not archive or complete tasks');
 await card(agents[1].id).getByRole('button',{name:`Archive ${agents[1].name}`,exact:true}).click();
 fail=true;await dialog.getByRole('button',{name:'Archive without changing tasks',exact:true}).click();
 await dialog.getByRole('alert').getByText('Archive temporarily unavailable',{exact:true}).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('view'),'focus','Failure preserves the queue');
 assert.equal(task.status,'done');
 fail=false;await dialog.getByRole('button',{name:'Archive without changing tasks',exact:true}).click();
 await card(agents[1].id).waitFor({state:'detached'});await dialog.waitFor({state:'detached'});
 assert.equal(task.status,'done','Archiving preserves pending approval');
 const taskCard=page.locator(`[data-focus-task="${task.id}"]`);
 await taskCard.getByRole('button',{name:'Approve',exact:true}).waitFor();
 assert.equal(await taskCard.getByRole('button',{name:`Archive ${agents[1].name}`,exact:true}).count(),0);
 state.agents=[agents[1]];state.archived=[agents[0]];
 await page.reload();await taskCard.getByRole('button',{name:`Archive ${agents[1].name}`,exact:true}).click();
 await dialog.getByRole('button',{name:'Mark all complete and archive',exact:true}).click();
 await taskCard.waitFor({state:'detached'});assert.equal(task.status,'complete');assert.equal(writes.at(-1).completeTasks,true);
 assert.equal(new URL(page.url()).searchParams.get('view'),'focus');
 assert.deepEqual(errors,[]);
 console.log('Focus archives without sending suggestions; unfinished-task choices, cancel, failure recovery, explicit completion and queue location are preserved.');
}finally{await browser.close();}
