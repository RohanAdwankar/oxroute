// Exercise real daemon list/detail data without forwarding any browser writes.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {fixtureState} from './fixture-state.mjs';

export async function verifyPopulatedInbox(native,web,{allowEmpty=false,screenshots}={}) {
 const read=async path=>{const r=await fetch(native+path);assert.ok(r.ok,`${path}: ${r.status}`);return r.json();};
 const snapshot=await read('/api/state'),seen=new Set();
 const items=[...snapshot.inbox].sort((a,b)=>Number(b.state==='waiting')-Number(a.state==='waiting')).filter(item=>{
  const key=JSON.stringify([item.signal.source,item.signal.conversation,item.signal.source==='slack-inbox'?null:item.signal.threadKey]);
  if(!['slack-inbox','outlook-inbox'].includes(item.signal.source)||seen.has(key))return false;
  seen.add(key);return true;
 }).slice(0,2);
 if(items.length<2){assert.ok(allowEmpty,'Two populated source histories are required');console.log('Live source sample has fewer than two distinct retained source histories; populated source coverage is unavailable, separate real-daemon fixture checks remain required.');return;}
 const details=await Promise.all(items.map(item=>read(`/api/intake/${encodeURIComponent(item.signal.id)}`)));
 for(let n=0;n<items.length;n++){
  assert.equal(details[n].signal.id,items[n].signal.id);assert.equal(details[n].signal.at,items[n].signal.at);
  if(items[n].signal.source==='slack-inbox')assert.equal(items[n].display.text,'','List previews do not repeat full source histories');
 }
 const text=item=>item.display?.text||item.signal.text;
 assert.ok(details.every(item=>text(item).length>0),'Full source context stays accessible');
 const browser=await chromium.launch();let release,held=false,failed=false,contextReads=0,backgroundFailure=false,sourceRevision=0;
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.addInitScript(()=>{window.SharedWorker=undefined;window.EventSource=class extends EventTarget{constructor(){super();window.fixtureEvents=this;}close(){}};});
  const gate=new Promise(done=>release=done);
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url()),path=url.pathname;
   if(path==='/api/version')return route.continue();
   if(path==='/api/state')return route.fulfill({json:{...fixtureState(snapshot,[]),inbox:snapshot.inbox.map(item=>({...item,contextRevision:(item.contextRevision??0)+sourceRevision})),inboxWaiting:snapshot.inboxWaiting,inboxClearThrough:snapshot.inboxClearThrough}});
   const n=items.findIndex(item=>path===`/api/intake/${encodeURIComponent(item.signal.id)}`);
   if(n>=0){
    contextReads++;
    if(backgroundFailure){backgroundFailure=false;return route.fulfill({status:503,json:{error:"Context refresh interrupted"}});}
    if(n===0&&!held){held=true;await gate;}
    if(n===1&&!failed){failed=true;return route.fulfill({status:503,json:{error:'Source context temporarily unavailable'}});}
    return route.fulfill({json:details[n]});
   }
   if(path.startsWith('/api/routing-recommendations/'))return route.fulfill({json:null});
   return route.fulfill({json:[]});
  });
  await page.goto(web);
  const row=n=>page.locator('[data-inbox-item]').filter({has:page.locator(`time[datetime="${new Date((items[n].group?.latestAt??items[n].signal.at)*1000).toISOString()}"]`)}).first();
  const context=page.getByLabel('Conversation context',{exact:true});
  const content=async n=>{await context.waitFor();await page.waitForFunction(expected=>document.querySelector('[aria-label="Conversation context"]')?.textContent===expected,text(details[n]));};
  const choose=async n=>{
   if(!await row(n).isVisible())await page.getByRole('button',{name:'Show or hide the inbox',exact:true}).click();
   await row(n).click();
   assert.equal(await page.getByRole('button',{name:'Clear all inbox arrivals',exact:true}).isEnabled(),snapshot.inbox.some(item=>item.state==='waiting'),'Presentation clearing reflects pending scope without being invoked');
   if(await page.evaluate(()=>innerWidth<640))await page.getByRole('button',{name:'collapse inbox',exact:true}).click();
  };
  const inboxToggle=page.getByRole('button',{name:'Show or hide the inbox',exact:true});await inboxToggle.waitFor();
  if(await inboxToggle.getAttribute('aria-pressed')!=='true')await inboxToggle.click();
  if(items.some(item=>item.state!=='waiting'||['resolved','answered','no_response_needed'].includes(item.review?.state))){const handled=page.getByRole('button',{name:/^Handled ·/});await handled.waitFor();await handled.click();}
  await row(0).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Conversation context"]')?.textContent.includes('Loading conversation'));
  await row(1).click();await page.getByRole('button',{name:'Retry conversation context',exact:true}).click();await content(1);
  release();await page.waitForTimeout(100);await content(1);
  if(screenshots)await mkdir(screenshots,{recursive:true});
  const session=await page.context().newCDPSession(page);
  for(const width of [1280,390])for(const zoom of [.8,1,1.25]){
   await page.setViewportSize({width:Math.round(width/zoom),height:Math.round(900/zoom)});
   await session.send('Emulation.setDeviceMetricsOverride',{width:Math.round(width/zoom),height:Math.round(900/zoom),deviceScaleFactor:zoom,mobile:false});
   await choose(0);await content(0);await choose(1);await content(1);
   await page.keyboard.press('Escape');await choose(1);await content(1);
   await context.evaluate(node=>{node.scrollTop=Math.min(120,node.scrollHeight-node.clientHeight);window.contextScroll=node.scrollTop;window.loadingFlashes=0;window.contextObserver?.disconnect();window.contextObserver=new MutationObserver(()=>{if(node.textContent.includes('Loading conversation'))window.loadingFlashes++;});window.contextObserver.observe(node,{subtree:true,childList:true,characterData:true});});
   const readsBefore=contextReads;
   await page.evaluate(()=>window.fixtureEvents.onmessage({data:JSON.stringify({type:"sync"})}));await page.waitForTimeout(200);
   assert.equal(contextReads,readsBefore,"An unchanged background snapshot does not repeatedly transfer full source histories");
   for(let cycle=0;cycle<3;cycle++){sourceRevision++;await page.evaluate(()=>window.fixtureEvents.onmessage({data:JSON.stringify({type:'sync'})}));await page.waitForTimeout(200);await content(1);}
   assert.ok(contextReads>readsBefore,'Source refreshes continue while loaded context remains visible');
   assert.equal(await page.evaluate(()=>window.loadingFlashes),0,'Background snapshots retain loaded context without a loading flash');
   assert.ok(await context.evaluate(node=>Math.abs(node.scrollTop-window.contextScroll)<1),'Background refresh retains the reading position');
   sourceRevision++;backgroundFailure=true;await page.evaluate(()=>window.fixtureEvents.onmessage({data:JSON.stringify({type:'sync'})}));await page.getByRole('button',{name:'Retry conversation context',exact:true}).waitFor();assert.ok((await context.textContent()).startsWith(text(details[1])),'A background failure retains loaded source content');await page.getByRole('button',{name:'Retry conversation context',exact:true}).click();await content(1);
   if(items[1].sourceUrl)assert.equal(await page.getByRole('link',{name:'Open source message',exact:true}).getAttribute('href'),items[1].sourceUrl);
   const box=await context.boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
   assert.ok(box&&box.width>0&&box.height>0&&box.x>=0&&box.x+box.width<=viewport.width+.1,'Opened context fits the actual viewport');
   assert.ok(await context.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Source links and text wrap within the visible context pane');
   for(const control of await context.locator('..').locator('footer button,footer select').all()){
    const bounds=await control.boundingBox();assert.ok(bounds&&bounds.width>=16&&bounds.x>=0&&bounds.x+bounds.width<=viewport.width+.1,'Routing controls remain visible and usable in the actual viewport');
   }
   if(screenshots)await page.screenshot({path:`${screenshots}/populated-${width}-${zoom}.png`,clip:{x:0,y:0,...viewport},captureBeyondViewport:false});
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({populatedInboxItems:snapshot.inbox.length,sampledPendingItems:items.filter(item=>item.state==='waiting').length,sourceContextLengths:details.map(item=>text(item).length),openSwitchReturnRetry:true,lateResponsesIsolated:true,browserWritesForwarded:0,desktopNarrowZoom:true}));
 }finally{release?.();for(const context of browser.contexts())for(const page of context.pages())await page.unrouteAll({behavior:'wait'});await browser.close();}
}
