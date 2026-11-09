import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const agents=['alpha','bravo','charlie','delta'].map(id=>({id,name:`${id} session`,backend:'codex',model:'fixture',status:'complete',updatedAt:Date.now()/1000}));
const tasks=[
 ['alpha','Prepare alpha report','incomplete','alpha','', ''],
 ['bravo','Review bravo change','done','bravo','delta-root',''],
 ['bravo-next','Continue bravo rollout','blocked','bravo','','alpha'],
 ['charlie','Approve charlie result','complete','charlie','',''],
 ['delta-root','Plan delta rollout','incomplete','delta','',''],
 ['delta-access','Grant delta access','waiting_for_human','delta','',''],
 ['unassigned','Unassigned task','incomplete','','',''],
].map(([id,text,status,agentId,parentTaskId,blockedByTaskId])=>({id,text,status,agentId,parentTaskId,blockedByTaskId,images:[],createdAt:1,updatedAt:1}));
const browser=await chromium.launch();
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),writes=[],diagrams=[];
 await context.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};localStorage.setItem('oxroute.tasks','true');if(localStorage.getItem('oxroute.graph')===null)localStorage.setItem('oxroute.graph','on');});
 await context.route('**/api/state',r=>r.fulfill({json:{mode:'ask',agents,archived:[],tasks,taskNotes:[],messages:{},tags:{},paneLinks:{},inbox:[],boards:[],sources:[],models:[],backends:[]}}));
 await context.route('**/api/terminals',r=>r.fulfill({json:[]}));
 await context.route('**/api/agents/*',r=>{const id=new URL(r.request().url()).pathname.split('/').at(-1);return r.fulfill({json:{agent:agents.find(a=>a.id===id),timeline:[],delivery:'start'}});});
 await context.route('**/api/task-diagram.svg?*',r=>{diagrams.push(new URL(r.request().url()).searchParams.get('agents'));return r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'});});
 context.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});
 const page=await context.newPage();
 await page.addInitScript(()=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','true');sessionStorage.setItem('oxroute.sessionTabs',JSON.stringify(['alpha','charlie']));sessionStorage.setItem('oxroute.panes.alpha',JSON.stringify({axis:'row',ratio:0.5,first:'alpha',second:'bravo'}));}});
 await page.goto(`${process.env.TEST_URL??'http://127.0.0.1:13979'}/?agent=alpha`);
 const panel=page.getByRole('complementary',{name:'Tasks',exact:true}),filter=panel.getByRole('button',{name:'Only open conversations',exact:true});
 const shown=()=>panel.locator('[data-task-open]').allTextContents();
 await filter.waitFor();assert.equal(await filter.getAttribute('aria-pressed'),'false');
 assert.ok((await shown()).includes('Unassigned task'));
 await filter.click();
 assert.deepEqual(await shown(),['Prepare alpha report','Review bravo change','Continue bravo rollout']);
 await page.waitForFunction(()=>document.querySelector('[alt="Task dependency flowchart"]')?.getAttribute('src')?.includes('agents='));
 assert.deepEqual(JSON.parse(diagrams.at(-1)),['alpha','bravo','charlie']);
 assert.ok(!(await shown()).includes('Plan delta rollout'),'An unrelated parent is not pulled into this window');
 const search=panel.getByRole('searchbox',{name:'Search tasks'});
 await search.fill('charlie');assert.deepEqual(await shown(),['Approve charlie result'],'Search includes completed tasks within scope');
 await search.fill('delta');assert.deepEqual(await shown(),[]);
 await search.fill('');
 await page.getByRole('tab',{name:'charlie session',exact:true}).click();
 assert.deepEqual(await shown(),['Prepare alpha report','Review bravo change','Continue bravo rollout'],'Inactive conversation tabs retain their split panes in scope');
 await page.evaluate(()=>localStorage.setItem('oxroute.graph','off'));
 await page.reload();await filter.waitFor();assert.equal(await filter.getAttribute('aria-pressed'),'true');
 assert.deepEqual(await shown(),['Prepare alpha report','Review bravo change','Continue bravo rollout']);
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 const other=await context.newPage();await other.goto(`${process.env.TEST_URL??'http://127.0.0.1:13979'}/?agent=delta`);
 const otherPanel=other.getByRole('complementary',{name:'Tasks',exact:true}),otherFilter=otherPanel.getByRole('button',{name:'Only open conversations',exact:true});
 await otherFilter.waitFor();assert.equal(await otherFilter.getAttribute('aria-pressed'),'false','Window scope preference is independent');
 await otherFilter.click();assert.deepEqual(await otherPanel.locator('[data-task-open]').allTextContents(),['Plan delta rollout','Grant delta access']);
 assert.deepEqual(await shown(),['Prepare alpha report','Review bravo change','Continue bravo rollout'],'Another window does not alter membership');
 await page.getByRole('button',{name:'Close tab alpha session',exact:true}).click();
 assert.deepEqual(await shown(),[],'Closing a tab removes its split conversation tasks');
 await search.fill('alpha');assert.deepEqual(await shown(),[]);
 await filter.click();assert.deepEqual(await shown(),['Prepare alpha report'],'Switching back to all tasks retains search');
 await search.fill('');await filter.click();
 await page.getByRole('tab',{name:'Focus',exact:true}).click();
 await page.locator('[data-focus-task="delta-access"]').getByRole('button',{name:'Grant delta access',exact:true}).click();
 assert.equal(await filter.getAttribute('aria-pressed'),'false','An explicit task link reveals its task outside the current window scope');
 await filter.click();
 await page.getByRole('button',{name:'Close tab charlie session',exact:true}).click();
 await panel.getByText('No conversations open in this window.',{exact:true}).waitFor();
 await filter.click();assert.ok((await shown()).includes('Unassigned task'));
 assert.deepEqual(writes,[],'Filtering never mutates tasks or conversations');
 console.log('Window task filtering covers active/inactive tabs and split panes, search, scoped diagrams, reload persistence, independent windows, closures and explicit task links.');
}finally{await browser.close();}
