// Run against an explicitly selected, disposable native daemon and production frontend.
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {chromium,webkit} from 'playwright';
const native=process.env.TEST_NATIVE_URL;
assert.ok(native, 'TEST_NATIVE_URL must explicitly select a disposable daemon');
const web=process.env.TEST_URL;
assert.ok(web, 'TEST_URL must select the frontend');
const call=async(path,body,method='POST')=>{
 const response=await fetch(native+path,body?{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
 assert.ok(response.ok,await response.clone().text());return response.json();
};
const run=randomUUID().slice(0,8);
const make=async(text,parentTaskId='',status='done',blockedByTaskId='')=>{
 const task=await call('/api/tasks',{text:`${text} ${run}`,agentId:'',parentTaskId});
 return call(`/api/tasks/${task.id}`,{...task,status,blockedByTaskId,note:'Prepare disposable runtime validation',approved:status==='complete'},'PUT');
};
const normal=await make('Ordinary approval'),normalChild=await make('Ordinary child',normal.id);
const root=await make('Review bundle'),child=await make('Review evidence',root.id);
const nested=await make('Nested decision',child.id,'waiting_for_human');
const open=await make('Remaining work',root.id,'incomplete');
const blocked=await make('Blocked work',root.id,'blocked',normalChild.id);
const signed=await make('Previously approved',root.id,'complete');
const unrelated=await make('Unrelated task');
const family=[root,child,nested,open,blocked,signed];
let fail=true,attempts=0;
const proxy=createServer((req,res)=>{
 if(req.url===`/api/tasks/${root.id}/approve-all`){
  attempts++;
  if(fail){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Temporary approval failure'}));return;}
 }
 const upstream=request((req.url.startsWith('/api/')&&req.url!=='/api/version'?native:web)+req.url,{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res)});
 upstream.on('error',()=>res.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const browser=await(process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch(process.env.WEBKIT_EXECUTABLE?{executablePath:process.env.WEBKIT_EXECUTABLE}:{});
try{
 const page=await browser.newPage({viewport:{width:1180,height:850}});
 await page.addInitScript(()=>{localStorage.setItem('oxroute.tasks','true');localStorage.setItem('oxroute.taskWidth','590')});
 await page.goto(`http://127.0.0.1:${proxy.address().port}`);
 const row=text=>page.locator('[data-task-row]').filter({has:page.locator('[data-task-open]',{hasText:text})});
 await Promise.all([page.waitForResponse(response=>response.url().endsWith(`/api/tasks/${normal.id}`)&&response.request().method()==='PUT'),row(normal.text).getByRole('button',{name:'Approve',exact:true}).click()]);
 let state=await call('/api/state');
 assert.equal(state.tasks.find(t=>t.id===normal.id).status,'complete');
 assert.equal(state.tasks.find(t=>t.id===normalChild.id).status,'done','A normal click approves just one task');
 const search=page.getByRole('searchbox',{name:'Search tasks'});
 await search.fill(root.text);
 const approve=()=>row(root.text).getByRole('button',{name:'Approve',exact:true});
 await approve().click({button:'right'});
 const menu=page.getByRole('menu',{name:'Task approval'});
 await menu.waitFor();
 assert.equal(await page.getByRole('dialog',{name:'Task options'}).count(),0,'The row context menu must not open underneath');
 await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
 assert.equal(attempts,0);
 await approve().click({button:'right'});
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await page.getByRole('menuitem',{name:'Approve all subtasks',exact:true}).click();
 await page.getByText('Temporary approval failure',{exact:false}).first().waitFor();
 await approve().waitFor();
 state=await call('/api/state');
 assert.ok(family.every(task=>state.tasks.find(t=>t.id===task.id).status===task.status),'Failure preserves every original status');
 fail=false;
 await approve().click({button:'right'});
 await page.getByRole('menuitem',{name:'Approve all subtasks',exact:true}).click();
 await menu.waitFor({state:'hidden'});
 const deadline=Date.now()+5000;
 do{state=await call('/api/state');if(family.every(task=>state.tasks.find(t=>t.id===task.id).status==='complete'))break;await page.waitForTimeout(25)}while(Date.now()<deadline);
 assert.ok(family.every(task=>state.tasks.find(t=>t.id===task.id).status==='complete'),'Approve all includes hidden and nested children of every status');
 assert.equal(state.tasks.find(t=>t.id===unrelated.id).status,'done');
 assert.equal(state.tasks.find(t=>t.id===normalChild.id).status,'done');
 assert.ok(family.filter(task=>task.status!=='complete').every(task=>state.taskNotes.some(note=>note.taskId===task.id&&note.text.includes(root.id))));
 assert.equal(attempts,2,'Each bulk action makes one request for the full subtree');
 console.log(JSON.stringify({browser:process.env.TEST_BROWSER??'chromium',normalApprovalIndependent:true,escapeDismissed:true,failureRolledBack:true,hiddenNestedTasksApproved:family.length,unrelatedPreserved:true,bulkRequests:attempts}));
}finally{await browser.close();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve))}
