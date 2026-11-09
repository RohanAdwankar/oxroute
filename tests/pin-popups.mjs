import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const agent={id:'popup-session',name:'Popup session',backend:'codex',model:'fixture',status:'working',updatedAt:Date.now()/1000};
const state={mode:'ask',agents:[agent],archived:[],tasks:[],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],messages:{},sources:[],models:[],backends:[]};
const browser=await chromium.launch();
try {
 const context=await browser.newContext({viewport:{width:1100,height:800}}),writes=[],errors=[];
 await context.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await context.route('**/api/state',r=>r.fulfill({json:state}));
 await context.route('**/api/terminals',r=>r.fulfill({json:[]}));
 await context.route('**/api/agents/*',r=>r.fulfill({json:{agent,timeline:[],delivery:'start'}}));
 context.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});
 context.on('page',page=>page.on('pageerror',error=>errors.push(String(error))));
 const page=await context.newPage(),url=`${process.env.TEST_URL??'http://127.0.0.1:14019'}/?agent=${agent.id}`;
 const pins=page=>page.locator('[data-pinned-message]');
 const draft=page=>page.locator('[data-composer]');
 const pin=async(page,text)=>{await draft(page).fill(text);await draft(page).press('Enter');await pins(page).getByText(text,{exact:true}).waitFor();await page.getByLabel('Saving pinned messages',{exact:true}).waitFor({state:'detached'});};
 const scope=page=>page.evaluate(()=>sessionStorage.getItem('oxroute.pinWindow'));
 await page.goto(url);await pin(page,'Parent window follow-up');const parentScope=await scope(page);
 await page.getByRole('tab',{name:agent.name,exact:true}).click({button:'right'});
 const opening=page.waitForEvent('popup');await page.getByRole('menuitem',{name:'Move to new window',exact:true}).click();const child=await opening;
 await child.locator(`[data-agent-pane="${agent.id}"]`).waitFor();
 await child.waitForFunction(parent=>!!sessionStorage.getItem('oxroute.pinWindow')&&sessionStorage.getItem('oxroute.pinWindow')!==parent,parentScope);
 assert.notEqual(await scope(child),parentScope,'A real app popout rotates the sessionStorage namespace copied from its opener');
 assert.equal(await pins(child).count(),0,'Parent pins do not become child pins');
 await pin(child,'Child window follow-up');const childScope=await scope(child);
 await page.goto(url);await pins(page).getByText('Parent window follow-up',{exact:true}).waitFor();assert.equal(await pins(page).count(),1);
 await child.reload();await pins(child).getByText('Child window follow-up',{exact:true}).waitFor();assert.equal(await pins(child).count(),1);assert.equal(await scope(child),childScope,'A child reload retains its own persisted pins');
 await page.reload();await pins(page).getByText('Parent window follow-up',{exact:true}).waitFor();assert.equal(await scope(page),parentScope);assert.equal(await pins(page).count(),1);
 assert.deepEqual(writes,[],'Popout, pinning and reload never send an agent message');assert.deepEqual(errors,[]);
 await child.close();
 console.log('Actual Move to new window popouts isolate copied pin storage while parent and child retain their own pins through reload.');
} finally {await browser.close();}
