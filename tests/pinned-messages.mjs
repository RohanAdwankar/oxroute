import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { savedPins } from './pin-fixtures.mjs';

const agent={id:'send-session',name:'Current work',backend:'codex',model:'fixture',status:'working',updatedAt:Date.now()/1000};
const state={mode:'ask',agents:[agent],archived:[],tasks:[],taskNotes:[],inbox:[],paneLinks:{},tags:{},boards:[],messages:{},sources:[],models:[],backends:[]};
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}}),writes=[],errors=[];
 page.setDefaultTimeout(7000);
 let fail=false,timeline=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{close(){}};});
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/terminals',r=>r.fulfill({json:[]}));
 await page.route('**/api/agents/*',r=>r.fulfill({json:{agent,timeline,delivery:'start'}}));
 await page.route('**/api/say',r=>{writes.push(r.request().postDataJSON());return r.fulfill({status:fail?503:200,json:fail?{error:'Delivery unavailable'}:{}});});
 await page.route('**/api/say-attachments',async r=>{
  const data=await new Request(r.request().url(),{method:'POST',headers:r.request().headers(),body:r.request().postDataBuffer()}).formData();
  const files=await Promise.all(data.getAll('files').map(async f=>({name:f.name,type:f.type,text:await f.text()})));
  writes.push({...Object.fromEntries(data),files});return r.fulfill({json:{}});
 });
 await page.goto(`${process.env.TEST_URL}/?agent=${agent.id}`);
 const composer=page.locator('[data-composer]'),pins=page.locator('[data-pinned-message]');
 const deliver=async(text,action=()=>composer.press('Enter'))=>{await composer.fill(text);const response=page.waitForResponse(r=>r.url().endsWith('/api/say'));await action();await response;assert.equal(writes.at(-1).text,text);assert.equal(writes.at(-1).queued,false);assert.equal(await pins.count(),0);};
 await deliver('Change direction immediately');
 await deliver('Send button is immediate',()=>page.getByRole('button',{name:'Send message',exact:true}).click());
 if(process.env.SCREENSHOT)await page.screenshot({path:process.env.SCREENSHOT});
 await composer.fill('Two lines');const before=writes.length;await composer.press('Shift+Enter');assert.equal(writes.length,before);assert.match(await composer.inputValue(),/\n/);
 fail=true;await deliver('Retry this message');await page.getByRole('status').getByText('Delivery unavailable',{exact:true}).waitFor();assert.equal(await composer.inputValue(),'Retry this message');const retry=writes.at(-1).requestId;
 fail=false;await deliver('Retry this message');assert.equal(writes.at(-1).requestId,retry);
 await composer.fill('After current work');await page.getByRole('button',{name:'Send message options',exact:true}).click();await page.getByRole('menuitem',{name:'Queue after this turn',exact:true}).click();assert.equal(writes.at(-1).queued,true);
 await page.locator('input[type=file]').first().setInputFiles({name:'context.txt',mimeType:'text/plain',buffer:Buffer.from('Complete attachment contents')});
 await composer.fill('Read this file');let response=page.waitForResponse('**/api/say-attachments');await composer.press('Enter');await response;assert.equal(writes.at(-1).queued,'false');assert.equal(writes.at(-1).text,'Read this file');assert.equal(writes.at(-1).files[0].text,'Complete attachment contents');assert.equal(await pins.count(),0);
 const review={agentId:agent.id,id:'send-review',title:'Proposed settings',description:'',status:'pending',snapshot:{repository:'/fixture',branch:'proposal',baseRef:'main',remote:'origin',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),files:[{path:'settings.txt',patch:'diff --git a/settings.txt b/settings.txt\n--- a/settings.txt\n+++ b/settings.txt\n@@ -1 +1 @@\n-before\n+after\n'}]}};
 timeline=[{id:1,agentId:agent.id,at:1,kind:'review',text:review.title,detail:review.id}];
 await page.route('**/reviews/send-review',r=>r.fulfill({json:review}));await page.reload();
 await page.getByRole('button',{name:'Review Proposed settings',exact:true}).click();await page.getByRole('heading',{name:'settings.txt',exact:true}).click({button:'right'});await page.getByRole('button',{name:'Quote file into chat',exact:true}).click();
 await composer.fill('Use this quoted change');response=page.waitForResponse('**/api/say');await composer.press('Enter');await response;assert.equal(writes.at(-1).diffs[0].path,'settings.txt');assert.equal(writes.at(-1).queued,false);assert.equal(await pins.count(),0);
 await page.getByRole('button',{name:'Attach files options',exact:true}).click();await page.getByRole('menuitem',{name:'Draw',exact:true}).click();
 const canvas=page.getByLabel('sketch',{exact:true}),box=await canvas.boundingBox();await page.mouse.move(box.x+50,box.y+50);await page.mouse.down();await page.mouse.move(box.x+120,box.y+110,{steps:5});await page.mouse.up();
 await composer.fill('Use this drawing');response=page.waitForResponse('**/api/say-attachments');await page.getByRole('button',{name:'Send the picture',exact:true}).click();await response;assert.equal(writes.at(-1).files[0].type,'image/png');assert.equal(writes.at(-1).queued,'false');assert.equal(await pins.count(),0);
 await savedPins(page,agent.id,[{text:'Previously saved',files:[{name:'saved.txt',type:'text/plain',text:'Saved file bytes'}]},{text:'Discard this saved message'}]);
 await pins.first().waitFor();assert.equal(await pins.count(),2);await composer.fill('Keep composing');response=page.waitForResponse('**/api/say-attachments');await pins.first().getByRole('button',{name:'Send pinned message now'}).click();await response;assert.equal(writes.at(-1).files[0].text,'Saved file bytes');assert.equal(await composer.inputValue(),'Keep composing');await pins.filter({hasText:'Previously saved'}).waitFor({state:'detached'});
 await pins.getByRole('button',{name:'Discard pinned message'}).click();await pins.waitFor({state:'detached'});await page.getByLabel('Saving pinned messages',{exact:true}).waitFor({state:'detached'});await page.reload();assert.equal(await pins.count(),0);
 agent.status='complete';await page.reload();await deliver('Idle is still immediate');
 await page.setViewportSize({width:420,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 console.log('Enter and send buttons deliver working and idle messages immediately; explicit queueing, retries, files, quoted diffs, drawings and previously saved messages remain usable.');
} finally {await browser.close();}
